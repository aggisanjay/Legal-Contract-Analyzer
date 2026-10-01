import { prisma } from '../prisma';
import { cosineSimilarity, getEmbeddingProvider } from './embeddings';
import { DocumentChunkData } from '../types';

export interface RetrievedChunk extends DocumentChunkData {
  score: number;
}

export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'over', 'than', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were',
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'will', 'with', 'would', 'between',
  'differ', 'different', 'difference', 'differs', 'compare', 'compared', 'comparison', 'version',
  'versions', 'document', 'documents', 'contract', 'contracts', 'agreement', 'same', 'longer', 'shorter',
  'higher', 'lower', 'two', 'one',
]);

/**
 * Light stemming: strips ing, ed, es, s from tokens
 */
export function lightStem(word: string): string {
  const s = word.toLowerCase().trim();
  if (s.length <= 3) return s;
  if (s.endsWith('ing') && s.length > 5) {
    return s.slice(0, -3);
  }
  if (s.endsWith('ed') && s.length > 4) {
    return s.slice(0, -2);
  }
  if (s.endsWith('es') && s.length > 4) {
    return s.slice(0, -2);
  }
  if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) {
    return s.slice(0, -1);
  }
  return s;
}

export const LEGAL_SYNONYMS: Record<string, string[]> = {
  cap: ['exceed', 'aggregate', 'limit', 'limitation'],
  caps: ['exceed', 'aggregate', 'limit', 'limitation'],
  notice: ['terminate', 'termination', 'days', 'convenience'],
  notices: ['terminate', 'termination', 'days', 'convenience'],
  termination: ['terminate', 'convenience', 'notice', 'days'],
  terminate: ['termination', 'convenience', 'notice', 'days'],
  convenience: ['terminate', 'termination', 'notice'],
  law: ['governed', 'governing', 'laws', 'jurisdiction'],
  laws: ['governed', 'governing', 'law', 'jurisdiction'],
  governing: ['governed', 'laws', 'law', 'jurisdiction'],
  governed: ['governing', 'laws', 'law', 'jurisdiction'],
  liability: ['liable', 'limitation', 'aggregate', 'damages', 'cap', 'exceed'],
  liable: ['liability', 'limitation', 'aggregate', 'damages'],
  limit: ['limitation', 'liability', 'cap', 'aggregate'],
  limitation: ['limit', 'liability', 'cap', 'aggregate'],
  indemnity: ['indemnify', 'indemnified', 'harmless', 'defend'],
  indemnify: ['indemnity', 'indemnified', 'harmless', 'defend'],
  confidentiality: ['confidential', 'proprietary', 'disclosure', 'secret'],
  confidential: ['confidentiality', 'proprietary', 'disclosure', 'secret'],
  payment: ['fees', 'fee', 'invoice', 'invoices', 'due', 'pay'],
  fees: ['payment', 'fee', 'invoice', 'invoices', 'pay'],
  fee: ['payment', 'fees', 'invoice', 'pay'],
  invoice: ['payment', 'fees', 'invoices', 'pay'],
  assignment: ['assign', 'assigns', 'assigned', 'transfer'],
  assign: ['assignment', 'assigns', 'assigned', 'transfer'],
};

export function tokenizeAndStem(text: string): string[] {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return words.map((w) => lightStem(w));
}

export function extractHeadingLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headings: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 4); i++) {
    const line = lines[i];
    if (
      /^(?:article|section|clause|\d+\.)/i.test(line) ||
      (line.length < 80 && line === line.toUpperCase() && /[A-Z]/.test(line)) ||
      (line.length < 80 && /^[A-Z][A-Za-z0-9\s.,:-]+[.:]?$/.test(line) && !line.includes('shall') && !line.includes('agree'))
    ) {
      headings.push(line);
    }
  }
  const match = text.match(/^(?:ARTICLE|SECTION|CLAUSE|\d+\.)\s*[^.\n]+[.\n]/i);
  if (match && !headings.includes(match[0].trim())) {
    headings.push(match[0].trim());
  }
  return headings;
}

