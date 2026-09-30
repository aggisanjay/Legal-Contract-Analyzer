import { QuoteVerificationResult, ExtractedPage } from '../types';

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
 * - Unicode NFKC normalization
 * - Converting multiple spaces, tabs, carriage returns, and newlines to a single space
 * - Smart quotes, dashes, non-breaking spaces
 */
export function normalizeTextWithMap(text: string): NormalizedTextMap {
  if (!text) {
    return { normalized: '', origIndexMap: [] };
  }

  const normalizedChars: string[] = [];
  const origIndexMap: number[] = [];

  let inWhitespace = false;

  for (let i = 0; i < text.length; i++) {
    let char = text[i];

    // Normalize Unicode NFKC
    char = char.normalize('NFKC');

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
      if (!inWhitespace) {
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

  // Step 2: Normalize Document with character position mapping
  const docMap = normalizeTextWithMap(canonicalText);

  // Step 3: Exact normalized search
  let matches = findAllMatches(docMap.normalized, normQuote, false);

  // Step 4: If not found, try case-insensitive search
  if (matches.length === 0) {
    matches = findAllMatches(docMap.normalized, normQuote, true);
  }

  // Step 5: If still not found, try stripping trailing punctuation from candidate
  if (matches.length === 0) {
    const trimmedPunct = normQuote.replace(/[.,;:]+$/, '').trim();
    if (trimmedPunct.length > 5) {
      matches = findAllMatches(docMap.normalized, trimmedPunct, true);
    }
  }

  // Step 6: If still not found, check if it's within candidate chunk specifically (handling minor formatting differences)
  if (matches.length === 0 && candidateChunk) {
    // If not found anywhere in document, mark as unverified
    return {
      verified: false,
      quote: candidateQuote,
      reason: 'Quote could not be located in the document.',
    };
  }

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

  // Step 8: Map back to canonical offsets
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

  // Reconstruct pages map from chunks or pageCount
  const pages: PageInfo[] = [];
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

  for (let p = 1; p <= Math.max(doc.pageCount, 1); p++) {
    const b = pageBounds.get(p);
    if (b) {
      pages.push({ pageNumber: p, startOffset: b.startOffset, endOffset: b.endOffset });
    } else {
      const len = doc.extractedText.length;
      const step = Math.floor(len / Math.max(doc.pageCount, 1));
      pages.push({
        pageNumber: p,
        startOffset: (p - 1) * step,
        endOffset: p === doc.pageCount ? len : p * step,
      });
    }
  }

  const candidateChunk = candidateChunkId
    ? doc.chunks.find((c) => c.id === candidateChunkId)
    : null;

  return verifyQuote({
    documentId: doc.id,
    candidateQuote,
    canonicalText: doc.extractedText,
    pages,
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
