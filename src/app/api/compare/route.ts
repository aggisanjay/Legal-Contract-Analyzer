import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { compareContracts } from '@/lib/compare/comparison-engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { documentAId, documentBId } = body;

    if (!documentAId || !documentBId) {
      return NextResponse.json(
        { error: 'Both documentAId and documentBId are required.' },
        { status: 400 }
      );
    }

    if (documentAId === documentBId) {
      return NextResponse.json(
        { error: 'Please select two different contracts or versions to compare.' },
        { status: 400 }
      );
    }

    const result = await compareContracts(documentAId, documentBId);

    return NextResponse.json({ comparison: result });
  } catch (err: unknown) {
    console.error('Contract comparison failed:', err);
    const msg = err instanceof Error ? err.message : 'Failed to compare contracts.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const documentId = searchParams.get('documentId');

    const comparisons = await prisma.comparison.findMany({
      where: documentId
        ? {
            OR: [{ documentAId: documentId }, { documentBId: documentId }],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    return NextResponse.json({ comparisons });
  } catch (err: unknown) {
    console.error('Failed to get comparisons:', err);
    return NextResponse.json({ error: 'Failed to retrieve comparisons' }, { status: 500 });
  }
}
