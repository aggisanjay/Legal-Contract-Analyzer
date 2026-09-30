import { ExtractedDocument, ExtractedPage } from '../types';

export interface ChunkOptions {
  minChunkSize?: number;
  maxChunkSize?: number;
  overlapSize?: number;
}

export interface ChunkResult {
  chunkIndex: number;
  text: string;
  pageStart: number;
  pageEnd: number;
  startOffset: number;
  endOffset: number;
  sectionNumber?: string | null;
  sectionTitle?: string | null;
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  minChunkSize: 600,
  maxChunkSize: 1400,
  overlapSize: 150,
};

/**
 * Legal contract clause-aware chunker.
 * Prioritizes splitting on section and clause boundaries rather than arbitrary character cuts.
 */
export function chunkDocument(
  doc: ExtractedDocument,
  options: ChunkOptions = {}
): ChunkResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const fullText = doc.text;
  const chunks: ChunkResult[] = [];

  if (!fullText || fullText.trim().length === 0) {
    return [];
  }

  // If text is smaller than max chunk size, return single chunk
  if (fullText.length <= opts.maxChunkSize) {
    const pageBounds = getPageBounds(0, fullText.length, doc.pages);
    return [
      {
        chunkIndex: 0,
        text: fullText,
        pageStart: pageBounds.pageStart,
        pageEnd: pageBounds.pageEnd,
        startOffset: 0,
        endOffset: fullText.length,
        sectionNumber: doc.sections[0]?.sectionNumber || null,
        sectionTitle: doc.sections[0]?.sectionTitle || null,
      },
    ];
  }

  // Legal boundary patterns
  // 1. Major section headers: "12. LIMITATION OF LIABILITY", "SECTION 14", "CLAUSE 3"
  // 2. Sub-clauses: "12.1", "12.2(a)"
  // 3. Double line breaks (paragraphs)
  // 4. Single line breaks / sentence ends
  const paragraphRegex = /\n\s*\n/g;
  const paragraphs: { text: string; start: number; end: number }[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = paragraphRegex.exec(fullText)) !== null) {
    const pText = fullText.slice(lastIndex, match.index).trim();
    if (pText.length > 0) {
      paragraphs.push({
        text: pText,
        start: lastIndex,
        end: match.index,
      });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < fullText.length) {
    const pText = fullText.slice(lastIndex).trim();
    if (pText.length > 0) {
      paragraphs.push({
        text: pText,
        start: lastIndex,
        end: fullText.length,
      });
    }
  }

  // If paragraph extraction yielded empty (e.g. single block of text), fallback to sentence / size splits
  if (paragraphs.length === 0) {
    return chunkBySize(fullText, doc.pages, opts);
  }

  let currentChunkText = '';
  let currentStartOffset = paragraphs[0].start;
  let currentEndOffset = paragraphs[0].end;
  let chunkIndex = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];

    // If single paragraph is oversized (> maxChunkSize), split it internally
    if (p.text.length > opts.maxChunkSize) {
      // First flush accumulated text if any
      if (currentChunkText.trim().length > 0) {
        const bounds = getPageBounds(currentStartOffset, currentEndOffset, doc.pages);
        const sec = findEnclosingSection(currentStartOffset, doc.sections);
        chunks.push({
          chunkIndex: chunkIndex++,
          text: currentChunkText.trim(),
          pageStart: bounds.pageStart,
          pageEnd: bounds.pageEnd,
          startOffset: currentStartOffset,
          endOffset: currentEndOffset,
          sectionNumber: sec?.sectionNumber || null,
          sectionTitle: sec?.sectionTitle || null,
        });
        currentChunkText = '';
      }

      // Chunk the oversized paragraph
      const subChunks = chunkBySize(p.text, doc.pages, opts, p.start);
      for (const sc of subChunks) {
        const sec = findEnclosingSection(sc.startOffset, doc.sections);
        chunks.push({
          ...sc,
          chunkIndex: chunkIndex++,
          sectionNumber: sec?.sectionNumber || null,
          sectionTitle: sec?.sectionTitle || null,
        });
      }
      if (i + 1 < paragraphs.length) {
        currentStartOffset = paragraphs[i + 1].start;
        currentEndOffset = paragraphs[i + 1].end;
      }
      continue;
    }

    const proposedText = currentChunkText ? `${currentChunkText}\n\n${p.text}` : p.text;

    if (proposedText.length > opts.maxChunkSize && currentChunkText.length >= opts.minChunkSize) {
      // Flush current chunk
      const bounds = getPageBounds(currentStartOffset, currentEndOffset, doc.pages);
      const sec = findEnclosingSection(currentStartOffset, doc.sections);
      chunks.push({
        chunkIndex: chunkIndex++,
        text: currentChunkText.trim(),
        pageStart: bounds.pageStart,
        pageEnd: bounds.pageEnd,
        startOffset: currentStartOffset,
        endOffset: currentEndOffset,
        sectionNumber: sec?.sectionNumber || null,
        sectionTitle: sec?.sectionTitle || null,
      });

      // Prepare next chunk with moderate overlap if possible
      currentChunkText = p.text;
      currentStartOffset = p.start;
      currentEndOffset = p.end;
    } else {
      currentChunkText = proposedText;
      currentEndOffset = p.end;
    }
  }

  // Flush remaining text
  if (currentChunkText.trim().length > 0) {
    const bounds = getPageBounds(currentStartOffset, currentEndOffset, doc.pages);
    const sec = findEnclosingSection(currentStartOffset, doc.sections);
    chunks.push({
      chunkIndex: chunkIndex++,
      text: currentChunkText.trim(),
      pageStart: bounds.pageStart,
      pageEnd: bounds.pageEnd,
      startOffset: currentStartOffset,
      endOffset: currentEndOffset,
      sectionNumber: sec?.sectionNumber || null,
      sectionTitle: sec?.sectionTitle || null,
    });
  }

  return chunks;
}

