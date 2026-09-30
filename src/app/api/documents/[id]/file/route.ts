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
      select: { originalFilePath: true, renderedPdfPath: true, mimeType: true, filename: true },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const filePath = doc.renderedPdfPath || doc.originalFilePath;
    try {
      const fileBuffer = await fs.readFile(filePath);
      return new NextResponse(fileBuffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${doc.filename}.pdf"`,
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch {
      return NextResponse.json({ error: 'Physical document file not found on disk' }, { status: 404 });
    }
  } catch (err: unknown) {
    console.error('Failed to serve document file:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
