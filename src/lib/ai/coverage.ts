import { prisma } from '../prisma';
import { retrieveChunksForDocument, RetrievedChunk } from './retriever';
import { aiClient } from './client';
import { formatPageRanges } from '../utils/format';
export { formatPageRanges };

export interface CoverageReport {
  chunksExamined: number;
  chunksTotal: number;
  pagesExamined: number;
  pagesTotal: number;
  pagesExaminedList?: number[];
  strategy: 'targeted' | 'map-reduce' | 'agentic';
  coveragePercent: number;
  incomplete?: boolean;
  unreadPages?: number[];
  searchedPagesDesc?: string;
  unreadPagesDesc?: string;
}

export interface RetrievalResult {
  evidenceText: string;
  chunks: Array<{ id: string; text: string; pageStart: number; pageEnd: number }>;
  coverage: CoverageReport;
  emptyAndIncomplete?: boolean;
  incompleteMessage?: string;
  isExhaustiveAbsent?: boolean;
}

/**
 * Detects whether a question is asking for an exhaustive search, absence, existence, or all occurrences.
 * Matches: "does the contract contain…", "any", "list every", "is there", "all clauses that…"
 */
export function isExhaustiveQuestion(question: string): boolean {
  const q = question.toLowerCase();

  // Questions seeking specific terms ("what is", "when", "what does article") are targeted, not exhaustive
  if (/^(what\s+is|what\s+are|when\s+|how\s+|who\s+|whose\s+|what\s+does\s+(article|section|clause))\b/i.test(q)) {
    if (!/\b(all\s+clauses|every\s+clause|list\s+all|what\s+are\s+all)\b/i.test(q)) {
      return false;
    }
  }

  const patterns = [
    /\b(does|is|are)\s+(the|this|any)\s+(contract|agreement|document)?\s*contain\s+(a|any)\b/i,
    /\bdoes\s+it\s+contain\s+(a|any)\b/i,
    /\b(is\s+there\s+any|are\s+there\s+any)\b/i,
    /\b(list\s+all|find\s+all|extract\s+all|what\s+are\s+all|show\s+all|list\s+every)\b/i,
    /\b(absence\s+of|is\s+absent|not\s+present|contain\s+any|prohibit\s+any)\b/i,
    /\b(any\s+clause|every\s+clause|all\s+clauses\s+that)\b/i,
    /\bcontain\s+a\s+non-?compete\b/i,
    /\b(any\s+non-?compete)\b/i,
    /\b(any\s+penalty|any\s+restriction)\b/i,
  ];

  return patterns.some((p) => p.test(q));
}

/**
 * Detects whether a question is asking to compare multiple contracts/documents.
 * Matches: "two documents", "both documents", "both contracts", "compare", "differ", "differences"
 */
export function isComparativeQuestion(q: string): boolean {
  return /\b(two\s+documents|both\s+documents|both\s+contracts|compare|differ|difference|differences|between\s+the\s+two|across\s+both|in\s+both)\b/i.test(
    q
  );
}

/**
 * Detects whether an answer claims that a clause or term is absent or not found.
 */
export function isAbsenceClaim(text: string): boolean {
  const t = text.toLowerCase();
  const patterns = [
    /\bno\s+non-?compete\b/i,
    /\bnot\s+found\b/i,
    /\b(?:the\s+)?(?:contract|agreement|document)\s+does\s+not\s+contain\b/i,
    /\bdoes\s+not\s+(?:contain|have|include|mention)\b/i,
    /\bis\s+not\s+present\b/i,
    /\bthere\s+is\s+no\b/i,
    /\bthere\s+are\s+no\b/i,
    /\bno\s+mention\s+of\b/i,
    /\bcontains\s+no\b/i,
    /\b(?:could\s+not|cannot|can\s+not)\s+find\s+any\b/i,
    /\bnot\s+contained\s+in\s+the\s+contract\b/i,
    /\bno\s+such\s+clause\b/i,
  ];
  return patterns.some((p) => p.test(t));
}

/**
 * Enforces in code: Absence claims are allowed only when pagesExamined == pagesTotal.
 * Otherwise the server must replace:
 * "I looked at pages X, Y but did not read the whole document, so I can't confirm this clause is absent."
 */
export function enforceAbsenceCoverage(
  answer: string,
  pagesExaminedList: number[],
  pagesExamined: number,
  pagesTotal: number
): { modifiedText: string; isAbsence: boolean } {
  const isAbsence = isAbsenceClaim(answer);
  if (isAbsence && pagesExamined < pagesTotal) {
    let pagesStr = 'reviewed pages';
    if (pagesExaminedList && pagesExaminedList.length > 0) {
      pagesStr = pagesExaminedList.length === 1
        ? `page ${pagesExaminedList[0]}`
        : `pages ${formatPageRanges(pagesExaminedList)}`;
    }
    return {
      modifiedText: `I looked at ${pagesStr} but did not read the whole document, so I can't confirm this clause is absent.`,
      isAbsence: true,
    };
  }
  return { modifiedText: answer, isAbsence };
}

