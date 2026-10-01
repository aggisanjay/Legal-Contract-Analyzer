import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { processDocumentInBackground } from '@/lib/documents/processor';
import { documentStorage } from '@/lib/documents/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: params.id },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    if (doc.status === 'READY') {
      return NextResponse.json({
        id: doc.id,
        status: 'READY',
        message: 'Document already processed and ready.',
      });
    }

    // Retrieve original file buffer from storage
    const buffer = await documentStorage.getOriginalFile(doc.id);
    if (!buffer || buffer.length === 0) {
      await prisma.document.update({
        where: { id: doc.id },
        data: {
          status: 'FAILED',
          statusMessage: "We couldn't read this file. Try uploading it again, or use a different PDF.",
          errorDetail: 'Original file buffer was empty or missing in storage',
          processingStage: 'Ready',
        },
      });
      return NextResponse.json(
        { error: 'Original document file bytes not found in storage.' },
        { status: 400 }
      );
    }

    // Mark as PROCESSING and reset error states
    await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: 'PROCESSING',
        processingStage: 'Extracting text',
        statusMessage: 'Extracting text and identifying document structure...',
        errorDetail: null,
      },
    });

    // Run processing within the 60-second serverless execution window
    await processDocumentInBackground(doc.id, buffer, doc.originalFilename, doc.mimeType);

    const updated = await prisma.document.findUnique({
      where: { id: doc.id },
      select: {
        id: true,
        status: true,
        processingStage: true,
        statusMessage: true,
        pageCount: true,
      },
    });

    return NextResponse.json({
      success: true,
      document: updated,
    });
  } catch (err: unknown) {
    console.error(`Process route failed for document ${params.id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Processing failed' },
      { status: 500 }
    );
  }
}
