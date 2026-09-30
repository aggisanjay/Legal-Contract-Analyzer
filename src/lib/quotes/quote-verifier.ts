import { QuoteVerificationResult, ExtractedPage, QuoteOccurrence } from '../types';
import { detectNoiseSpans } from '../documents/pdf-extractor';

export interface PageInfo {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkInfo {
  id: string;
  startOffset: number;
  endOffset: number;
  pageStart: number;
  pageEnd: number;
}

export interface NormalizedTextMap {
  normalized: string;
  origIndexMap: number[];
}

/**
 * Normalizes text while maintaining an exact character index mapping back to original text.
 * Handles:
 * - Skipping noise spans (running headers/footers) so cross-page quotes match seamlessly
 * - Skipping form-feed (\f) and treating newlines between pages as whitespace
 * - Unicode NFKC normalization with per-output-character mapping (ligatures ﬁ, ﬂ, ﬀ, fractions, etc.)
 * - Stripping soft hyphens (\u00AD)
 * - Handling words hyphenated across line breaks ("terminat-\ned" -> "terminated")
 * - Converting multiple spaces, tabs, carriage returns, and newlines to a single space
 * - Smart quotes, dashes, non-breaking spaces
 * Invariant: normalized.length === origIndexMap.length is always guaranteed.
 */
export function normalizeTextWithMap(
  text: string,
  noiseSpans?: [number, number][]
): NormalizedTextMap {
  if (!text) {
    return { normalized: '', origIndexMap: [] };
  }

  // Pre-sort and merge noise spans
  const sortedSpans: [number, number][] = [];
  if (noiseSpans && noiseSpans.length > 0) {
    const raw = [...noiseSpans].sort((a, b) => a[0] - b[0]);
    let curr: [number, number] = [raw[0][0], raw[0][1]];
    for (let k = 1; k < raw.length; k++) {
      if (raw[k][0] <= curr[1]) {
        curr = [curr[0], Math.max(curr[1], raw[k][1])];
      } else {
        sortedSpans.push(curr);
        curr = [raw[k][0], raw[k][1]];
      }
    }
    sortedSpans.push(curr);
  }

  const normalizedChars: string[] = [];
  const origIndexMap: number[] = [];

  let inWhitespace = false;
  let i = 0;
  let spanIdx = 0;

  while (i < text.length) {
    // Check if i is within a noise span
    while (spanIdx < sortedSpans.length && sortedSpans[spanIdx][1] <= i) {
      spanIdx++;
    }
    if (spanIdx < sortedSpans.length && i >= sortedSpans[spanIdx][0] && i < sortedSpans[spanIdx][1]) {
      // Jump past the noise span
      const spanStart = sortedSpans[spanIdx][0];
      const spanEnd = sortedSpans[spanIdx][1];
      i = spanEnd;
      if (!inWhitespace && normalizedChars.length > 0) {
        normalizedChars.push(' ');
        origIndexMap.push(spanStart > 0 ? spanStart - 1 : 0);
        inWhitespace = true;
      }
      continue;
    }

    // Skip form-feed (\f) and treat as whitespace
    if (text[i] === '\f') {
      if (!inWhitespace && normalizedChars.length > 0) {
        normalizedChars.push(' ');
        origIndexMap.push(i);
        inWhitespace = true;
      }
      i++;
      continue;
    }

    // 1. Strip soft hyphens (\u00AD)
    if (text[i] === '\u00AD') {
      i++;
      continue;
    }

    // 2. Handle words hyphenated across line breaks: e.g. "terminat-\ned" -> "terminated"
    const isHyphenChar = text[i] === '-' || text[i] === '\u2010' || text[i] === '\u2011';
    if (isHyphenChar) {
      const prevNormChar = normalizedChars.length > 0 ? normalizedChars[normalizedChars.length - 1] : '';
      const isPrecededByWordChar = /[a-zA-Z0-9]/.test(prevNormChar);

      if (isPrecededByWordChar) {
        let lookahead = i + 1;
        while (lookahead < text.length && (text[lookahead] === ' ' || text[lookahead] === '\t')) {
          lookahead++;
        }

        let hasLineBreak = false;
        if (lookahead < text.length && text[lookahead] === '\r') {
          hasLineBreak = true;
          lookahead++;
        }
        if (lookahead < text.length && text[lookahead] === '\n') {
          hasLineBreak = true;
          lookahead++;
        }

        if (hasLineBreak) {
          while (lookahead < text.length && (text[lookahead] === ' ' || text[lookahead] === '\t')) {
            lookahead++;
          }

          // If followed by a word character, join the hyphenated word
          if (lookahead < text.length && /[a-zA-Z0-9]/.test(text[lookahead])) {
            i = lookahead;
            inWhitespace = false;
            continue;
          }
        }
      }
    }

    // 3. Normal character processing with NFKC expansion
    const rawChar = text[i];
    const expanded = rawChar.normalize('NFKC');

    for (let c = 0; c < expanded.length; c++) {
      let char = expanded[c];

      // Normalize curly quotes / dashes / special whitespace
      if (char === '\u201C' || char === '\u201D' || char === '«' || char === '»' || char === '„') {
        char = '"';
      } else if (char === '\u2018' || char === '\u2019' || char === '`') {
        char = "'";
      } else if (char === '\u2013' || char === '\u2014' || char === '\u2212') {
        char = '-';
      } else if (char === '\u00A0' || char === '\u200B' || char === '\u202F' || char === '\uFEFF') {
        char = ' ';
      }

      const isWhitespace = /\s/.test(char);

      if (isWhitespace) {
        if (!inWhitespace && normalizedChars.length > 0) {
          normalizedChars.push(' ');
          origIndexMap.push(i);
          inWhitespace = true;
        }
        // Collapse subsequent whitespaces
      } else {
        normalizedChars.push(char);
        origIndexMap.push(i);
        inWhitespace = false;
      }
    }

    i++;
  }

  // Ensure invariant: normalized.length === origIndexMap.length
  console.assert(
    normalizedChars.length === origIndexMap.length,
    `Invariant failed: normalized.length (${normalizedChars.length}) !== origIndexMap.length (${origIndexMap.length})`
  );

  return {
    normalized: normalizedChars.join(''),
    origIndexMap,
  };
}

/**
 * Normalizes candidate quote from LLM (stripping external wrapping quotes, normalizing spaces/punctuation).
 */
export function normalizeCandidateQuote(quote: string): string {
  if (!quote) return '';
  let cleaned = quote.trim();

  // Strip wrapping quotation marks if the LLM wrapped the quote
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('“') && cleaned.endsWith('”'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  const { normalized } = normalizeTextWithMap(cleaned);
  return normalized.trim();
}

/**
 * Find all matching occurrences of a normalized quote inside normalized document text.
 */
export function findAllMatches(
  docNorm: string,
  quoteNorm: string,
  caseInsensitive = false
): { start: number; end: number }[] {
  if (!quoteNorm || !docNorm) return [];

  const matches: { start: number; end: number }[] = [];
  const searchDoc = caseInsensitive ? docNorm.toLowerCase() : docNorm;
  const searchQuote = caseInsensitive ? quoteNorm.toLowerCase() : quoteNorm;

  let pos = 0;
  while (pos < searchDoc.length) {
    const idx = searchDoc.indexOf(searchQuote, pos);
    if (idx === -1) break;

    matches.push({
      start: idx,
      end: idx + searchQuote.length - 1,
    });
    pos = idx + 1;
  }

  return matches;
}

/**
 * Determines pageStart and pageEnd from canonical start and end offsets.
 */
export function findPageRange(
  startOffset: number,
  endOffset: number,
  pages: PageInfo[]
): { pageStart: number; pageEnd: number } {
  if (!pages || pages.length === 0) {
    return { pageStart: 1, pageEnd: 1 };
  }

  let pageStart = pages[0].pageNumber;
  let pageEnd = pages[pages.length - 1].pageNumber;

  let foundStart = false;
  let foundEnd = false;

  for (const page of pages) {
    // If the offset falls within or touches this page
    if (!foundStart && startOffset >= page.startOffset && startOffset <= page.endOffset) {
      pageStart = page.pageNumber;
      foundStart = true;
    }
    const endTarget = Math.max(startOffset, endOffset - 1);
    if (endTarget >= page.startOffset && endTarget <= page.endOffset) {
      pageEnd = page.pageNumber;
      foundEnd = true;
    }
  }

  // Fallback: search closest page if exact boundary not matched
  if (!foundStart || !foundEnd) {
    for (const page of pages) {
      if (startOffset <= page.endOffset && !foundStart) {
        pageStart = page.pageNumber;
        foundStart = true;
      }
      if (endOffset <= page.endOffset && !foundEnd) {
        pageEnd = page.pageNumber;
        foundEnd = true;
      }
    }
  }

  return {
    pageStart: Math.max(1, pageStart),
    pageEnd: Math.max(pageStart, pageEnd),
  };
}

export interface QuoteVerifierOptions {
  documentId: string;
  candidateQuote: string;
  canonicalText: string;
  pages: PageInfo[];
  candidateChunk?: ChunkInfo | null;
  allChunks?: ChunkInfo[];
  noiseSpans?: [number, number][];
}

/**
 * Core Quote Verifier implementation.
 * Independently verifies that candidate quotes proposed by the LLM exist verbatim
 * in the canonical extracted document text.
 */
export function verifyQuote(options: QuoteVerifierOptions): QuoteVerificationResult {
  const {
    documentId,
    candidateQuote,
    canonicalText,
    pages,
    candidateChunk,
  } = options;

  if (!candidateQuote || !candidateQuote.trim()) {
    return {
      verified: false,
      quote: candidateQuote,
      reason: 'Quote is empty.',
    };
  }

  if (!canonicalText) {
    return {
      verified: false,
      quote: candidateQuote,
      reason: 'Document contains no readable text.',
    };
  }

  // Step 1: Normalize Candidate Quote
  const normQuote = normalizeCandidateQuote(candidateQuote);
  if (!normQuote) {
    return {
      verified: false,
      quote: candidateQuote,
      reason: 'Quote contains only whitespace or invalid characters.',
    };
  }

  // Minimum quote length check: at least 25 characters or 5 words
  const words = normQuote.trim().split(/\s+/).filter(Boolean);
  if (normQuote.length < 25 && words.length < 5) {
    return {
      verified: false,
      quote: candidateQuote,
      reason: 'Quote is too short to be meaningful evidence (minimum 25 characters or 5 words required).',
    };
  }

  // Step 2: Normalize Document with character position mapping & noise spans skipped
  const spans =
    options.noiseSpans ||
    (pages && pages.length >= 1 ? detectNoiseSpans(pages as ExtractedPage[], canonicalText) : []);
  const docMap = normalizeTextWithMap(canonicalText, spans);

  // Step 3: Exact normalized search
  let matches = findAllMatches(docMap.normalized, normQuote, false);

  // Step 4: If not found, try case-insensitive search
  if (matches.length === 0) {
    matches = findAllMatches(docMap.normalized, normQuote, true);
  }

  // Step 5: If candidate quote ends with trailing punctuation that is not present in document,
  // allow stripping ONLY the trailing punctuation characters without loosening text matching
  if (matches.length === 0) {
    const trimmedPunct = normQuote.replace(/[.,;:!?'"“”'’]+$/, '').trim();
    if (
      trimmedPunct !== normQuote &&
      (trimmedPunct.length >= 25 || trimmedPunct.split(/\s+/).filter(Boolean).length >= 5)
    ) {
      matches = findAllMatches(docMap.normalized, trimmedPunct, true);
    }
  }

  // Step 6: If still not found, check if it's within candidate chunk specifically
  if (matches.length === 0) {
    return {
      verified: false,
      quote: candidateQuote,
      reason: 'Quote could not be located in the document.',
    };
  }

  // Step 7: Resolve duplicate matches
  // If multiple occurrences exist and candidateChunk is provided, prefer the occurrence
  // closest to the retrieved evidence chunk.
  let selectedMatch = matches[0];

  if (matches.length > 1 && candidateChunk) {
    let minDistance = Infinity;
    for (const match of matches) {
      const origStart = docMap.origIndexMap[match.start];
      const origEnd = docMap.origIndexMap[match.end] + 1;

      // Check distance to candidate chunk
      const chunkMid = (candidateChunk.startOffset + candidateChunk.endOffset) / 2;
      const matchMid = (origStart + origEnd) / 2;
      const dist = Math.abs(matchMid - chunkMid);

      if (dist < minDistance) {
        minDistance = dist;
        selectedMatch = match;
      }
    }
  }

  // Map all occurrences for multi-occurrence citations (Defect 3)
  const occurrences: QuoteOccurrence[] = matches.map((m) => {
    const sOff = docMap.origIndexMap[m.start];
    const eOff = docMap.origIndexMap[m.end] + 1;
    const pRange = findPageRange(sOff, eOff, pages);
    return {
      startOffset: sOff,
      endOffset: eOff,
      pageStart: pRange.pageStart,
      pageEnd: pRange.pageEnd,
    };
  });

  // Step 8: Map back to canonical offsets for primary match
  const startOffset = docMap.origIndexMap[selectedMatch.start];
  const endOffset = docMap.origIndexMap[selectedMatch.end] + 1;

  // Exact slice from the original canonical document text
  const exactCanonicalQuote = canonicalText.slice(startOffset, endOffset);

  // Step 9: Determine affected pages
  const { pageStart, pageEnd } = findPageRange(startOffset, endOffset, pages);

  return {
    verified: true,
    quote: exactCanonicalQuote,
    documentId,
    startOffset,
    endOffset,
    pageStart,
    pageEnd,
    occurrences,
  };
}

/**
 * Server-side helper to verify a candidate quote directly from a document ID in the database.
 */
export async function verifyQuoteForDocument(
  documentId: string,
  candidateQuote: string,
  candidateChunkId?: string
): Promise<QuoteVerificationResult> {
  const { prisma } = await import('../prisma');

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      chunks: true,
    },
  });

  if (!doc) {
    return {
      verified: false,
      quote: candidateQuote,
      reason: `Document with ID ${documentId} not found.`,
    };
  }

  if (!doc.extractedText) {
    return {
      verified: false,
      quote: candidateQuote,
      reason: 'Document has no extracted text.',
    };
  }

  // Build page ranges and noiseSpans from pagesJson
  const pages: PageInfo[] = [];
  let noiseSpans: [number, number][] = [];

  if (doc.pagesJson && typeof doc.pagesJson === 'object') {
    if (Array.isArray(doc.pagesJson)) {
      for (const p of doc.pagesJson as any[]) {
        pages.push({
          pageNumber: p.pageNumber,
          startOffset: p.startOffset,
          endOffset: p.endOffset,
        });
        if (p.noiseSpans && Array.isArray(p.noiseSpans)) {
          noiseSpans.push(...p.noiseSpans);
        }
      }
    } else {
      const obj = doc.pagesJson as any;
      if (Array.isArray(obj.pages)) {
        for (const p of obj.pages) {
          pages.push({
            pageNumber: p.pageNumber,
            startOffset: p.startOffset,
            endOffset: p.endOffset,
          });
        }
      }
      if (Array.isArray(obj.noiseSpans)) {
        noiseSpans = obj.noiseSpans;
      }
    }
  } else if (doc.chunks && doc.chunks.length > 0) {
    // If pagesJson is not yet populated for older docs, use sorted chunks without division fallback
    const sortedChunks = [...doc.chunks].sort((a, b) => a.startOffset - b.startOffset);
    const pageBounds = new Map<number, { startOffset: number; endOffset: number }>();
    for (const chunk of sortedChunks) {
      for (let p = chunk.pageStart; p <= chunk.pageEnd; p++) {
        const existing = pageBounds.get(p);
        if (!existing) {
          pageBounds.set(p, { startOffset: chunk.startOffset, endOffset: chunk.endOffset });
        } else {
          pageBounds.set(p, {
            startOffset: Math.min(existing.startOffset, chunk.startOffset),
            endOffset: Math.max(existing.endOffset, chunk.endOffset),
          });
        }
      }
    }
    for (const [p, b] of pageBounds.entries()) {
      pages.push({ pageNumber: p, startOffset: b.startOffset, endOffset: b.endOffset });
    }
    pages.sort((a, b) => a.pageNumber - b.pageNumber);
  }

  // If noiseSpans was not populated in db, detect dynamically from pages and text
  if (noiseSpans.length === 0 && pages.length > 0 && doc.extractedText) {
    noiseSpans = detectNoiseSpans(pages as ExtractedPage[], doc.extractedText);
  }

  const candidateChunk = candidateChunkId
    ? doc.chunks.find((c) => c.id === candidateChunkId)
    : null;

  return verifyQuote({
    documentId: doc.id,
    candidateQuote,
    canonicalText: doc.extractedText,
    pages,
    noiseSpans,
    candidateChunk: candidateChunk
      ? {
          id: candidateChunk.id,
          startOffset: candidateChunk.startOffset,
          endOffset: candidateChunk.endOffset,
          pageStart: candidateChunk.pageStart,
          pageEnd: candidateChunk.pageEnd,
        }
      : null,
  });
}
