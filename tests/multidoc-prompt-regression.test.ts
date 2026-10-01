import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { extractPdfText } from '../src/lib/documents/pdf-extractor';
import { chunkDocument } from '../src/lib/documents/chunker';
import {
  executeTargetedRetrieval,
  assembleMultiDocEvidenceForDoc,
  buildMultiDocPrompt,
  TargetedChunkResult,
} from '../src/lib/ai/coverage';
import { DocumentChunkData, ExtractedDocument } from '../src/lib/types';

describe('Task 4: Multi-Doc Prompt Regression Tests & Relevance Budget Cut', () => {
  let v1Extracted: ExtractedDocument;
  let v2Extracted: ExtractedDocument;
  let v1Chunks: DocumentChunkData[] = [];
  let v2Chunks: DocumentChunkData[] = [];

  beforeAll(async () => {
    const v1Path = path.join(process.cwd(), 'fixtures', 'large-contract-v1-150pages.pdf');
    const v2Path = path.join(process.cwd(), 'fixtures', 'large-contract-v2-150pages.pdf');

    const v1Buf = await fs.readFile(v1Path);
    const v2Buf = await fs.readFile(v2Path);

    v1Extracted = await extractPdfText(v1Buf);
    v2Extracted = await extractPdfText(v2Buf);

    v1Chunks = chunkDocument(v1Extracted).map((c, i) => ({
      id: `v1_chunk_${i}`,
      documentId: 'v1-doc',
      chunkIndex: c.chunkIndex,
      text: c.text,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      sectionNumber: c.sectionNumber || undefined,
      sectionTitle: c.sectionTitle || undefined,
    }));

    v2Chunks = chunkDocument(v2Extracted).map((c, i) => ({
      id: `v2_chunk_${i}`,
      documentId: 'v2-doc',
      chunkIndex: c.chunkIndex,
      text: c.text,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      sectionNumber: c.sectionNumber || undefined,
      sectionTitle: c.sectionTitle || undefined,
    }));
  });

  describe('Unit Test: Relevance Budget Cut vs Early Chunks', () => {
    it('guarantees an irrelevant early chunk list (pages 1-9) cannot crowd out a high-ranked chunk on page 112', () => {
      // Simulate 15 dummy chunks on pages 1-9 (1,000 chars each = 15,000 chars, low score 2.0)
      const earlyChunks: TargetedChunkResult[] = Array.from({ length: 15 }, (_, i) => ({
        id: `early_chunk_${i}`,
        chunkIndex: i,
        text: `Preamble operational clause ${i} with generic boilerplates `.repeat(15),
        pageStart: Math.floor(i / 2) + 1,
        pageEnd: Math.floor(i / 2) + 1,
        score: 2.0,
        isPrimary: false,
      }));

      // A high-ranked primary chunk on page 112 with score 45.0
      const page112Chunk: TargetedChunkResult = {
        id: 'chunk_page_112',
        chunkIndex: 220,
        text: 'ARTICLE 55. LIMITATION OF LIABILITY. The aggregate liability of either party shall not exceed AED 100,000.',
        pageStart: 112,
        pageEnd: 112,
        score: 45.0,
        isPrimary: true,
        sectionTitle: 'LIMITATION OF LIABILITY AND REMEDIES',
        sectionNumber: 55,
      };

      // In relevance order, page112Chunk comes first because score 45.0 > 2.0
      const retrievedInRelevanceOrder = [page112Chunk, ...earlyChunks];

      // Assemble evidence with a tight budget (e.g. 10,000 chars)
      const evidenceItem = assembleMultiDocEvidenceForDoc({
        doc: { id: 'test-doc', originalFilename: 'contract.pdf', pageCount: 150 },
        alias: 'DOC_1',
        index: 1,
        retrievedChunks: retrievedInRelevanceOrder,
        fairShareChars: 10000,
      });

      // Assert page 112 chunk is preserved in the evidence
      expect(evidenceItem.chunks.some((c) => c.pageStart === 112)).toBe(true);
      expect(evidenceItem.evidence).toContain('AED 100,000');
      expect(evidenceItem.evidence).toContain('[DOC_1 | Page 112 | Article 55 — LIMITATION OF LIABILITY AND REMEDIES]');
      expect(evidenceItem.pagesExamined).toContain(112);

      // Early chunks were dropped or truncated once the budget was full
      expect(evidenceItem.droppedCount).toBeGreaterThan(0);
      const totalChunkTextLen = evidenceItem.chunks.reduce((acc, c) => acc + c.text.length, 0);
      expect(totalChunkTextLen).toBeLessThanOrEqual(10000 + page112Chunk.text.length);
    });
  });

  describe('Integration Test: Multi-Doc Prompt Construction on 150-Page Fixtures', () => {
    it('1. "Which version has the longer termination notice?" -> prompt contains "thirty (30) days" (v1) and "sixty (60) days" (v2)', async () => {
      const question = 'Which version has the longer termination notice?';
      const topicQuery = 'termination for convenience notice period';

      const resV1 = await executeTargetedRetrieval('v1-doc', topicQuery, 150, {
        isMultiDoc: true,
        maxPrimaryHits: 6,
        allChunks: v1Chunks,
      });
      const resV2 = await executeTargetedRetrieval('v2-doc', topicQuery, 150, {
        isMultiDoc: true,
        maxPrimaryHits: 6,
        allChunks: v2Chunks,
      });

      const fairShare = 18000;
      const doc1Evidence = assembleMultiDocEvidenceForDoc({
        doc: { id: 'v1-doc', originalFilename: 'large-contract-v1-150pages.pdf', pageCount: 150 },
        alias: 'DOC_1',
        index: 1,
        retrievedChunks: resV1.chunks,
        fairShareChars: fairShare,
      });
      const doc2Evidence = assembleMultiDocEvidenceForDoc({
        doc: { id: 'v2-doc', originalFilename: 'large-contract-v2-150pages.pdf', pageCount: 150 },
        alias: 'DOC_2',
        index: 2,
        retrievedChunks: resV2.chunks,
        fairShareChars: fairShare,
      });

      const fullPrompt = buildMultiDocPrompt(question, [doc1Evidence, doc2Evidence]);

      console.log('\n[DEBUG Prompt - Termination Notice]:');
      console.log('DOC_1 pages examined in prompt:', doc1Evidence.pagesExamined);
      console.log('DOC_2 pages examined in prompt:', doc2Evidence.pagesExamined);

      // Verify page 38 is in prompt pages
      expect(doc1Evidence.pagesExamined).toContain(38);
      expect(doc2Evidence.pagesExamined).toContain(38);

      // Assert on exact strings in prompt under their respective document sections
      const doc1Section = fullPrompt.split('=== DOCUMENT 2')[0];
      const doc2Section = fullPrompt.split('=== DOCUMENT 2')[1];

      expect(doc1Section).toContain('thirty (30) days');
      expect(doc2Section).toContain('sixty (60) days');

      // Verify prompt budget
      expect(doc1Evidence.evidence.length).toBeLessThanOrEqual(fairShare + 500);
      expect(doc2Evidence.evidence.length).toBeLessThanOrEqual(fairShare + 500);
    });

    it('2. "How do the liability caps differ between the two documents?" -> prompt contains "AED 100,000" (v1) and "AED 1,000,000" (v2)', async () => {
      const question = 'How do the liability caps differ between the two documents?';
      const topicQuery = 'limitation of liability cap';

      const resV1 = await executeTargetedRetrieval('v1-doc', topicQuery, 150, {
        isMultiDoc: true,
        maxPrimaryHits: 6,
        allChunks: v1Chunks,
      });
      const resV2 = await executeTargetedRetrieval('v2-doc', topicQuery, 150, {
        isMultiDoc: true,
        maxPrimaryHits: 6,
        allChunks: v2Chunks,
      });

      const fairShare = 18000;
      const doc1Evidence = assembleMultiDocEvidenceForDoc({
        doc: { id: 'v1-doc', originalFilename: 'large-contract-v1-150pages.pdf', pageCount: 150 },
        alias: 'DOC_1',
        index: 1,
        retrievedChunks: resV1.chunks,
        fairShareChars: fairShare,
      });
      const doc2Evidence = assembleMultiDocEvidenceForDoc({
        doc: { id: 'v2-doc', originalFilename: 'large-contract-v2-150pages.pdf', pageCount: 150 },
        alias: 'DOC_2',
        index: 2,
        retrievedChunks: resV2.chunks,
        fairShareChars: fairShare,
      });

      const fullPrompt = buildMultiDocPrompt(question, [doc1Evidence, doc2Evidence]);

      console.log('\n[DEBUG Prompt - Liability Caps]:');
      console.log('DOC_1 pages examined in prompt:', doc1Evidence.pagesExamined);
      console.log('DOC_2 pages examined in prompt:', doc2Evidence.pagesExamined);

      // Assert page 112 is in prompt pages
      expect(doc1Evidence.pagesExamined).toContain(112);
      expect(doc2Evidence.pagesExamined).toContain(112);

      const doc1Section = fullPrompt.split('=== DOCUMENT 2')[0];
      const doc2Section = fullPrompt.split('=== DOCUMENT 2')[1];

      expect(doc1Section).toContain('AED 100,000');
      expect(doc2Section).toContain('AED 1,000,000');

      // Verify prompt budget
      expect(doc1Evidence.evidence.length).toBeLessThanOrEqual(fairShare + 500);
      expect(doc2Evidence.evidence.length).toBeLessThanOrEqual(fairShare + 500);
    });

    it('3. "Do both contracts have the same governing law?" -> prompt contains "laws of the Emirate of Dubai" twice', async () => {
      const question = 'Do both contracts have the same governing law?';
      const topicQuery = 'governing law and jurisdiction';

      const resV1 = await executeTargetedRetrieval('v1-doc', topicQuery, 150, {
        isMultiDoc: true,
        maxPrimaryHits: 6,
        allChunks: v1Chunks,
      });
      const resV2 = await executeTargetedRetrieval('v2-doc', topicQuery, 150, {
        isMultiDoc: true,
        maxPrimaryHits: 6,
        allChunks: v2Chunks,
      });

      const fairShare = 18000;
      const doc1Evidence = assembleMultiDocEvidenceForDoc({
        doc: { id: 'v1-doc', originalFilename: 'large-contract-v1-150pages.pdf', pageCount: 150 },
        alias: 'DOC_1',
        index: 1,
        retrievedChunks: resV1.chunks,
        fairShareChars: fairShare,
      });
      const doc2Evidence = assembleMultiDocEvidenceForDoc({
        doc: { id: 'v2-doc', originalFilename: 'large-contract-v2-150pages.pdf', pageCount: 150 },
        alias: 'DOC_2',
        index: 2,
        retrievedChunks: resV2.chunks,
        fairShareChars: fairShare,
      });

      const fullPrompt = buildMultiDocPrompt(question, [doc1Evidence, doc2Evidence]);

      console.log('\n[DEBUG Prompt - Governing Law]:');
      console.log('DOC_1 pages examined in prompt:', doc1Evidence.pagesExamined);
      console.log('DOC_2 pages examined in prompt:', doc2Evidence.pagesExamined);

      expect(doc1Evidence.pagesExamined).toContain(116);
      expect(doc2Evidence.pagesExamined).toContain(116);

      const doc1Section = fullPrompt.split('=== DOCUMENT 2')[0];
      const doc2Section = fullPrompt.split('=== DOCUMENT 2')[1];

      expect(doc1Section).toContain('laws of the Emirate of Dubai');
      expect(doc2Section).toContain('laws of the Emirate of Dubai');
    });

    it('4. The coverage list equals the pages of the chunks in the prompt (assert p. 112 is listed iff in prompt)', async () => {
      const topicQuery = 'limitation of liability cap';
      const resV1 = await executeTargetedRetrieval('v1-doc', topicQuery, 150, {
        isMultiDoc: true,
        maxPrimaryHits: 6,
        allChunks: v1Chunks,
      });

      const doc1Evidence = assembleMultiDocEvidenceForDoc({
        doc: { id: 'v1-doc', originalFilename: 'large-contract-v1-150pages.pdf', pageCount: 150 },
        alias: 'DOC_1',
        index: 1,
        retrievedChunks: resV1.chunks,
        fairShareChars: 18000,
      });

      const inPromptText = doc1Evidence.evidence.includes('Page 112');
      const inCoverageList = doc1Evidence.pagesExamined.includes(112);

      expect(inCoverageList).toBe(true);
      expect(inPromptText).toBe(true);
      expect(inCoverageList).toBe(inPromptText);
    });
  });
});
