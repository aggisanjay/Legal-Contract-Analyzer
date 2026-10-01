import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../prisma';

export type StorageType = 'original' | 'rendered';

export interface StorageProvider {
  saveOriginal(documentId: string, filename: string, buffer: Buffer): Promise<string>;
  saveOriginalFile(documentId: string, filename: string, buffer: Buffer): Promise<string>;
  saveRenderedPdf(documentId: string, buffer: Buffer): Promise<string>;
  readOriginal(documentId: string): Promise<Buffer | null>;
  getOriginalFile(documentId: string): Promise<Buffer | null>;
  readRenderedPdf(documentId: string): Promise<Buffer | null>;
  getRenderedPdf(documentId: string): Promise<Buffer | null>;
  delete(documentId: string): Promise<void>;
  // Generic interface methods
  save(documentId: string, type: StorageType, buffer: Buffer, filename?: string): Promise<string>;
  read(documentId: string, type: StorageType): Promise<Buffer | null>;
}

/**
 * Database-backed storage provider (default on Vercel / serverless).
 * Persists files directly into PostgreSQL Bytes columns (fileData, renderedPdfData).
 */
export class DatabaseStorageProvider implements StorageProvider {
  private storageDir: string;

  constructor() {
    this.storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
  }

  async saveOriginal(documentId: string, filename: string, buffer: Buffer): Promise<string> {
    return this.save(documentId, 'original', buffer, filename);
  }

  async saveOriginalFile(documentId: string, filename: string, buffer: Buffer): Promise<string> {
    return this.saveOriginal(documentId, filename, buffer);
  }

  async saveRenderedPdf(documentId: string, buffer: Buffer): Promise<string> {
    return this.save(documentId, 'rendered', buffer);
  }

  async readOriginal(documentId: string): Promise<Buffer | null> {
    return this.read(documentId, 'original');
  }

  async getOriginalFile(documentId: string): Promise<Buffer | null> {
    return this.readOriginal(documentId);
  }

  async readRenderedPdf(documentId: string): Promise<Buffer | null> {
    return this.read(documentId, 'rendered');
  }

  async getRenderedPdf(documentId: string): Promise<Buffer | null> {
    return this.readRenderedPdf(documentId);
  }

  async save(documentId: string, type: StorageType, buffer: Buffer, filename?: string): Promise<string> {
    const isOriginal = type === 'original';
    const diskDir = path.join(this.storageDir, isOriginal ? 'uploads' : 'rendered');
    const diskFilename = isOriginal ? (filename || `${documentId}.bin`) : `${documentId}.pdf`;
    const diskPath = path.join(diskDir, diskFilename);

    // Optional opportunistic local cache write (safely ignored if ephemeral / read-only filesystem)
    try {
      await fs.mkdir(diskDir, { recursive: true });
      await fs.writeFile(diskPath, buffer);
    } catch {
      // Ignore filesystem cache errors in serverless environments
    }

    // Persist directly into PostgreSQL
    if (isOriginal) {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          fileData: buffer,
          originalFilePath: diskPath,
        },
      });
    } else {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          renderedPdfData: buffer,
          renderedPdfPath: diskPath,
        },
      });
    }

    return diskPath;
  }

  async read(documentId: string, type: StorageType): Promise<Buffer | null> {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        fileData: true,
        renderedPdfData: true,
        originalFilePath: true,
        renderedPdfPath: true,
        mimeType: true,
      },
    });

    if (!doc) return null;

    if (type === 'original') {
      if (doc.fileData && doc.fileData.length > 0) {
        return Buffer.from(doc.fileData);
      }
      if (doc.originalFilePath) {
        try {
          return await fs.readFile(doc.originalFilePath);
        } catch {}
      }
      return null;
    }

    // Rendered PDF
    if (doc.renderedPdfData && doc.renderedPdfData.length > 0) {
      return Buffer.from(doc.renderedPdfData);
    }
    if (doc.renderedPdfPath) {
      try {
        return await fs.readFile(doc.renderedPdfPath);
      } catch {}
    }
    // For original PDF documents, original fileData is the rendered PDF
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

  async delete(documentId: string): Promise<void> {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { originalFilePath: true, renderedPdfPath: true },
    });

    if (doc) {
      if (doc.originalFilePath) {
        try {
          await fs.unlink(doc.originalFilePath);
        } catch {}
      }
      if (doc.renderedPdfPath && doc.renderedPdfPath !== doc.originalFilePath) {
        try {
          await fs.unlink(doc.renderedPdfPath);
        } catch {}
      }
    }

    // Clear byte columns in database
    await prisma.document.update({
      where: { id: documentId },
      data: {
        fileData: null,
        renderedPdfData: null,
      },
    }).catch(() => {});
  }
}