/**
 * Scores chunk objects using Okapi BM25 (k1=1.2, b=0.75) with IDF computed over chunks,
 * stopword filtering, light stemming, legal synonym expansion, section-title boost,
 * and chunk heading bonuses.
 */
export function scoreChunksWithBM25(
  chunks: Array<DocumentChunkData>,
  query: string,
  options?: {
    isLocalHashVectorizer?: boolean;
    queryEmbedding?: number[];
  }
): RetrievedChunk[] {
  if (chunks.length === 0) return [];

  // 1. Extract query words excluding stopwords
  const rawWords = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

  const primaryTerms = Array.from(new Set(rawWords.map((w) => lightStem(w))));

  // 2. Expand legal synonyms
  const synonymTermsSet = new Set<string>();
  for (const raw of rawWords) {
    const rawSt = lightStem(raw);
    const syns = LEGAL_SYNONYMS[raw] || LEGAL_SYNONYMS[rawSt] || [];
    for (const syn of syns) {
      const synSt = lightStem(syn);
      if (!STOPWORDS.has(syn) && !primaryTerms.includes(synSt)) {
        synonymTermsSet.add(synSt);
      }
    }
  }
  const synonymTerms = Array.from(synonymTermsSet);

  if (primaryTerms.length === 0 && synonymTerms.length === 0) {
    const fallback = query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
    primaryTerms.push(...fallback.map((w) => lightStem(w)));
  }

  // 3. Document statistics for BM25
  const N = chunks.length;
  const k1 = 1.2;
  const b = 0.75;

  const chunkTokenMaps: Array<{
    tf: Map<string, number>;
    length: number;
    headingTokens: Set<string>;
    sectionTitleTokens: Set<string>;
  }> = [];

  let totalLength = 0;
  for (const chunk of chunks) {
    const tokens = tokenizeAndStem(chunk.text);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }

    const headings = extractHeadingLines(chunk.text);
    const headingTokens = new Set<string>();
    for (const h of headings) {
      for (const ht of tokenizeAndStem(h)) {
        headingTokens.add(ht);
      }
    }

    const sectionTitleTokens = new Set<string>(tokenizeAndStem(chunk.sectionTitle || ''));

    chunkTokenMaps.push({
      tf,
      length: tokens.length,
      headingTokens,
      sectionTitleTokens,
    });
    totalLength += tokens.length;
  }

  const avgdl = Math.max(totalLength / N, 1);

  // 4. Compute IDF for each query term over chunks
  const idfMap = new Map<string, number>();
  for (const term of [...primaryTerms, ...synonymTerms]) {
    let docFreq = 0;
    for (const c of chunkTokenMaps) {
      if (c.tf.has(term)) {
        docFreq++;
      }
    }
    const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
    idfMap.set(term, idf);
  }

  // 5. Score each chunk
  const scoredItems: Array<{
    chunk: DocumentChunkData;
    bm25: number;
    semantic: number;
  }> = [];

  let maxBM25 = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const { tf, length: dl, headingTokens, sectionTitleTokens } = chunkTokenMaps[i];

    let bm25 = 0;

    // Primary terms: weight 1.0
    for (const term of primaryTerms) {
      const freq = tf.get(term) || 0;
      const idf = idfMap.get(term) || 0;
      if (freq > 0) {
        const tfScore = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (dl / avgdl)));
        bm25 += 1.0 * idf * tfScore;
      }
      if (sectionTitleTokens.has(term)) {
        bm25 += 2.5 * idf;
      }
      if (headingTokens.has(term)) {
        bm25 += 3.5 * idf;
      }
    }

    // Synonym terms: weight 0.75
    for (const term of synonymTerms) {
      const freq = tf.get(term) || 0;
      const idf = idfMap.get(term) || 0;
      if (freq > 0) {
        const tfScore = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (dl / avgdl)));
        bm25 += 0.75 * idf * tfScore;
      }
      if (sectionTitleTokens.has(term)) {
        bm25 += 1.5 * idf;
      }
      if (headingTokens.has(term)) {
        bm25 += 2.0 * idf;
      }
    }

    if (bm25 > maxBM25) {
      maxBM25 = bm25;
    }

    // Semantic cosine score if queryEmbedding provided
    let semantic = 0;
    if (options?.queryEmbedding && chunk.embedding) {
      try {
        const embeddingVector = Array.isArray(chunk.embedding)
          ? chunk.embedding
          : JSON.parse(chunk.embedding);
        if (Array.isArray(embeddingVector) && embeddingVector.length > 0) {
          semantic = cosineSimilarity(options.queryEmbedding, embeddingVector);
        }
      } catch {}
    }

    scoredItems.push({ chunk, bm25, semantic });
  }

  // 6. Combine scores
  const isLocalHash = options?.isLocalHashVectorizer !== false;
  const results: RetrievedChunk[] = [];

  for (const item of scoredItems) {
    let finalScore = item.bm25;
    if (!isLocalHash && maxBM25 > 0) {
      const normBM25 = item.bm25 / maxBM25;
      finalScore = 0.7 * normBM25 + 0.3 * Math.max(0, item.semantic);
    }

    results.push({
      id: item.chunk.id,
      documentId: item.chunk.documentId,
      chunkIndex: item.chunk.chunkIndex,
      text: item.chunk.text,
      pageStart: item.chunk.pageStart,
      pageEnd: item.chunk.pageEnd,
      startOffset: item.chunk.startOffset,
      endOffset: item.chunk.endOffset,
      sectionNumber: item.chunk.sectionNumber,
      sectionTitle: item.chunk.sectionTitle,
      score: finalScore,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Retrieves top relevant chunks for a question using hybrid semantic + keyword scoring.
 */
export async function retrieveChunksForDocument(
  documentId: string,
  query: string,
  topK = 5
): Promise<RetrievedChunk[]> {
  let chunks: any[] = [];
  try {
    chunks = await prisma.documentChunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: 'asc' },
    });
  } catch (err) {
    // If database is not yet migrated or offline, return empty list gracefully
    return [];
  }

  if (chunks.length === 0) return [];

  const embeddingProvider = getEmbeddingProvider();
  const isLocalHashVectorizer = embeddingProvider.name === 'fast-local-vector';
  let queryEmbedding: number[] | undefined;

  if (!isLocalHashVectorizer) {
    try {
      queryEmbedding = await embeddingProvider.generateEmbedding(query);
    } catch {}
  }

  const scored = scoreChunksWithBM25(chunks, query, {
    isLocalHashVectorizer,
    queryEmbedding,
  });

  return scored.slice(0, topK);
}

