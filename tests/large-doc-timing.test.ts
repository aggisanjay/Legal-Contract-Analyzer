import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { processDocument } from '../src/lib/documents/processor';
import { prisma } from '../src/lib/prisma';

describe('Task 2: 150-Page Document Processing Under 60 Seconds', () => {
  it('processes large-contract-v1-150pages.pdf within 60 seconds', async () => {
    const fixturePath = path.join(process.cwd(), 'fixtures', 'large-contract-v1-150pages.pdf');
    const buffer = await fs.readFile(fixturePath);

    const startTime = Date.now();
    const doc = await processDocument({
      buffer,
      originalFilename: 'large-contract-v1-150pages.pdf',
      mimeType: 'application/pdf',
      size: buffer.length,
    });
    const durationMs = Date.now() - startTime;
    const durationSec = (durationMs / 1000).toFixed(2);

    console.log(`[TIMING] 150-page document processing completed in ${durationSec}s (${durationMs}ms)`);

    expect(durationMs).toBeLessThan(60000); // Must be strictly within 60s serverless timeout
    expect(doc.status).toBe('READY');
    expect(doc.pageCount).toBe(150);

    // Verify chunks were created
    const chunkCount = await prisma.documentChunk.count({
      where: { documentId: doc.id },
    });
    expect(chunkCount).toBeGreaterThan(0);

    // Clean up
    await prisma.document.delete({ where: { id: doc.id } });
  }, 90000); // Vitest test timeout 90s
});
