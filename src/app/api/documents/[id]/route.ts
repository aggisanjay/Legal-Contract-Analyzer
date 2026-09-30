import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: params.id },
      include: {
        chunks: {
          select: {
            id: true,
            chunkIndex: true,
            pageStart: true,
            pageEnd: true,
            startOffset: true,
            endOffset: true,
            sectionNumber: true,
            sectionTitle: true,
            text: true,
          },
          orderBy: { chunkIndex: 'asc' },
        },
      },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    return NextResponse.json({ document: doc });
  } catch (err: unknown) {
    console.error('Failed to get document:', err);
    return NextResponse.json({ error: 'Failed to retrieve document' }, { status: 500 });
  }
}

export async function DELETE(
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

    // 1. Delete physical files from disk
    if (doc.originalFilePath) {
      await fs.unlink(doc.originalFilePath).catch(() => {});
    }
    if (doc.renderedPdfPath && doc.renderedPdfPath !== doc.originalFilePath) {
      await fs.unlink(doc.renderedPdfPath).catch(() => {});
    }

    // 2. Cascade delete database records
    await prisma.document.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ success: true, deletedId: params.id });
  } catch (err: unknown) {
    console.error('Failed to delete document:', err);
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
  }
}
