import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../prisma';
import { extractPdfText } from './pdf-extractor';
import { extractDocxTextAndRenderPdf } from './docx-extractor';
import { chunkDocument } from './chunker';
import { getEmbeddingProvider } from '../ai/embeddings';
import { DocumentMetadata, ExtractedDocument } from '../types';

const MAX_FILE_SIZE_DEFAULT = 50 * 1024 * 1024; // 50 MB

export interface ProcessDocumentOptions {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  size: number;
}

/**
 * Validates file format and size.
 */
export function validateDocumentUpload(
  filename: string,
  mimeType: string,
  size: number
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
  const validMimes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream', // Some browsers / test runners send octet-stream for docx
  ];

  if (!validExtensions.includes(ext)) {
    return {
      valid: false,
      error: 'Unsupported file type. Please upload a PDF or DOCX contract.',
    };
  }

  if (mimeType && !validMimes.includes(mimeType) && !validExtensions.includes(ext)) {
    return {
      valid: false,
      error: 'Unsupported file type. Please upload a PDF or DOCX contract.',
    };
  }

  return { valid: true };
}

/**
 * Complete document processing pipeline.
 */
export async function processDocument(
  options: ProcessDocumentOptions
): Promise<DocumentMetadata> {
  const { buffer, originalFilename, mimeType, size } = options;

  // Step 1: Validation
  const validation = validateDocumentUpload(originalFilename, mimeType, size);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid document file.');
  }

  const storageBase = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
  const uploadsDir = path.join(storageBase, 'uploads');
  const renderedDir = path.join(storageBase, 'rendered');

  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(renderedDir, { recursive: true });

  const ext = path.extname(originalFilename).toLowerCase();
  const safeBaseName = path.basename(originalFilename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const storedFilename = `${safeBaseName}_${fileId}${ext}`;
  const originalFilePath = path.join(uploadsDir, storedFilename);

  // Save original file to disk
  await fs.writeFile(originalFilePath, buffer);

  // Step 2: Create Initial Document Record in Database (Status: PROCESSING)
  const doc = await prisma.document.create({
    data: {
      filename: storedFilename,
      originalFilename,
      mimeType,
      size,
      status: 'PROCESSING',
      statusMessage: 'Extracting text and analyzing document structure...',
      originalFilePath,
    },
  });

  try {
    let extracted: ExtractedDocument;
    let renderedPdfPath: string | null = null;
    let isScannedOrEmpty = false;

    // Step 3: Text Extraction
    if (ext === '.pdf') {
      const pdfRes = await extractPdfText(buffer);
      extracted = pdfRes;
      isScannedOrEmpty = pdfRes.isScannedOrEmpty;
      // For PDF, the original PDF itself is rendered for the viewer
      renderedPdfPath = originalFilePath;
    } else if (ext === '.docx') {
      const docxRes = await extractDocxTextAndRenderPdf(buffer, doc.id, renderedDir);
      extracted = docxRes;
      isScannedOrEmpty = docxRes.isScannedOrEmpty;
      renderedPdfPath = docxRes.renderedPdfPath;
    } else {
      throw new Error('Unsupported file type. Please upload a PDF or DOCX contract.');
    }

    // Step 4: Detect empty or scanned PDF
    if (isScannedOrEmpty || !extracted.text || extracted.text.trim().length === 0) {
      const failMessage =
        'This PDF appears to be scanned or contains no readable text. Please upload a text-based PDF or DOCX.';
      await prisma.document.update({
        where: { id: doc.id },
        data: {
          status: 'FAILED',
          statusMessage: failMessage,
          pageCount: extracted?.pageCount || 0,
        },
      });

      return {
        id: doc.id,
        filename: doc.filename,
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        size: doc.size,
        status: 'FAILED',
        statusMessage: failMessage,
        pageCount: extracted?.pageCount || 0,
        originalFilePath: doc.originalFilePath,
        renderedPdfPath,
        createdAt: doc.createdAt,
        updatedAt: new Date(),
      };
    }

    // Step 5: Split into legal-aware chunks
    const chunkResults = chunkDocument(extracted);

    // Step 6: Generate Embeddings
    const embeddingProvider = getEmbeddingProvider();
    const textsToEmbed = chunkResults.map((c) => c.text);
    const embeddings = await embeddingProvider.generateBatchEmbeddings(textsToEmbed);

    // Step 7: Store chunks in Database
    await prisma.documentChunk.createMany({
      data: chunkResults.map((chunk, idx) => ({
        documentId: doc.id,
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

    // Step 8: Update Document to READY
    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'READY',
        statusMessage: 'Ready',
        extractedText: extracted.text,
        pageCount: extracted.pageCount,
        renderedPdfPath,
      },
    });

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
      chunksCount: chunkResults.length,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unable to process this document.';
    await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'FAILED',
        statusMessage: errorMsg,
      },
    }).catch(() => {});

    throw err;
  }
}
