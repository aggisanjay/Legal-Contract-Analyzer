import { describe, it, expect } from 'vitest';
import {
  normalizeCitationMarkers,
  cleanAnswerPreambleAndSeparators,
} from '../src/lib/ai/stream-cleaner';

describe('Bug 4 - Citation Marker Normalization', () => {
  it('normalizes double-nested lists: [[1], [2]] -> [1] [2]', () => {
    expect(normalizeCitationMarkers('See [[1], [2]] for details.')).toBe('See [1] [2] for details.');
    expect(normalizeCitationMarkers('References: [[1], [2], [3]].')).toBe('References: [1] [2] [3].');
  });

  it('normalizes single double-brackets: [[1]] -> [1]', () => {
    expect(normalizeCitationMarkers('Governed by UAE law [[1]].')).toBe('Governed by UAE law [1].');
    expect(normalizeCitationMarkers('[[42]]')).toBe('[42]');
  });

  it('normalizes comma-separated lists: [1, 2] and [1,2] and [1, 2, 3] -> [1] [2] [3]', () => {
    expect(normalizeCitationMarkers('Both notices [1, 2] apply.')).toBe('Both notices [1] [2] apply.');
    expect(normalizeCitationMarkers('Both notices [1,2] apply.')).toBe('Both notices [1] [2] apply.');
    expect(normalizeCitationMarkers('Provisions [1, 2, 3] state this.')).toBe('Provisions [1] [2] [3] state this.');
  });

  it('normalizes adjacent bracket markers without spaces: [1][2] -> [1] [2]', () => {
    expect(normalizeCitationMarkers('Notice requirements [1][2] are distinct.')).toBe(
      'Notice requirements [1] [2] are distinct.'
    );
    expect(normalizeCitationMarkers('[1][2][3]')).toBe('[1] [2] [3]');
  });

  it('handles complex mixed sentences with various malformed citation markers', () => {
    const raw = 'Clause 1 [1, 2] and Clause 2 [[3], [4]] with Clause 3 [5][6] and single [[7]].';
    const expected = 'Clause 1 [1] [2] and Clause 2 [3] [4] with Clause 3 [5] [6] and single [7].';
    expect(normalizeCitationMarkers(raw)).toBe(expected);
  });

  it('cleanAnswerPreambleAndSeparators normalizes markers and strips conversational preamble', () => {
    const raw = `The governing law is clearly stated in the contract.

Version 2 has the longer notice period [[1], [2]].

---
Difference: 30 days vs 60 days.`;

    const cleaned = cleanAnswerPreambleAndSeparators(raw);
    expect(cleaned).not.toContain('The governing law is clearly stated');
    expect(cleaned).not.toContain('---');
    expect(cleaned).toContain('Version 2 has the longer notice period [1] [2].');
    expect(cleaned).toContain('Difference: 30 days vs 60 days.');
  });
});
