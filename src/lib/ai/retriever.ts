import { prisma } from '../prisma';
import { cosineSimilarity, getEmbeddingProvider } from './embeddings';
import { DocumentChunkData } from '../types';

export interface RetrievedChunk extends DocumentChunkData {
  score: number;
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
  const queryEmbedding = await embeddingProvider.generateEmbedding(query);

  const queryTerms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    let embeddingVector: number[] = [];
    if (chunk.embedding) {
      try {
        embeddingVector = JSON.parse(chunk.embedding);
      } catch {
        embeddingVector = [];
      }
    }

    // Semantic cosine score
    const semanticScore = embeddingVector.length > 0
      ? cosineSimilarity(queryEmbedding, embeddingVector)
      : 0;

    // Keyword / BM25 term overlap score
    const textLower = chunk.text.toLowerCase();
    let keywordScore = 0;
    for (const term of queryTerms) {
      if (textLower.includes(term)) {
        keywordScore += 0.25;
      }
    }

    // Section title boost
    if (chunk.sectionTitle) {
      const titleLower = chunk.sectionTitle.toLowerCase();
      for (const term of queryTerms) {
        if (titleLower.includes(term)) {
          keywordScore += 0.5;
        }
      }
    }

    const totalScore = semanticScore * 0.6 + Math.min(keywordScore, 1.0) * 0.4;

    scored.push({
      id: chunk.id,
      documentId: chunk.documentId,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      sectionNumber: chunk.sectionNumber,
      sectionTitle: chunk.sectionTitle,
      score: totalScore,
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

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
