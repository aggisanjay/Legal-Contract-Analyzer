import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { documentStorage } from '@/lib/documents/storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: params.id },
      select: { filename: true, mimeType: true },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const fileBuffer = await documentStorage.getRenderedPdf(params.id);
    if (fileBuffer) {
      return new NextResponse(new Uint8Array(fileBuffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${doc.filename}.pdf"`,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // Try original file if not converted
    const origBuffer = await documentStorage.getOriginalFile(params.id);
    if (origBuffer) {
      return new NextResponse(new Uint8Array(origBuffer), {
        headers: {
          'Content-Type': doc.mimeType || 'application/octet-stream',
          'Content-Disposition': `inline; filename="${doc.filename}"`,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    return NextResponse.json({ error: 'Document file bytes not found' }, { status: 404 });
  } catch (err: unknown) {
    console.error('Failed to serve document file:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