export interface SectionContentResult {
  sectionNumber: string;
  heading?: string;
  text: string;
  pageStart: number;
  pageEnd: number;
  chunkIds: string[];
  pages: number[];
  complete: boolean;
  nextOffset?: number;
}

/**
 * Detects direct section questions like "What does Article 55 say?", "What does Clause 14 state?", "Article 55"
 */
export function detectDirectSectionQuestion(question: string): { isDirectSection: boolean; sectionNumber?: string } {
  const q = question.trim();
  // 1. "What does Article/Clause/Section 55 say/state/provide/mean/contain/cover...?"
  let match = q.match(/what\s+does\s+(?:article|clause|section)\s+([0-9]+(?:\.[0-9]+)?)/i);
  if (match && match[1]) {
    return { isDirectSection: true, sectionNumber: match[1] };
  }
  // 2. "What is in Article/Clause/Section 55...?" or "Summarize Article 55..." or "Explain Article 55..."
  match = q.match(/(?:what\s+is\s+(?:in\s+)?|summarize\s+|explain\s+)(?:article|clause|section)\s+([0-9]+(?:\.[0-9]+)?)/i);
  if (match && match[1]) {
    return { isDirectSection: true, sectionNumber: match[1] };
  }
  // 3. Standalone "Article 55", "Clause 14", "Section 3.1"
  match = q.match(/^(?:article|clause|section)\s+([0-9]+(?:\.[0-9]+)?)\??$/i);
  if (match && match[1]) {
    return { isDirectSection: true, sectionNumber: match[1] };
  }
  return { isDirectSection: false };
}

