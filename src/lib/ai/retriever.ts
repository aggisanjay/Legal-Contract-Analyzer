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
      const escapedNum = cleanNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const startRegex = new RegExp(
        `(?:^|\\n)(?:(?:ARTICLE|Article|SECTION|Section|CLAUSE|Clause)\\s+)?${escapedNum}[.:\\s]+([^\\n\\r]*)`,
        'i'
      );

      const startMatch = startRegex.exec(fullText);
      if (startMatch) {
        const sectionStart = startMatch.index;
        const heading = startMatch[1]?.trim() || '';

        // Delimit by the next "Article N." or next major section heading
        const isArticle = /^article\b/i.test(sectionNumber) || /article/i.test(startMatch[0]);
        let endRegex: RegExp;
        if (isArticle) {
          endRegex = /(?:^|\n)(?:ARTICLE|Article)\s+[0-9]+/gi;
        } else {
          endRegex = /(?:^|\n)(?:(?:SECTION|Section|CLAUSE|Clause|ARTICLE|Article)\s+[0-9]+|[0-9]{1,3}\.)\s+[^\n\r]+/gi;
        }

        endRegex.lastIndex = sectionStart + startMatch[0].length;
        const nextMatch = endRegex.exec(fullText);
        const sectionEnd = nextMatch ? nextMatch.index : fullText.length;

        const totalSectionLength = sectionEnd - sectionStart;
        const actualStart = sectionStart + offset;
        const actualEnd = Math.min(actualStart + limit, sectionEnd);
        const sectionText = fullText.slice(actualStart, actualEnd).trim();
        const complete = actualEnd >= sectionEnd;
        const nextOffset = complete ? undefined : offset + limit;

        // Find covered pages and chunks
        const coveredPages = new Set<number>();
        const coveredChunkIds: string[] = [];

        for (const c of doc.chunks) {
          if (c.endOffset >= actualStart && c.startOffset <= actualEnd) {
            coveredChunkIds.push(c.id);
            for (let p = c.pageStart; p <= c.pageEnd; p++) {
              coveredPages.add(p);
            }
          }
        }

        const pagesList = Array.from(coveredPages).sort((a, b) => a - b);
        const pageStart = pagesList[0] || 1;
        const pageEnd = pagesList[pagesList.length - 1] || pageStart;

        return {
          sectionNumber: cleanNumber,
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
