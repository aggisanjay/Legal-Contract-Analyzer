import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../prisma';

export interface DocumentStorage {
  saveOriginalFile(documentId: string, filename: string, buffer: Buffer): Promise<string>;
  saveRenderedPdf(documentId: string, buffer: Buffer): Promise<string>;
  getOriginalFile(documentId: string): Promise<Buffer | null>;
  getRenderedPdf(documentId: string): Promise<Buffer | null>;
}

/**
 * Database-backed storage implementation with local filesystem cache.
 * Ensures document files and rendered PDFs persist across deployments (Vercel, Render)
 * where local filesystem is ephemeral or non-existent.
 */
export class DatabaseDocumentStorage implements DocumentStorage {
  private storageDir: string;

  constructor() {
    this.storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
  }

  async saveOriginalFile(documentId: string, filename: string, buffer: Buffer): Promise<string> {
    const uploadsDir = path.join(this.storageDir, 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    const diskPath = path.join(uploadsDir, filename);

    // Save to disk cache
    try {
      await fs.writeFile(diskPath, buffer);
    } catch (err) {
      console.warn('Could not write file to local disk cache, relying on DB bytes:', err);
    }

    // Save to database bytes column
    await prisma.document.update({
      where: { id: documentId },
      data: {
        fileData: buffer,
        originalFilePath: diskPath,
      },
    });

    return diskPath;
  }

  async saveRenderedPdf(documentId: string, buffer: Buffer): Promise<string> {
    const renderedDir = path.join(this.storageDir, 'rendered');
    await fs.mkdir(renderedDir, { recursive: true });
    const diskPath = path.join(renderedDir, `${documentId}.pdf`);

    // Save to disk cache
    try {
      await fs.writeFile(diskPath, buffer);
    } catch (err) {
      console.warn('Could not write rendered PDF to local disk cache, relying on DB bytes:', err);
    }

    // Save to database bytes column
    await prisma.document.update({
      where: { id: documentId },
      data: {
        renderedPdfData: buffer,
        renderedPdfPath: diskPath,
      },
    });

    return diskPath;
  }

  async getOriginalFile(documentId: string): Promise<Buffer | null> {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { originalFilePath: true, fileData: true },
    });

    if (!doc) return null;

    // First try DB bytes (serverless safe)
    if (doc.fileData && doc.fileData.length > 0) {
      return Buffer.from(doc.fileData);
    }

    // Fallback to disk if available
    if (doc.originalFilePath) {
      try {
        return await fs.readFile(doc.originalFilePath);
      } catch {
        // Disk file not found
      }
    }

    return null;
  }

  async getRenderedPdf(documentId: string): Promise<Buffer | null> {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { renderedPdfPath: true, renderedPdfData: true, fileData: true, originalFilePath: true, mimeType: true },
    });

    if (!doc) return null;

    // 1. Check renderedPdfData in DB
    if (doc.renderedPdfData && doc.renderedPdfData.length > 0) {
      return Buffer.from(doc.renderedPdfData);
    }

    // 2. Check disk renderedPdfPath
    if (doc.renderedPdfPath) {
      try {
        return await fs.readFile(doc.renderedPdfPath);
      } catch {
        // Disk file not found
      }
    }

    // 3. For PDF documents, original fileData or originalFilePath is the rendered PDF
    if (doc.mimeType === 'application/pdf') {
      if (doc.fileData && doc.fileData.length > 0) {
        return Buffer.from(doc.fileData);
      }
      if (doc.originalFilePath) {
        try {
          return await fs.readFile(doc.originalFilePath);
        } catch {}
      }
    }

    return null;
  }
}

export const documentStorage = new DatabaseDocumentStorage();
