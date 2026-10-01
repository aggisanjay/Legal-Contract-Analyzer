import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../prisma';
import { extractPdfText } from './pdf-extractor';
import { extractDocxTextAndRenderPdf } from './docx-extractor';
import { chunkDocument } from './chunker';
import { getEmbeddingProvider } from '../ai/embeddings';
import { documentStorage } from './storage';
import { DocumentMetadata, ExtractedDocument } from '../types';
import { mapDocumentError } from './error-mapper';

const MAX_FILE_SIZE_DEFAULT = 50 * 1024 * 1024; // 50 MB

export interface ProcessDocumentOptions {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  size: number;
}

/**
 * Validates file format and size, including magic bytes verification (%PDF / PK zip).
 */
export function validateDocumentUpload(
  filename: string,
  mimeType: string,
  size: number,
  buffer?: Buffer
): { valid: boolean; error?: string } {
  const maxBytes = (parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10) || 50) * 1024 * 1024;

  if (size > maxBytes) {
    return {
      valid: false,
      error: `File size exceeds the maximum limit of ${maxBytes / (1024 * 1024)} MB.`,
    };
  }

  const ext = path.extname(filename).toLowerCase();
  const validExtensions = ['.pdf', '.docx'];

  if (!validExtensions.includes(ext)) {
    return {
      valid: false,
      error: 'Unsupported file type. Please upload a PDF or DOCX.',
    };
  }

  // Validate magic bytes if buffer is available
  if (buffer && buffer.length >= 4) {
    const isPdfMagic =
      buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
    const isZipMagic = buffer[0] === 0x50 && buffer[1] === 0x4b; // PK

    if (ext === '.pdf' && !isPdfMagic) {
      return {
        valid: false,
        error: 'Unsupported file type. Please upload a PDF or DOCX.',
      };
    }

    if (ext === '.docx' && !isZipMagic) {
      return {
        valid: false,
        error: 'Unsupported file type. Please upload a PDF or DOCX.',
      };
    }
  }

  return { valid: true };
}

/**
 * Executes background processing pipeline across clear stages:
 * Uploading -> Extracting text -> Splitting into sections -> Indexing -> Ready
 */
