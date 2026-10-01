import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { extractPdfText } from '../src/lib/documents/pdf-extractor';

describe('Task 1: PDF Worker & Extraction in Serverless Environment', () => {
  it('extractPdfText loads fake worker internally and extracts valid non-empty text and correct page count without external globalThis setup', async () => {
    const pdfPath = path.join(process.cwd(), 'fixtures', 'test-contract.pdf');
    const pdfBuffer = await fs.readFile(pdfPath);

    const result = await extractPdfText(pdfBuffer);

    expect(result.text).toBeDefined();
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.pageCount).toBe(2);
    expect(result.isScannedOrEmpty).toBe(false);
    expect(result.pages.length).toBe(result.pageCount);
  });
});
