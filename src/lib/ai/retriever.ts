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

/**
 * Retrieves a specific section by sectionNumber (e.g. "12", "14.2", "Clause 14").
 */
export async function getSectionContent(
  documentId: string,
  sectionNumber: string
): Promise<{ sectionNumber: string; text: string; pageStart: number; pageEnd: number } | null> {
  const cleanNumber = sectionNumber.replace(/^(?:section|clause|article)\s*/i, '').trim();

  let chunks: any[] = [];
  try {
    chunks = await prisma.documentChunk.findMany({
      where: {
        documentId,
        OR: [
          { sectionNumber: { equals: cleanNumber, mode: 'insensitive' } },
          { sectionNumber: { contains: cleanNumber, mode: 'insensitive' } },
          { sectionTitle: { contains: cleanNumber, mode: 'insensitive' } },
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

  return {
    sectionNumber: chunks[0].sectionNumber || cleanNumber,
    text: combinedText,
    pageStart,
    pageEnd,
  };
}

/**
 * Lists all indexed clauses / sections in the document.
 */
export async function listDocumentClauses(
  documentId: string
): Promise<{ sectionNumber: string; sectionTitle: string; page: number }[]> {
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
  const results: { sectionNumber: string; sectionTitle: string; page: number }[] = [];

  for (const c of chunks) {
    if (c.sectionNumber && !seen.has(c.sectionNumber)) {
      seen.add(c.sectionNumber);
      results.push({
        sectionNumber: c.sectionNumber,
        sectionTitle: c.sectionTitle || 'General Provisions',
        page: c.pageStart,
      });
    }
  }

  return results;
}
