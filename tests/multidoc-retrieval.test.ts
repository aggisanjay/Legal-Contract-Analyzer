import { describe, it, expect } from 'vitest';
import { isPlaceholderQuote, formatPageRanges } from '../src/lib/ai/coverage';
import { STOPWORDS, lightStem, tokenizeAndStem } from '../src/lib/ai/retriever';

describe('Tasks 2, 3, 4: Multi-Doc Retrieval, Placeholders & Fallback', () => {
  describe('Task 3: isPlaceholderQuote', () => {
    it('identifies "Not found in <file>" and missing markers as placeholders to discard', () => {
      expect(isPlaceholderQuote('Not found in large-contract-v1-150pages.pdf')).toBe(true);
      expect(isPlaceholderQuote('not found in contract.pdf')).toBe(true);
      expect(isPlaceholderQuote('NO RELEVANT PASSAGES RETRIEVED FOR contract-v2.pdf')).toBe(true);
      expect(isPlaceholderQuote('No relevant passage was retrieved from DOC_1')).toBe(true);
      expect(isPlaceholderQuote('None')).toBe(true);
      expect(isPlaceholderQuote('N/A')).toBe(true);
      expect(isPlaceholderQuote('')).toBe(true);
      expect(isPlaceholderQuote(null as any)).toBe(true);
      expect(isPlaceholderQuote(undefined as any)).toBe(true);
    });

    it('does NOT treat substantive contract clauses as placeholders', () => {
      expect(
        isPlaceholderQuote(
          "Either party may terminate this Agreement for convenience by providing thirty (30) days' written notice."
        )
      ).toBe(false);
      expect(
        isPlaceholderQuote(
          'The aggregate liability of either party shall not exceed AED 100,000.'
        )
      ).toBe(false);
      expect(
        isPlaceholderQuote(
          'This Agreement shall be governed by and construed in accordance with the laws of the Emirate of Dubai.'
        )
      ).toBe(false);
    });
  });

  describe('Task 2: Per-Document Coverage Recording & Badging', () => {
    it('formats multi-document coverage badges accurately per document without claiming complete read', () => {
      const doc1Pages = [37, 38, 39, 112];
      const doc2Pages = [37, 38, 39, 112];

      const d1Formatted = formatPageRanges(doc1Pages);
      const d2Formatted = formatPageRanges(doc2Pages);

      expect(d1Formatted).toBe('37–39, 112');
      expect(d2Formatted).toBe('37–39, 112');

      const summary = `v1: looked at pp. ${d1Formatted} (4 of 150). v2: looked at pp. ${d2Formatted} (4 of 150)`;
      expect(summary).toBe(
        'v1: looked at pp. 37–39, 112 (4 of 150). v2: looked at pp. 37–39, 112 (4 of 150)'
      );
    });
  });

  describe('Task 2: Stopwords & Topic Terms Extraction', () => {
    it('strips comparison and question stopwords for topic query fallback', () => {
      const q1 = 'Which version has the longer termination notice?';
      const words1 = q1
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w));

      expect(words1).toEqual(['termination', 'notice']);

      const q2 = 'How do the liability caps differ between the two documents?';
      const words2 = q2
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w));

      expect(words2).toEqual(['liability', 'caps']);

      const q3 = 'Do both contracts have the same governing law?';
      const words3 = q3
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOPWORDS.has(w));

      expect(words3).toEqual(['governing', 'law']);
    });
  });

  describe('Task 3: Absence Auto-Escalation Check', () => {
    it('detects when targeted chunks lack topic terms and triggers auto-escalate', () => {
      const question = 'What is the arbitration seat?';
      const topicTerms = tokenizeAndStem(question);
      expect(topicTerms).toEqual(['arbitration', 'seat']);

      // Simulated targeted chunks about general operations
      const retrievedChunks = [
        { text: 'The provider agrees to maintain all infrastructure, servers, and networks.' },
        { text: 'All technical personnel assigned to this facility must follow strict safety protocols.' },
      ];

      const combinedText = retrievedChunks.map((c) => c.text.toLowerCase()).join(' ');
      const combinedTokens = new Set(tokenizeAndStem(combinedText));
      const hasTopicTerm = topicTerms.some((t) => combinedTokens.has(t) || combinedText.includes(t));

      // Must be false -> triggers auto-escalate to map-reduce
      expect(hasTopicTerm).toBe(false);
    });
  });
});
