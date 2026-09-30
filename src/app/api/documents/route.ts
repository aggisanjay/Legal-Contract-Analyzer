import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { processDocument, validateDocumentUpload } from '@/lib/documents/processor';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
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

    // Validate type and size
    const validation = validateDocumentUpload(filename, mimeType, size);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || 'Unsupported file type. Please upload a PDF or DOCX contract.' },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Process document
    const result = await processDocument({
      buffer,
      originalFilename: filename,
      mimeType,
      size,
    });

    return NextResponse.json({ document: result });
  } catch (err: unknown) {
    console.error('Upload processing error:', err);
    const msg = err instanceof Error ? err.message : 'Unable to process this document.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