/**
 * Retrieves a specific section by sectionNumber (e.g. "12", "14.2", "Clause 14", "Article 55").
 * Delimited by the next "Article N." / "N." heading, including clauses inside the article.
 */
export async function getSectionContent(
  documentId: string,
  sectionNumber: string,
  offset: number = 0,
  limit: number = 15000
): Promise<SectionContentResult | null> {
  const cleanNumber = sectionNumber.replace(/^(?:section|clause|article)\s*/i, '').trim();
  const numMatch = cleanNumber.match(/^(\d+(?:\.\d+)?)/);
  const pureNumber = numMatch ? numMatch[1] : cleanNumber;

  // Try extracting directly from canonical extractedText if available
  try {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        extractedText: true,
        pagesJson: true,
        chunks: {
          orderBy: { chunkIndex: 'asc' },
          select: { id: true, chunkIndex: true, pageStart: true, pageEnd: true, startOffset: true, endOffset: true, text: true, sectionNumber: true },
        },
      },
    });

    if (doc?.extractedText) {
      const fullText = doc.extractedText;
      // Regex for this section heading: e.g. "ARTICLE 55" or "Section 55" or "55."
      const escapedNum = pureNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const startRegex = new RegExp(
        `(?:^|\\n)(?:(?:ARTICLE|Article|SECTION|Section|CLAUSE|Clause)\\s+)?${escapedNum}[.:\\s]+([^\\n\\r]*)`,
        'gi'
      );

      const matches: Array<{ start: number; heading: string; rawHeading: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = startRegex.exec(fullText)) !== null) {
        matches.push({
          start: m.index,
          heading: m[1]?.trim() || '',
          rawHeading: m[0],
        });
      }

      if (matches.length > 0) {
        const isArticle = /^article\b/i.test(sectionNumber) || matches.some((match) => /article/i.test(match.rawHeading));
        const segments: Array<{ text: string; heading: string; start: number; end: number }> = [];
        const coveredPages = new Set<number>();
        const coveredChunkIds: string[] = [];

        for (const match of matches) {
          const sectionStart = match.start;
          let sectionEnd = fullText.length;

          if (isArticle) {
            const nextArticleRegex = /(?:^|\n)(?:ARTICLE|Article)\s+(\d+)/gi;
            nextArticleRegex.lastIndex = sectionStart + match.rawHeading.length;
            let nextArtMatch: RegExpExecArray | null;
            while ((nextArtMatch = nextArticleRegex.exec(fullText)) !== null) {
              if (nextArtMatch[1] !== pureNumber) {
                sectionEnd = nextArtMatch.index;
                break;
              }
            }
          } else {
            const nextSectionRegex = /(?:^|\n)(?:(?:SECTION|Section|CLAUSE|Clause|ARTICLE|Article)\s+(\d+(?:\.\d+)?)|(\d+)\.\s+[A-Z])/gi;
            nextSectionRegex.lastIndex = sectionStart + match.rawHeading.length;
            let nextSecMatch: RegExpExecArray | null;
            while ((nextSecMatch = nextSectionRegex.exec(fullText)) !== null) {
              const foundNum = nextSecMatch[1] || nextSecMatch[2];
              if (foundNum && foundNum !== pureNumber && !foundNum.startsWith(pureNumber + '.')) {
                sectionEnd = nextSecMatch.index;
                break;
              }
            }
          }

          const segText = fullText.slice(sectionStart, sectionEnd).trim();
          segments.push({
            text: segText,
            heading: match.heading,
            start: sectionStart,
            end: sectionEnd,
          });

          if (Array.isArray(doc.pagesJson)) {
            for (const p of doc.pagesJson as Array<{ pageNumber: number; startOffset: number; endOffset: number }>) {
              if (p.endOffset >= sectionStart && p.startOffset <= sectionEnd) {
                coveredPages.add(p.pageNumber);
              }
            }
          }

          for (const c of doc.chunks) {
            if (c.endOffset >= sectionStart && c.startOffset <= sectionEnd) {
              coveredChunkIds.push(c.id);
              for (let p = c.pageStart; p <= c.pageEnd; p++) {
                coveredPages.add(p);
              }
            }
          }
        }

        // Prioritize substantive headings (e.g. Limitation of Liability, Termination, Confidentiality)
        const substantiveSegment = segments.find((s) =>
          /liabilit|remed|terminat|indemn|confidential/i.test(s.heading)
        );
        const heading = substantiveSegment?.heading || segments[0].heading;

        // If multiple occurrences exist, combine them so all clauses (including p. 112) are present
        const combinedText = segments.map((s) => s.text).join('\n\n');
        const sectionStart = segments[0].start;
        const sectionEnd = segments[segments.length - 1].end;

        const actualStart = offset;
        const actualEnd = Math.min(actualStart + limit, combinedText.length);
        const sectionText = combinedText.slice(actualStart, actualEnd).trim();
        const complete = actualEnd >= combinedText.length;
        const nextOffset = complete ? undefined : offset + limit;

        const pagesList = Array.from(coveredPages).sort((a, b) => a - b);
        const pageStart = pagesList[0] || 1;
        const pageEnd = pagesList[pagesList.length - 1] || pageStart;

        return {
          sectionNumber: pureNumber,
          heading,
          text: sectionText,
          pageStart,
          pageEnd,
          chunkIds: coveredChunkIds,
          pages: pagesList,
          complete,
          nextOffset,
        };
      }
    }
  } catch (err) {
    console.warn('[getSectionContent] Document text lookup error:', err);
  }

  // Fallback: chunk-based lookup
  let chunks: any[] = [];
  try {
    chunks = await prisma.documentChunk.findMany({
      where: {
        documentId,
        OR: [
          { sectionNumber: { equals: cleanNumber, mode: 'insensitive' } },
          { sectionNumber: { contains: cleanNumber, mode: 'insensitive' } },
          { sectionTitle: { contains: cleanNumber, mode: 'insensitive' } },
          { text: { contains: `Article ${cleanNumber}`, mode: 'insensitive' } },
          { text: { contains: `Section ${cleanNumber}`, mode: 'insensitive' } },
          { text: { contains: `Clause ${cleanNumber}`, mode: 'insensitive' } },
        ],
      },
      orderBy: { chunkIndex: 'asc' },
    });
  } catch {
    return null;
  }

  if (chunks.length === 0) return null;

  const combinedText = chunks.map((c) => c.text).join('\n\n');
  const pageStart = Math.min(...chunks.map((c) => c.pageStart));
  const pageEnd = Math.max(...chunks.map((c) => c.pageEnd));
  const pagesSet = new Set<number>();
  for (const c of chunks) {
    for (let p = c.pageStart; p <= c.pageEnd; p++) {
      pagesSet.add(p);
    }
  }

  return {
    sectionNumber: chunks[0].sectionNumber || cleanNumber,
    heading: chunks[0].sectionTitle || undefined,
    text: combinedText,
    pageStart,
    pageEnd,
    chunkIds: chunks.map((c) => c.id),
    pages: Array.from(pagesSet).sort((a, b) => a - b),
    complete: true,
  };
}

/**
 * Lists all indexed clauses / sections in the document.
 */
export async function listDocumentClauses(
  documentId: string
): Promise<{ sectionNumber: string; sectionTitle: string; page: number; chunkId?: string }[]> {
  let chunks: any[] = [];
  try {
    chunks = await prisma.documentChunk.findMany({
      where: {
        documentId,
        sectionNumber: { not: null },
      },
      orderBy: { chunkIndex: 'asc' },
    });
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const results: { sectionNumber: string; sectionTitle: string; page: number; chunkId?: string }[] = [];

  for (const c of chunks) {
    if (c.sectionNumber && !seen.has(c.sectionNumber)) {
      seen.add(c.sectionNumber);
      results.push({
        sectionNumber: c.sectionNumber,
        sectionTitle: c.sectionTitle || 'General Provisions',
        page: c.pageStart,
        chunkId: c.id,
      });
    }
  }

  return results;
}
