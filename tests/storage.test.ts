import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { prisma } from '../src/lib/prisma';
import { DatabaseStorageProvider, LocalStorageProvider, getStorageProvider } from '../src/lib/storage';
import { mapDocumentError } from '../src/lib/documents/error-mapper';

describe('Task 3: Serverless Storage (Database & Local) & Error Mapping', () => {
  let testDocId: string;
  const sampleBytes = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Title (Test Legal Contract) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF',
    'utf-8'
  );

  beforeAll(async () => {
    // Create temporary document in database
    const doc = await prisma.document.create({
      data: {
        filename: 'storage_test_contract.pdf',
        originalFilename: 'storage_test_contract.pdf',
        mimeType: 'application/pdf',
        size: sampleBytes.length,
        status: 'PROCESSING',
        processingStage: 'Uploading',
        originalFilePath: '',
      },
    });
    testDocId = doc.id;
  });

  afterAll(async () => {
    if (testDocId) {
      await prisma.document.delete({ where: { id: testDocId } }).catch(() => {});
    }
  });

  it('DatabaseStorageProvider persists and reads back identical bytes', async () => {
    const dbStorage = new DatabaseStorageProvider();

    // 1. Save original file
    await dbStorage.saveOriginal(testDocId, 'storage_test_contract.pdf', sampleBytes);

    // 2. Read back in fresh call
    const retrievedBytes = await dbStorage.readOriginal(testDocId);
    expect(retrievedBytes).not.toBeNull();
    expect(Buffer.compare(sampleBytes, retrievedBytes!)).toBe(0);

    // 3. Save rendered PDF
    const renderedBytes = Buffer.from('%PDF-1.4 Rendered PDF bytes for testing', 'utf-8');
    await dbStorage.saveRenderedPdf(testDocId, renderedBytes);

    const retrievedRendered = await dbStorage.readRenderedPdf(testDocId);
    expect(retrievedRendered).not.toBeNull();
    expect(Buffer.compare(renderedBytes, retrievedRendered!)).toBe(0);

    // 4. Delete clears stored bytes
    await dbStorage.delete(testDocId);
    const afterDeleteOriginal = await dbStorage.readOriginal(testDocId);
    expect(afterDeleteOriginal).toBeNull();
  });

  it('LocalStorageProvider saves, reads identical bytes, and deletes', async () => {
    const localStorage = new LocalStorageProvider();
    const testBytes = crypto.randomBytes(1024);

    await localStorage.saveOriginal(testDocId, 'local_test.pdf', testBytes);
    const retrieved = await localStorage.readOriginal(testDocId);
    expect(retrieved).not.toBeNull();
    expect(Buffer.compare(testBytes, retrieved!)).toBe(0);

    await localStorage.delete(testDocId);
  });

  it('Default storage provider is DatabaseStorageProvider unless STORAGE_DRIVER=local', () => {
    const originalEnv = process.env.STORAGE_DRIVER;
    delete process.env.STORAGE_DRIVER;

    const defaultProvider = getStorageProvider();
    expect(defaultProvider).toBeInstanceOf(DatabaseStorageProvider);

    process.env.STORAGE_DRIVER = 'local';
    const localProvider = getStorageProvider();
    expect(localProvider).toBeInstanceOf(LocalStorageProvider);

    process.env.STORAGE_DRIVER = originalEnv;
  });

  it('Friendly error mapper hides raw stack traces and internal Require stack text', () => {
    const rawError = new Error(
      'Setting up fake worker failed: "Cannot find module \'./pdf.worker.js\' Require stack: /var/task/node_modules/pdfjs-dist/legacy/build/pdf.js ..."'
    );

    const mapped = mapDocumentError(rawError, false, 'application/pdf');

    // Never shows raw stack text or "Require stack" in the UI
    expect(mapped.userMessage).not.toContain('Require stack');
    expect(mapped.userMessage).not.toContain('/var/task');
    expect(mapped.userMessage).not.toContain('Cannot find module');
    expect(mapped.userMessage).toBe("We couldn't read this file. Try uploading it again, or use a different PDF.");

    // Server-side error detail preserves the technical info for logging
    expect(mapped.errorDetail).toContain('Require stack');

    // Scanned PDF specific error
    const scannedMapped = mapDocumentError(new Error('Empty text'), true, 'application/pdf');
    expect(scannedMapped.userMessage).toBe(
      'This PDF has no readable text (it looks scanned). OCR is not supported yet.'
    );
  });
});