export async function processDocumentInBackground(
  documentId: string,
  buffer?: Buffer,
  originalFilename?: string,
  mimeType?: string
): Promise<void> {
  const storageBase = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
  const renderedDir = path.join(storageBase, 'rendered');

  try {
    // If buffer is missing (e.g. retry request), load from storage
    if (!buffer || buffer.length === 0) {
      const stored = await documentStorage.getOriginalFile(documentId);
      if (!stored || stored.length === 0) {
        throw new Error('Original file bytes not found in storage.');
      }
      buffer = stored;
    }

    if (!originalFilename || !mimeType) {
      const docRecord = await prisma.document.findUnique({
        where: { id: documentId },
        select: { originalFilename: true, mimeType: true },
      });
      if (docRecord) {
        originalFilename = originalFilename || docRecord.originalFilename;
        mimeType = mimeType || docRecord.mimeType;
      }
    }

    const ext = path.extname(originalFilename || '').toLowerCase();

    // Stage 1: Persist file bytes in database and disk cache
    await documentStorage.saveOriginalFile(documentId, originalFilename || `${documentId}.bin`, buffer);

    // Stage 2: Extracting text
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'PROCESSING',
        processingStage: 'Extracting text',
        statusMessage: 'Extracting text and identifying document structure...',
      },
    });

    let extracted: ExtractedDocument;
    let isScannedOrEmpty = false;
    let renderedPdfPath: string | null = null;
    let renderedPdfBuffer: Buffer | undefined;

    if (ext === '.pdf') {
      const pdfRes = await extractPdfText(buffer);
      extracted = pdfRes;
      isScannedOrEmpty = pdfRes.isScannedOrEmpty;
      renderedPdfBuffer = buffer; // Original PDF is the rendered PDF
    } else if (ext === '.docx') {
      const docxRes = await extractDocxTextAndRenderPdf(buffer, documentId, renderedDir);
      extracted = docxRes;
      isScannedOrEmpty = docxRes.isScannedOrEmpty;
      renderedPdfPath = docxRes.renderedPdfPath;
      renderedPdfBuffer = docxRes.renderedPdfBuffer;
    } else {
      throw new Error('Unsupported file type. Please upload a PDF or DOCX.');
    }

    // Check for empty or scanned documents
    if (isScannedOrEmpty || !extracted.text || extracted.text.trim().length === 0) {
      const mapped = mapDocumentError(new Error('Scanned or empty document'), true, mimeType || 'application/pdf');
      console.warn(`[Doc ${documentId}] Scanned/empty file detected: ${mapped.userMessage}`);
      await prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          processingStage: 'Ready',
          statusMessage: mapped.userMessage,
          errorDetail: mapped.errorDetail,
          pageCount: extracted?.pageCount || 0,
        },
      });
      return;
    }

    // Stage 3: Splitting into sections
    await prisma.document.update({
      where: { id: documentId },
      data: {
        processingStage: 'Splitting into sections',
        statusMessage: 'Analyzing clauses and splitting into legal sections...',
        pageCount: extracted.pageCount,
      },
    });

    const chunkResults = chunkDocument(extracted);

    // Stage 4: Indexing (Generate Embeddings)
    await prisma.document.update({
      where: { id: documentId },
      data: {
        processingStage: 'Indexing',
        statusMessage: 'Generating search indexes and vector representations...',
      },
    });

    const embeddingProvider = getEmbeddingProvider();
    const textsToEmbed = chunkResults.map((c) => c.text);
    const embeddings = await embeddingProvider.generateBatchEmbeddings(textsToEmbed);

    // Save rendered PDF bytes to DB storage
    if (renderedPdfBuffer) {
      await documentStorage.saveRenderedPdf(documentId, renderedPdfBuffer);
    }

    // Clear any previous chunks if retrying
    await prisma.documentChunk.deleteMany({
      where: { documentId },
    });

    // Save chunks to database
    await prisma.documentChunk.createMany({
      data: chunkResults.map((chunk, idx) => ({
        documentId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        embedding: JSON.stringify(embeddings[idx] || []),
        sectionNumber: chunk.sectionNumber,
        sectionTitle: chunk.sectionTitle,
      })),
    });

    // Stage 5: Ready
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: 'READY',
        processingStage: 'Ready',
        statusMessage: 'Ready',
        errorDetail: null,
        extractedText: extracted.text,
        pageCount: extracted.pageCount,
        pagesJson: extracted.pages.map((p) => ({
          pageNumber: p.pageNumber,
          startOffset: p.startOffset,
          endOffset: p.endOffset,
        })),
        renderedPdfPath,
      },
    });
  } catch (err: unknown) {
    const mapped = mapDocumentError(err, false, mimeType || 'application/pdf');
    console.error(`[Doc ${documentId}] Processing failed:`, err);
    await prisma.document
      .update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          statusMessage: mapped.userMessage,
          errorDetail: mapped.errorDetail,
          processingStage: 'Ready',
        },
      })
      .catch(() => {});
  }
}

/**
 * Synchronous/async entry point for processing document.
 */
export async function processDocument(
  options: ProcessDocumentOptions
): Promise<DocumentMetadata> {
  const { buffer, originalFilename, mimeType, size } = options;

  const validation = validateDocumentUpload(originalFilename, mimeType, size, buffer);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid document file.');
  }

  const ext = path.extname(originalFilename).toLowerCase();
  const safeBaseName = path.basename(originalFilename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const storedFilename = `${safeBaseName}_${fileId}${ext}`;

  // Create initial document record with Uploading stage
  const doc = await prisma.document.create({
    data: {
      filename: storedFilename,
      originalFilename,
      mimeType,
      size,
      status: 'PROCESSING',
      processingStage: 'Uploading',
      statusMessage: 'Uploading and preparing document...',
      originalFilePath: '',
      fileData: buffer,
    },
  });

  // Execute processing
  await processDocumentInBackground(doc.id, buffer, originalFilename, mimeType);

  const updated = await prisma.document.findUnique({ where: { id: doc.id } });
  if (!updated) {
    throw new Error('Failed to retrieve processed document');
  }

  return {
    id: updated.id,
    filename: updated.filename,
    originalFilename: updated.originalFilename,
    mimeType: updated.mimeType,
    size: updated.size,
    status: updated.status,
    statusMessage: updated.statusMessage,
    pageCount: updated.pageCount,
    originalFilePath: updated.originalFilePath,
    renderedPdfPath: updated.renderedPdfPath,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}
