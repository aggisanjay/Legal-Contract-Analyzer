import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
        processingStage: true,
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

    const stage = doc.processingStage || (doc.status === 'READY' ? 'Ready' : 'Uploading');
    let progress = 15;
    if (doc.status === 'READY' || stage === 'Ready') {
      progress = 100;
    } else if (doc.status === 'FAILED') {
      progress = 100;
    } else if (stage === 'Indexing') {
      progress = 85;
    } else if (stage === 'Splitting into sections') {
      progress = 70;
    } else if (stage === 'Extracting text') {
      progress = 40;
    } else if (stage === 'Uploading') {
      progress = 15;
    }

    return NextResponse.json({
      status: doc.status,
      stage,
      progress,
      message: doc.statusMessage || stage,
      pageCount: doc.pageCount,
      chunksCount: doc._count.chunks,
    });
  } catch (err: unknown) {
    console.error('Failed to get document status:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
