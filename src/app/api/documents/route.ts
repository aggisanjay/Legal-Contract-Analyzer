import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { prisma } from '@/lib/prisma';
import {
  processDocumentInBackground,
  validateDocumentUpload,
} from '@/lib/documents/processor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET() {
  try {
    // On library load, mark documents stuck in PROCESSING for > 10 minutes as FAILED
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.document.updateMany({
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: tenMinutesAgo },
      },
      data: {
        status: 'FAILED',
        statusMessage: 'Processing was interrupted. Please upload again.',
      },
    });

    const documents = await prisma.document.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { chunks: true, conversations: true },
        },
      },
    });

    const mapped = documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      originalFilename: doc.originalFilename,
      mimeType: doc.mimeType,
      size: doc.size,
      status: doc.status,
      processingStage: doc.processingStage,
      statusMessage: doc.statusMessage,
      pageCount: doc.pageCount,
      originalFilePath: doc.originalFilePath,
      renderedPdfPath: doc.renderedPdfPath,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
      chunksCount: doc._count.chunks,
    }));

    return NextResponse.json({ documents: mapped });
  } catch (err: unknown) {
    console.error('Failed to list documents:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve documents' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const filename = file.name;
    const mimeType = file.type || 'application/octet-stream';
    const size = file.size;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate type, size, and magic bytes
    const validation = validateDocumentUpload(filename, mimeType, size, buffer);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || 'Unsupported file type. Please upload a PDF or DOCX.' },
        { status: 400 }
      );
    }

    const ext = path.extname(filename).toLowerCase();
    const safeBaseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const storedFilename = `${safeBaseName}_${fileId}${ext}`;

    // Create initial document record with status PROCESSING and stage Uploading
    const doc = await prisma.document.create({
      data: {
        filename: storedFilename,
        originalFilename: filename,
        mimeType,
        size,
        status: 'PROCESSING',
        processingStage: 'Uploading',
        statusMessage: 'Uploading file and preparing processing...',
        originalFilePath: '',
        fileData: buffer,
      },
    });

    // Fire-and-forget background processing pipeline
    // Next.js execution continues asynchronously
    processDocumentInBackground(doc.id, buffer, filename, mimeType).catch((err) => {
      console.error(`Background processing failed for ${doc.id}:`, err);
    });

    // Return immediately with { id, status: "PROCESSING" }
    return NextResponse.json(
      {
        id: doc.id,
        status: 'PROCESSING',
        stage: 'Uploading',
        progress: 15,
        message: 'Uploading file and preparing processing...',
      },
      { status: 202 }
    );
  } catch (err: unknown) {
    console.error('Upload route error:', err);
    const msg = err instanceof Error ? err.message : 'Unable to upload this document.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
