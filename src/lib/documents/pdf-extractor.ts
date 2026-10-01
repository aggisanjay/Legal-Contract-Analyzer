import { ExtractedDocument, ExtractedPage } from '../types';

/**
 * Extracts text and page boundaries from a PDF Buffer using pdfjs-dist.
 * Preserves page offsets, section markers, and detects empty/scanned PDFs.
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<ExtractedDocument & { isScannedOrEmpty: boolean }> {
  // Dynamically import pdfjs worker and library for reliable serverless Node.js execution
  // @ts-ignore - worker module lacks ambient types in legacy build
  const pdfjsWorker: any = await import('pdfjs-dist/legacy/build/pdf.worker.js');
  (globalThis as any).pdfjsWorker = pdfjsWorker;
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.js');

  const uint8Array = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    useSystemFonts: true,
    disableFontFace: true,
  });

  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  const pages: ExtractedPage[] = [];
  let canonicalFullText = '';
  let totalNonWhitespaceChars = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();

    let pageText = '';
    let lastY: number | null = null;

    // Reconstruct lines based on item positions
    for (const item of textContent.items) {
      if ('str' in item) {
        const str = item.str;
        const transform = item.transform; // [scaleX, skewY, skewX, scaleY, transX, transY]
        const currentY = transform ? transform[5] : null;

        if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 5) {
          pageText += '\n';
        } else if (pageText.length > 0 && !pageText.endsWith(' ') && !pageText.endsWith('\n') && str.length > 0) {
          pageText += ' ';
        }

        pageText += str;
        if (currentY !== null) {
          lastY = currentY;
        }
      }
    }

    const trimmedPageText = pageText.trim();
    totalNonWhitespaceChars += trimmedPageText.replace(/\s+/g, '').length;

    const pageStartOffset = canonicalFullText.length;
    // Add page separator if not first page
    if (canonicalFullText.length > 0) {
      canonicalFullText += '\n\n';
    }
    const pageContentStart = canonicalFullText.length;
    canonicalFullText += trimmedPageText;
    const pageContentEnd = canonicalFullText.length;

    pages.push({
      pageNumber: pageNum,
      text: trimmedPageText,
      startOffset: pageContentStart,
      endOffset: pageContentEnd,
    });
  }

  // Detect empty or scanned PDF:
  // A scanned PDF typically has < 25 extracted characters across the entire document.
  // Also treat a PDF where MORE than 90% of pages have < 20 characters as scanned.
  const sparsePagesCount = pages.filter((p) => p.text.replace(/\s+/g, '').length < 20).length;
  const isSparsePdf = pages.length > 0 && sparsePagesCount / pages.length > 0.9;
  const isScannedOrEmpty = totalNonWhitespaceChars < 25 || isSparsePdf;

  // Extract detected sections from canonical text
  const sections = detectSections(canonicalFullText, pages);

  // Detect running headers and footers (noise spans)
  const noiseSpans = detectNoiseSpans(pages, canonicalFullText);

  return {
    text: canonicalFullText,
    pageCount: numPages,
    pages,
    sections,
    noiseSpans,
    isScannedOrEmpty,
  };
}

/**
 * Detects running headers and footers across pages.
 * Per page takes first 3 and last 3 non-empty lines, normalizes digits to '#',
 * and marks as boilerplate if normalized form occurs on >= 30% of pages (min 5 pages)
 * or matches /^\s*(page\s+)?\d+(\s+of\s+\d+)?\s*$/i.
 */
