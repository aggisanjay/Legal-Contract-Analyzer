/**
 * Formats a list of page numbers into human-readable ranges (e.g. "1–5, 8, 12–15").
 */
export function formatPageRanges(pageNumbers: number[]): string {
  if (!pageNumbers || pageNumbers.length === 0) return '';
  const sorted = Array.from(new Set(pageNumbers)).sort((a, b) => a - b);
  const ranges: string[] = [];

  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = cur;
      prev = cur;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);

  return ranges.join(', ');
}

export function normalizeQuoteForDedup(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deduplicates verified citations by normalized text within a document,
 * merging multiple occurrences into a single citation card.
 */
export function deduplicateVerifiedCitations(citations: any[]): any[] {
  if (!citations || citations.length === 0) return [];
  const map = new Map<string, any>();

  for (const cit of citations) {
    const key = `${cit.documentId || ''}::${normalizeQuoteForDedup(cit.quote)}`;
    if (!map.has(key)) {
      const occs =
        cit.occurrences && cit.occurrences.length > 0
          ? [...cit.occurrences]
          : [
              {
                startOffset: cit.startOffset,
                endOffset: cit.endOffset,
                pageStart: cit.pageStart || 1,
                pageEnd: cit.pageEnd || 1,
              },
            ];
      map.set(key, {
        ...cit,
        occurrences: occs,
      });
    } else {
      const existing = map.get(key)!;
      const existingOccs = existing.occurrences || [
        {
          startOffset: existing.startOffset,
          endOffset: existing.endOffset,
          pageStart: existing.pageStart || 1,
          pageEnd: existing.pageEnd || 1,
        },
      ];
      const newOccs = cit.occurrences || [
        {
          startOffset: cit.startOffset,
          endOffset: cit.endOffset,
          pageStart: cit.pageStart || 1,
          pageEnd: cit.pageEnd || 1,
        },
      ];
      const mergedOccs = [...existingOccs];
      for (const occ of newOccs) {
        if (!mergedOccs.some((o) => o.startOffset === occ.startOffset && o.pageStart === occ.pageStart)) {
          mergedOccs.push(occ);
        }
      }
      mergedOccs.sort((a, b) =>
        a.pageStart !== b.pageStart ? a.pageStart - b.pageStart : a.startOffset - b.startOffset
      );
      existing.occurrences = mergedOccs;
      existing.startOffset = mergedOccs[0].startOffset;
      existing.endOffset = mergedOccs[0].endOffset;
      existing.pageStart = mergedOccs[0].pageStart;
      existing.pageEnd = mergedOccs[0].pageEnd;
    }
  }

  return Array.from(map.values());
}