function chunkBySize(
  text: string,
  pages: ExtractedPage[],
  opts: Required<ChunkOptions>,
  baseOffset = 0
): ChunkResult[] {
  const results: ChunkResult[] = [];
  let start = 0;
  let idx = 0;

  while (start < text.length) {
    let end = Math.min(start + opts.maxChunkSize, text.length);

    // Try finding clean sentence or space boundary
    if (end < text.length) {
      const lastSentence = text.lastIndexOf('. ', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const boundary = Math.max(lastSentence, lastNewline);

      if (boundary > start + opts.minChunkSize) {
        end = boundary + 1;
      }
    }

    const chunkContent = text.slice(start, end).trim();
    const absStart = baseOffset + start;
    const absEnd = baseOffset + end;
    const bounds = getPageBounds(absStart, absEnd, pages);

    results.push({
      chunkIndex: idx++,
      text: chunkContent,
      pageStart: bounds.pageStart,
      pageEnd: bounds.pageEnd,
      startOffset: absStart,
      endOffset: absEnd,
    });

    if (end >= text.length) break;
    start = Math.max(start + opts.minChunkSize, end - opts.overlapSize);
  }

  return results;
}

function getPageBounds(
  startOffset: number,
  endOffset: number,
  pages: ExtractedPage[]
): { pageStart: number; pageEnd: number } {
  if (!pages || pages.length === 0) return { pageStart: 1, pageEnd: 1 };
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

  return { pageStart, pageEnd: Math.max(pageStart, pageEnd) };
}

function findEnclosingSection(
  offset: number,
  sections: ExtractedDocument['sections']
): { sectionNumber: string; sectionTitle: string } | undefined {
  if (!sections || sections.length === 0) return undefined;
  return sections.find((s) => offset >= s.startOffset && offset <= s.endOffset);
}