/**
 * Strategy A: Targeted Question Retrieval with Top-K scaling and neighbor chunks (±1).
 */
export async function executeTargetedRetrieval(
  documentId: string,
  question: string,
  totalPageCount: number
): Promise<RetrievalResult> {
  const allChunks = await prisma.documentChunk.findMany({
    where: { documentId },
    orderBy: { chunkIndex: 'asc' },
    select: {
      id: true,
      chunkIndex: true,
      text: true,
      pageStart: true,
      pageEnd: true,
      startOffset: true,
      endOffset: true,
      sectionNumber: true,
      sectionTitle: true,
    },
  });

  const totalChunks = allChunks.length;
  if (totalChunks === 0) {
    return {
      evidenceText: '',
      chunks: [],
      coverage: {
        chunksExamined: 0,
        chunksTotal: 0,
        pagesExamined: 0,
        pagesTotal: totalPageCount || 1,
        strategy: 'targeted',
        coveragePercent: 0,
      },
    };
  }

  // Top-K scales with doc size (min 8)
  const topK = Math.max(8, Math.min(25, Math.ceil(totalChunks * 0.12)));
  const primaryRetrieved = await retrieveChunksForDocument(documentId, question, topK);

  // Add neighbor chunks (±1)
  const chunkIndexMap = new Map<number, typeof allChunks[0]>();
  for (const c of allChunks) {
    chunkIndexMap.set(c.chunkIndex, c);
  }

  const selectedChunkIds = new Set<string>();
  const finalChunks: typeof allChunks = [];

  for (const p of primaryRetrieved) {
    const indicesToAdd = [p.chunkIndex - 1, p.chunkIndex, p.chunkIndex + 1];
    for (const idx of indicesToAdd) {
      const neighbor = chunkIndexMap.get(idx);
      if (neighbor && !selectedChunkIds.has(neighbor.id)) {
        selectedChunkIds.add(neighbor.id);
        finalChunks.push(neighbor);
      }
    }
  }

  // Sort by document chunkIndex order
  finalChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

  // Compute examined pages
  const examinedPages = new Set<number>();
  for (const c of finalChunks) {
    for (let p = c.pageStart; p <= c.pageEnd; p++) {
      examinedPages.add(p);
    }
  }

  const pagesTotal = Math.max(totalPageCount, 1);
  const pagesExamined = examinedPages.size;
  const coveragePercent = Math.min(100, Math.round((pagesExamined / pagesTotal) * 100));

  const evidenceText = finalChunks
    .map((c, i) => `[Evidence ${i + 1} - ChunkID: ${c.id} - Page ${c.pageStart}]\n${c.text}`)
    .join('\n\n');

  return {
    evidenceText,
    chunks: finalChunks.map((c) => ({
      id: c.id,
      text: c.text,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
    })),
    coverage: {
      chunksExamined: finalChunks.length,
      chunksTotal: totalChunks,
      pagesExamined,
      pagesTotal,
      pagesExaminedList: Array.from(examinedPages).sort((a, b) => a - b),
      strategy: 'targeted',
      coveragePercent,
      incomplete: pagesExamined < pagesTotal,
    },
  };
}

/**
 * Strategy B: Map-Reduce over all chunks in batches for existence/absence/all questions.
 * Enforces honesty: if coverage < 100% and nothing found, NEVER asserts absence.
 */
