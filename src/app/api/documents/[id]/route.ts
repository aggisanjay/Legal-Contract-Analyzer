import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { documentStorage } from '@/lib/documents/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

    // 1. Delete stored bytes and cached files via storage interface
    await documentStorage.delete(params.id);

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
