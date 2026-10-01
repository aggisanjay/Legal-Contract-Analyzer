import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { documentStorage } from '@/lib/documents/storage';
import { renderDocxToHtml } from '@/lib/documents/docx-extractor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: params.id },
      select: { mimeType: true, filename: true },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const origBuffer = await documentStorage.getOriginalFile(params.id);
    if (!origBuffer) {
      return NextResponse.json({ error: 'Original DOCX bytes not found' }, { status: 404 });
    }

    const html = await renderDocxToHtml(origBuffer);
    return NextResponse.json({ html });
  } catch (err: unknown) {
    console.error('Failed to render DOCX HTML:', err);
    return NextResponse.json({ error: 'Failed to convert DOCX to HTML' }, { status: 500 });
  }
}
