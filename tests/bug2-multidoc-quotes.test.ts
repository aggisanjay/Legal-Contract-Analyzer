import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { resolveDocumentFromAlias } from '../src/lib/ai/coverage';
import { extractPdfText } from '../src/lib/documents/pdf-extractor';
import { verifyQuote } from '../src/lib/quotes/quote-verifier';

describe('Bug 2 - Multi-Document Quotes Verification & Alias Resolution', () => {
  const mockDocList = [
    {
      id: 'db_id_v1',
      name: 'large-contract-v1-150pages.pdf',
      alias: 'DOC_1',
      index: 1,
    },
    {
      id: 'db_id_v2',
      name: 'large-contract-v2-150pages.pdf',
      alias: 'DOC_2',
      index: 2,
    },
  ];

  it('(a) resolveDocumentFromAlias handles all alias formats and never defaults to doc 1', () => {
    // 1. Explicit aliases
    expect(resolveDocumentFromAlias('DOC_1', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('doc_2', mockDocList)?.id).toBe('db_id_v2');

    // 2. Document A / Document B
    expect(resolveDocumentFromAlias('Document A', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('document b', mockDocList)?.id).toBe('db_id_v2');
    expect(resolveDocumentFromAlias('Doc A', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('Doc B', mockDocList)?.id).toBe('db_id_v2');

    // 3. Document 1 / Document 2
    expect(resolveDocumentFromAlias('Document 1', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('Document 2', mockDocList)?.id).toBe('db_id_v2');
    expect(resolveDocumentFromAlias('Doc 1', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('Doc 2', mockDocList)?.id).toBe('db_id_v2');

    // 4. Numeric index strings
    expect(resolveDocumentFromAlias('1', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('2', mockDocList)?.id).toBe('db_id_v2');
    expect(resolveDocumentFromAlias(1, mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias(2, mockDocList)?.id).toBe('db_id_v2');

    // 5. Exact database ID
    expect(resolveDocumentFromAlias('db_id_v1', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('db_id_v2', mockDocList)?.id).toBe('db_id_v2');

    // 6. Filename / substring match
    expect(resolveDocumentFromAlias('large-contract-v1-150pages.pdf', mockDocList)?.id).toBe('db_id_v1');
    expect(resolveDocumentFromAlias('contract-v2', mockDocList)?.id).toBe('db_id_v2');

    // 7. Unknown / unresolvable: MUST return null, NEVER default to doc 1
    expect(resolveDocumentFromAlias('DOC_3', mockDocList)).toBeNull();
    expect(resolveDocumentFromAlias('Document C', mockDocList)).toBeNull();
    expect(resolveDocumentFromAlias('unknown_contract.pdf', mockDocList)).toBeNull();
    expect(resolveDocumentFromAlias('random_string', mockDocList)).toBeNull();
    expect(resolveDocumentFromAlias('', mockDocList)).toBeNull();
    expect(resolveDocumentFromAlias(null, mockDocList)).toBeNull();
    expect(resolveDocumentFromAlias(undefined, mockDocList)).toBeNull();
  });

  it('(b) Multi-doc termination notice quotes (v1 30-day, v2 60-day, p. 38) verify strictly against their respective documents', async () => {
    const v1Path = path.join(process.cwd(), 'fixtures', 'large-contract-v1-150pages.pdf');
    const v2Path = path.join(process.cwd(), 'fixtures', 'large-contract-v2-150pages.pdf');

    let v1PdfBuffer = await fs.readFile(v1Path);
    let v2PdfBuffer = await fs.readFile(v2Path);

    const v1Extracted = await extractPdfText(v1PdfBuffer);
    const v2Extracted = await extractPdfText(v2PdfBuffer);

    // Page 38 in the benchmark fixture has the termination notice clause:
    // v1: thirty (30) days
    // v2: sixty (60) days
    const v1NoticeQuote = "by providing thirty (30) days' written notice.";
    const v2NoticeQuote = "by providing sixty (60) days' written notice.";

    // Verify v1 quote on v1
    const resV1 = verifyQuote({
      documentId: 'db_id_v1',
      candidateQuote: v1NoticeQuote,
      canonicalText: v1Extracted.text,
      pages: v1Extracted.pages.map((p) => ({
        pageNumber: p.pageNumber,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
      })),
      noiseSpans: v1Extracted.noiseSpans,
    });

    expect(resV1.verified).toBe(true);
    if (resV1.verified) {
      expect(resV1.pageStart).toBe(38);
    }

    // Verify v2 quote on v2
    const resV2 = verifyQuote({
      documentId: 'db_id_v2',
      candidateQuote: v2NoticeQuote,
      canonicalText: v2Extracted.text,
      pages: v2Extracted.pages.map((p) => ({
        pageNumber: p.pageNumber,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
      })),
      noiseSpans: v2Extracted.noiseSpans,
    });

    expect(resV2.verified).toBe(true);
    if (resV2.verified) {
      expect(resV2.pageStart).toBe(38);
    }

    // Cross-check: v1 quote MUST FAIL on v2
    const resV1Cross = verifyQuote({
      documentId: 'db_id_v2',
      candidateQuote: v1NoticeQuote,
      canonicalText: v2Extracted.text,
      pages: v2Extracted.pages.map((p) => ({
        pageNumber: p.pageNumber,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
      })),
      noiseSpans: v2Extracted.noiseSpans,
    });
    expect(resV1Cross.verified).toBe(false);

    // Cross-check: v2 quote MUST FAIL on v1
    const resV2Cross = verifyQuote({
      documentId: 'db_id_v1',
      candidateQuote: v2NoticeQuote,
      canonicalText: v1Extracted.text,
      pages: v1Extracted.pages.map((p) => ({
        pageNumber: p.pageNumber,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
      })),
      noiseSpans: v1Extracted.noiseSpans,
    });
    expect(resV2Cross.verified).toBe(false);
  });

  it('(c) Resolves candidate quotes with alias "DOC_1" and "DOC_2", verifying each quote against the correct document', async () => {
    const v1Path = path.join(process.cwd(), 'fixtures', 'large-contract-v1-150pages.pdf');
    const v2Path = path.join(process.cwd(), 'fixtures', 'large-contract-v2-150pages.pdf');

    const v1Extracted = await extractPdfText(await fs.readFile(v1Path));
    const v2Extracted = await extractPdfText(await fs.readFile(v2Path));

    const extractedMap: Record<string, typeof v1Extracted> = {
      db_id_v1: v1Extracted,
      db_id_v2: v2Extracted,
    };

    const candidateCitations = [
      { id: 1, doc: 'DOC_1', quote: "by providing thirty (30) days' written notice." },
      { id: 2, doc: 'Document B', quote: "by providing sixty (60) days' written notice." },
      { id: 3, doc: 'DOC_3', quote: 'some non-existent quote' },
    ];

    const verifiedResults: Array<{ id: number; docId: string; page: number }> = [];
    const unverifiedResults: Array<{ id: number; reason: string }> = [];

    for (const cand of candidateCitations) {
      const targetDoc = resolveDocumentFromAlias(cand.doc, mockDocList);
      if (!targetDoc) {
        unverifiedResults.push({ id: cand.id, reason: 'unknown document' });
        continue;
      }

      const docText = extractedMap[targetDoc.id];
      const vRes = verifyQuote({
        documentId: targetDoc.id,
        candidateQuote: cand.quote,
        canonicalText: docText.text,
        pages: docText.pages.map((p) => ({
          pageNumber: p.pageNumber,
          startOffset: p.startOffset,
          endOffset: p.endOffset,
        })),
        noiseSpans: docText.noiseSpans,
      });

      if (vRes.verified) {
        verifiedResults.push({ id: cand.id, docId: targetDoc.id, page: vRes.pageStart });
      } else {
        unverifiedResults.push({ id: cand.id, reason: vRes.reason || 'unverified' });
      }
    }

    expect(verifiedResults.length).toBe(2);
    expect(verifiedResults[0]).toEqual({ id: 1, docId: 'db_id_v1', page: 38 });
    expect(verifiedResults[1]).toEqual({ id: 2, docId: 'db_id_v2', page: 38 });

    expect(unverifiedResults.length).toBe(1);
    expect(unverifiedResults[0].id).toBe(3);
    expect(unverifiedResults[0].reason).toBe('unknown document');
  });
});
