import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { extractPdfText } from '../src/lib/documents/pdf-extractor';
import { chunkDocument, ChunkResult } from '../src/lib/documents/chunker';
import { scoreChunksWithBM25, lightStem, STOPWORDS, LEGAL_SYNONYMS } from '../src/lib/ai/retriever';
import { DocumentChunkData } from '../src/lib/types';

describe('Task 1: BM25 Retriever with Stemming, Synonyms, and Heading Boosts', () => {
  let chunks: DocumentChunkData[] = [];

  beforeAll(async () => {
    const fixturePath = path.join(process.cwd(), 'fixtures', 'large-contract-v1-150pages.pdf');
    const pdfBuf = await fs.readFile(fixturePath);
    const extracted = await extractPdfText(pdfBuf);
    const chunkResults = chunkDocument(extracted);

    chunks = chunkResults.map((c, idx) => ({
      id: `chunk_${idx}`,
      documentId: 'doc_v1',
      chunkIndex: c.chunkIndex,
      text: c.text,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      sectionNumber: c.sectionNumber || undefined,
      sectionTitle: c.sectionTitle || undefined,
    }));

    console.log(`[Task 1 Test] Extracted ${chunks.length} chunks from 150-page fixture.`);
  });

  it('lightStem strips ing, ed, es, and s correctly', () => {
    expect(lightStem('governing')).toBe('govern');
    expect(lightStem('governed')).toBe('govern');
    expect(lightStem('terminating')).toBe('terminat');
    expect(lightStem('terminated')).toBe('terminat');
    expect(lightStem('caps')).toBe('cap');
    expect(lightStem('days')).toBe('day');
    expect(lightStem('clauses')).toBe('claus');
    expect(lightStem('laws')).toBe('law');
    expect(lightStem('pass')).toBe('pass'); // does not strip double s
  });

  it('1. "Which version has the longer termination notice?" ranks Termination for Convenience (p. 38) in top 3', () => {
    const query = 'Which version has the longer termination notice?';
    const ranked = scoreChunksWithBM25(chunks, query);

    const termChunkIdx = ranked.findIndex(
      (c) => c.pageStart <= 38 && c.pageEnd >= 38 && /termination for convenience/i.test(c.text)
    );
    const rank = termChunkIdx + 1;
    console.log(`[Termination Notice] Correct chunk rank: ${rank} (score: ${ranked[termChunkIdx]?.score})`);

    expect(rank).toBeGreaterThan(0);
    expect(rank).toBeLessThanOrEqual(3);
  });

  it('2. "How do the liability caps differ between the two documents?" ranks Limitation of Liability (p. 112) in top 3', () => {
    const query = 'How do the liability caps differ between the two documents?';
    const ranked = scoreChunksWithBM25(chunks, query);

    const liabChunkIdx = ranked.findIndex(
      (c) => c.pageStart <= 112 && c.pageEnd >= 112 && /limitation of liability/i.test(c.text)
    );
    const rank = liabChunkIdx + 1;
    console.log(`[Liability Caps] Correct chunk rank: ${rank} (score: ${ranked[liabChunkIdx]?.score})`);

    expect(rank).toBeGreaterThan(0);
    expect(rank).toBeLessThanOrEqual(3);
  });

  it('3. "Do both contracts have the same governing law?" ranks Governing Law (p. 116) in top 3', () => {
    const query = 'Do both contracts have the same governing law?';
    const ranked = scoreChunksWithBM25(chunks, query);

    const govChunkIdx = ranked.findIndex(
      (c) => c.pageStart <= 116 && c.pageEnd >= 116 && /governing law/i.test(c.text)
    );
    const rank = govChunkIdx + 1;
    console.log(`[Governing Law] Correct chunk rank: ${rank} (score: ${ranked[govChunkIdx]?.score})`);

    expect(rank).toBeGreaterThan(0);
    expect(rank).toBeLessThanOrEqual(3);
  });

  it('4. "What are the confidentiality obligations?" ranks both p. 9 and p. 150 chunks in top 5', () => {
    const query = 'What are the confidentiality obligations?';
    const ranked = scoreChunksWithBM25(chunks, query);

    const p9Idx = ranked.findIndex(
      (c) => c.pageStart <= 9 && c.pageEnd >= 9 && /confidentiality/i.test(c.text)
    );
    const p150Idx = ranked.findIndex(
      (c) => c.pageStart <= 150 && c.pageEnd >= 150 && /confidentiality/i.test(c.text)
    );

    const rankP9 = p9Idx + 1;
    const rankP150 = p150Idx + 1;
    console.log(`[Confidentiality] Page 9 rank: ${rankP9}, Page 150 rank: ${rankP150}`);

    expect(rankP9).toBeGreaterThan(0);
    expect(rankP9).toBeLessThanOrEqual(5);
    expect(rankP150).toBeGreaterThan(0);
    expect(rankP150).toBeLessThanOrEqual(5);
  });
});