export async function executeMapReduceRetrieval(
  documentId: string,
  question: string,
  totalPageCount: number,
  options?: {
    onProgress?: (msg: string) => void;
    maxBatchesToProcess?: number; // Used for testing partial coverage scenarios
  }
): Promise<RetrievalResult> {
  const allChunks = await prisma.documentChunk.findMany({
    where: { documentId },
    orderBy: { chunkIndex: 'asc' },
    select: {
      id: true,
      chunkIndex: true,
      text: true,
      pageStart: true,
      pageEnd: true,
      startOffset: true,
      endOffset: true,
    },
  });

  const totalChunks = allChunks.length;
  const pagesTotal = Math.max(totalPageCount, 1);

  if (totalChunks === 0) {
    return {
      evidenceText: '',
      chunks: [],
      coverage: {
        chunksExamined: 0,
        chunksTotal: 0,
        pagesExamined: 0,
        pagesTotal,
        strategy: 'map-reduce',
        coveragePercent: 0,
      },
    };
  }

  // Create batches of ~12,000 characters
  const BATCH_CHAR_LIMIT = 12000;
  const batches: Array<typeof allChunks> = [];
  let currentBatch: typeof allChunks = [];
  let currentChars = 0;

  for (const chunk of allChunks) {
    if (currentChars + chunk.text.length > BATCH_CHAR_LIMIT && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [chunk];
      currentChars = chunk.text.length;
    } else {
      currentBatch.push(chunk);
      currentChars += chunk.text.length;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  const examinedPagesSet = new Set<number>();
  let examinedChunksCount = 0;
  const collectedPassages: Array<{ chunkId: string; page: number; text: string }> = [];

  const batchesToRun = options?.maxBatchesToProcess !== undefined
    ? batches.slice(0, options.maxBatchesToProcess)
    : batches;

  for (let bIdx = 0; bIdx < batchesToRun.length; bIdx++) {
    const batch = batchesToRun[bIdx];
    const bStartPage = Math.min(...batch.map((c) => c.pageStart));
    const bEndPage = Math.max(...batch.map((c) => c.pageEnd));

    options?.onProgress?.(`Reading section ${bIdx + 1} of ${batches.length} (pages ${bStartPage}–${bEndPage})...`);

    // Record examined pages and chunks
    for (const c of batch) {
      examinedChunksCount++;
      for (let p = c.pageStart; p <= c.pageEnd; p++) {
        examinedPagesSet.add(p);
      }
    }

    const batchText = batch.map((c) => `[Chunk ${c.id} - Page ${c.pageStart}]\n${c.text}`).join('\n\n');

    // Fast pre-filter: extract substantive search keywords from question (excluding common stopwords)
    const keywords = question
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 &&
          !['does', 'the', 'this', 'any', 'contract', 'agreement', 'contain', 'have', 'what', 'which', 'where', 'there', 'with', 'from', 'into', 'about', 'is', 'are', 'clause'].includes(w)
      );

    const lowerBatchText = batchText.toLowerCase();
    const hasKeywordMatch = keywords.length === 0 || keywords.some((kw) => lowerBatchText.includes(kw));

    if (!hasKeywordMatch) {
      // Fast path: No query terms present in this batch.
      // Pages are already recorded as examined in examinedPagesSet.
      continue;
    }

    // Prompt this batch to extract verbatim relevant passages or "NONE"
    try {
      const mapRes = await aiClient.createChatCompletion({
        messages: [
          {
            role: 'system',
            content:
              'You are a legal contract clause extractor. Given the following contract excerpt, extract any verbatim clauses or sentences that directly address the question. If there are NO relevant clauses or terms in this excerpt, respond with EXACTLY the word "NONE". Do not explain.',
          },
          {
            role: 'user',
            content: `QUESTION:\n${question}\n\nEXCERPT:\n${batchText}`,
          },
        ],
        temperature: 0,
      });

      const mapContent = mapRes.content?.trim() || 'NONE';
      if (mapContent && !/^none[.]?$/i.test(mapContent)) {
        collectedPassages.push({
          chunkId: batch[0].id,
          page: bStartPage,
          text: mapContent,
        });
      }
    } catch (err) {
      console.warn(`[Coverage Map] Error processing batch ${bIdx + 1}:`, err);
      // Batch failed; loop continues but unexamined pages will reflect incomplete coverage
    }
  }

  const pagesExamined = examinedPagesSet.size;
  const coveragePercent = Math.min(100, Math.round((pagesExamined / pagesTotal) * 100));

  const allPageNumbers = Array.from({ length: pagesTotal }, (_, i) => i + 1);
  const unreadPages = allPageNumbers.filter((p) => !examinedPagesSet.has(p));
  const searchedPages = allPageNumbers.filter((p) => examinedPagesSet.has(p));

  const searchedPagesDesc = formatPageRanges(searchedPages);
  const unreadPagesDesc = formatPageRanges(unreadPages);

  const coverage: CoverageReport = {
    chunksExamined: examinedChunksCount,
    chunksTotal: totalChunks,
    pagesExamined,
    pagesTotal,
    pagesExaminedList: Array.from(examinedPagesSet).sort((a, b) => a - b),
    strategy: 'map-reduce',
    coveragePercent,
    incomplete: coveragePercent < 100,
    unreadPages: unreadPages.length > 0 ? unreadPages : undefined,
    searchedPagesDesc,
    unreadPagesDesc,
  };

  // If nothing found and coverage < 100%, ENFORCE IN CODE that absence cannot be claimed
  if (collectedPassages.length === 0 && coveragePercent < 100) {
    const incompleteMsg = `I searched pages ${searchedPagesDesc} and found nothing, but pages ${unreadPagesDesc} were not read, so I cannot confirm the clause is absent.`;
    return {
      evidenceText: '',
      chunks: [],
      coverage,
      emptyAndIncomplete: true,
      incompleteMessage: incompleteMsg,
    };
  }

  // If 100% coverage and nothing found
  if (collectedPassages.length === 0 && coveragePercent >= 100) {
    return {
      evidenceText: '',
      chunks: [],
      coverage,
      isExhaustiveAbsent: true,
    };
  }

  const evidenceText = collectedPassages
    .map((p, i) => `[Candidate Passage ${i + 1} - Near Page ${p.page}]\n${p.text}`)
    .join('\n\n');

  return {
    evidenceText,
    chunks: collectedPassages.map((p) => ({
      id: p.chunkId,
      text: p.text,
      pageStart: p.page,
      pageEnd: p.page,
    })),
    coverage,
  };
}