/**
 * Local filesystem storage provider (used only when STORAGE_DRIVER=local).
 */
export class LocalStorageProvider implements StorageProvider {
  private storageDir: string;

  constructor() {
    this.storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), 'storage');
  }

  async saveOriginal(documentId: string, filename: string, buffer: Buffer): Promise<string> {
    return this.save(documentId, 'original', buffer, filename);
  }

  async saveOriginalFile(documentId: string, filename: string, buffer: Buffer): Promise<string> {
    return this.saveOriginal(documentId, filename, buffer);
  }

  async saveRenderedPdf(documentId: string, buffer: Buffer): Promise<string> {
    return this.save(documentId, 'rendered', buffer);
  }

  async readOriginal(documentId: string): Promise<Buffer | null> {
    return this.read(documentId, 'original');
  }

  async getOriginalFile(documentId: string): Promise<Buffer | null> {
    return this.readOriginal(documentId);
  }

  async readRenderedPdf(documentId: string): Promise<Buffer | null> {
    return this.read(documentId, 'rendered');
  }

  async getRenderedPdf(documentId: string): Promise<Buffer | null> {
    return this.readRenderedPdf(documentId);
  }

  async save(documentId: string, type: StorageType, buffer: Buffer, filename?: string): Promise<string> {
    const isOriginal = type === 'original';
    const diskDir = path.join(this.storageDir, isOriginal ? 'uploads' : 'rendered');
    const diskFilename = isOriginal ? (filename || `${documentId}.bin`) : `${documentId}.pdf`;
    const diskPath = path.join(diskDir, diskFilename);

    await fs.mkdir(diskDir, { recursive: true });
    await fs.writeFile(diskPath, buffer);

    if (isOriginal) {
      await prisma.document.update({
        where: { id: documentId },
        data: { originalFilePath: diskPath },
      });
    } else {
      await prisma.document.update({
        where: { id: documentId },
        data: { renderedPdfPath: diskPath },
      });
    }

    return diskPath;
  }

  async read(documentId: string, type: StorageType): Promise<Buffer | null> {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { originalFilePath: true, renderedPdfPath: true, mimeType: true },
    });

    if (!doc) return null;

    if (type === 'original') {
      if (doc.originalFilePath) {
        try {
          return await fs.readFile(doc.originalFilePath);
        } catch {}
      }
      return null;
    }

    // Rendered PDF
    if (doc.renderedPdfPath) {
      try {
        return await fs.readFile(doc.renderedPdfPath);
      } catch {}
    }
    if (doc.mimeType === 'application/pdf' && doc.originalFilePath) {
      try {
        return await fs.readFile(doc.originalFilePath);
      } catch {}
    }

    return null;
  }

  async delete(documentId: string): Promise<void> {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { originalFilePath: true, renderedPdfPath: true },
    });

    if (doc) {
      if (doc.originalFilePath) {
        try {
          await fs.unlink(doc.originalFilePath);
        } catch {}
      }
      if (doc.renderedPdfPath && doc.renderedPdfPath !== doc.originalFilePath) {
        try {
          await fs.unlink(doc.renderedPdfPath);
        } catch {}
      }
    }
  }
}

/**
 * Returns the configured storage provider.
 * Defaults to DatabaseStorageProvider for serverless resilience unless STORAGE_DRIVER=local.
 */
export function getStorageProvider(): StorageProvider {
  if (process.env.STORAGE_DRIVER?.toLowerCase() === 'local') {
    return new LocalStorageProvider();
  }
  return new DatabaseStorageProvider();
}

export const storage = getStorageProvider();
