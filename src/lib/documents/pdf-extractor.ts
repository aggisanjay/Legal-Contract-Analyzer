import { ExtractedDocument, ExtractedPage } from '../types';

/**
 * Extracts text and page boundaries from a PDF Buffer using pdfjs-dist.
 * Preserves page offsets, section markers, and detects empty/scanned PDFs.
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<ExtractedDocument & { isScannedOrEmpty: boolean }> {
  // Dynamically import pdfjs-dist legacy build for reliable Node.js execution
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.js');

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
  // A scanned PDF typically has 0 extracted characters or very few OCR noise characters (< 30 across document)
  const isScannedOrEmpty = totalNonWhitespaceChars < 25;

  // Extract detected sections from canonical text
  const sections = detectSections(canonicalFullText, pages);

  return {
    text: canonicalFullText,
    pageCount: numPages,
    pages,
    sections,
    isScannedOrEmpty,
  };
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
