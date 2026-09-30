import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        status: true,
        statusMessage: true,
        pageCount: true,
        _count: {
          select: { chunks: true },
        },
      },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    return NextResponse.json({
      status: doc.status,
      statusMessage: doc.statusMessage,
      pageCount: doc.pageCount,
      chunksCount: doc._count.chunks,
    });
  } catch (err: unknown) {
    console.error('Failed to get document status:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