export function detectNoiseSpans(pages: ExtractedPage[], fullText: string): [number, number][] {
  if (!pages || pages.length === 0) return [];

  const pageCount = pages.length;
  const normalizedFreq = new Map<string, Set<number>>();
  const lineCandidates: Array<{
    pageNumber: number;
    start: number;
    end: number;
    text: string;
    normalized: string;
  }> = [];

  for (const page of pages) {
    const pageText = fullText.slice(page.startOffset, page.endOffset);
    const lines: Array<{ start: number; end: number; text: string }> = [];
    let lineStart = 0;
    const lineRegex = /\r?\n/g;
    let match: RegExpExecArray | null;

    while ((match = lineRegex.exec(pageText)) !== null) {
      const lineStr = pageText.slice(lineStart, match.index);
      if (lineStr.trim().length > 0) {
        lines.push({
          start: page.startOffset + lineStart,
          end: page.startOffset + match.index,
          text: lineStr,
        });
      }
      lineStart = match.index + match[0].length;
    }
    if (lineStart < pageText.length) {
      const lineStr = pageText.slice(lineStart);
      if (lineStr.trim().length > 0) {
        lines.push({
          start: page.startOffset + lineStart,
          end: page.startOffset + pageText.length,
          text: lineStr,
        });
      }
    }

    if (lines.length === 0) continue;

    const first3 = lines.slice(0, 3);
    const last3 = lines.length > 3 ? lines.slice(-3) : [];
    const candidates = [...first3, ...last3];

    for (const c of candidates) {
      const trimmed = c.text.trim();
      const normalized = trimmed.replace(/\d+/g, '#').toLowerCase();
      lineCandidates.push({
        pageNumber: page.pageNumber,
        start: c.start,
        end: c.end,
        text: trimmed,
        normalized,
      });

      const set = normalizedFreq.get(normalized) || new Set<number>();
      set.add(page.pageNumber);
      normalizedFreq.set(normalized, set);
    }
  }

  const standalonePageRegex = /^\s*(page\s+)?\d+(\s+of\s+\d+)?\s*$/i;
  const rawSpans: [number, number][] = [];

  for (const c of lineCandidates) {
    const isStandalonePageNum = standalonePageRegex.test(c.text);
    const pagesWithThisLine = normalizedFreq.get(c.normalized)?.size || 0;
    const isBoilerplate =
      isStandalonePageNum ||
      (pageCount >= 5 && pagesWithThisLine / pageCount >= 0.3);

    if (isBoilerplate) {
      rawSpans.push([c.start, c.end]);
    }
  }

  if (rawSpans.length === 0) return [];
  rawSpans.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [rawSpans[0]];
  for (let i = 1; i < rawSpans.length; i++) {
    const last = merged[merged.length - 1];
    const curr = rawSpans[i];
    if (curr[0] <= last[1]) {
      last[1] = Math.max(last[1], curr[1]);
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Detects numbered legal contract sections (e.g. "1. DEFINITIONS", "Section 12. Limitation of Liability")
 */
export function detectSections(
  text: string,
  pages: ExtractedPage[]
): {
  sectionNumber: string;
  sectionTitle: string;
  text: string;
  startOffset: number;
  endOffset: number;
  pageStart: number;
  pageEnd: number;
}[] {
  const sections: {
    sectionNumber: string;
    sectionTitle: string;
    text: string;
    startOffset: number;
    endOffset: number;
    pageStart: number;
    pageEnd: number;
  }[] = [];

  // Match legal section headers such as:
  // "1. DEFINITIONS", "1.1 General", "Section 12. Limitation of Liability", "CLAUSE 14: TERMINATION", "ARTICLE 5"
  const sectionRegex = /(?:^|\n)(?:(?:SECTION|Section|CLAUSE|Clause|ARTICLE|Article)\s+)?([0-9]{1,2}(?:\.[0-9]{1,2})*|[IVXLCDM]+)[\.\:\s]+([^\n\r]{3,80})/g;

  const matches: { index: number; number: string; title: string }[] = [];
  let m: RegExpExecArray | null;

  while ((m = sectionRegex.exec(text)) !== null) {
    const matchIndex = m.index + (m[0].startsWith('\n') ? 1 : 0);
    matches.push({
      index: matchIndex,
      number: m[1].trim(),
      title: m[2].trim(),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const startOffset = current.index;
    const endOffset = next ? next.index : text.length;
    const sectionText = text.slice(startOffset, endOffset).trim();

    // Determine pages
    let pageStart = 1;
    let pageEnd = 1;
    for (const p of pages) {
      if (startOffset >= p.startOffset && startOffset <= p.endOffset) {
        pageStart = p.pageNumber;
      }
      if (endOffset >= p.startOffset && endOffset <= p.endOffset) {
        pageEnd = p.pageNumber;
      }
    }

    sections.push({
      sectionNumber: current.number,
      sectionTitle: current.title,
      text: sectionText,
      startOffset,
      endOffset,
      pageStart,
      pageEnd: Math.max(pageStart, pageEnd),
    });
  }

  return sections;
}
