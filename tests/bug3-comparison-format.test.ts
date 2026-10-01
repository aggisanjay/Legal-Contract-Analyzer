import { describe, it, expect } from 'vitest';
import { MULTI_DOC_QA_SYSTEM_PROMPT } from '../src/lib/ai/prompts';

describe('Bug 3 - Comparison Answer Format Leads With Answer', () => {
  it('MULTI_DOC_QA_SYSTEM_PROMPT enforces first-sentence direct answer, topic breakdown, and preamble prohibition', () => {
    // 1. First sentence rule
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('FIRST SENTENCE DIRECT COMPARATIVE ANSWER');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('Version 2 has the longer notice period: 60 days versus 30 days in Version 1.');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('name the winner');

    // 2. Per-topic breakdown with Difference
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('CONCISE PER-TOPIC BREAKDOWN');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('Difference:');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('No difference: both specify');

    // 3. Prohibitions on filler and legal preamble
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('STRICTLY PROHIBIT legal preamble');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('general contract principles');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('Both contracts are commercial agreements governed by...');

    // 4. Output delimiter and machine format
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('<<<QUOTES>>>');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('"answerType": "comparison"');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('"doc": "DOC_1"');
    expect(MULTI_DOC_QA_SYSTEM_PROMPT).toContain('"doc": "DOC_2"');
  });

  function validateComparisonAnswerFormat(answer: string): {
    valid: boolean;
    errors: string[];
    firstSentence: string;
  } {
    const errors: string[] = [];
    const trimmed = answer.trim();
    const firstSentence = trimmed.split(/(?<=[.?!])\s+/)[0] || '';

    // Check prohibited preamble
    const preamblePatterns = [
      /^both\s+contracts\s+are\s+commercial\s+agreements/i,
      /^when\s+examining\s+(?:the\s+)?(?:two\s+)?contracts/i,
      /^in\s+contract\s+law/i,
      /^this\s+comparison\s+analyzes/i,
    ];
    for (const pat of preamblePatterns) {
      if (pat.test(firstSentence)) {
        errors.push(`First sentence contains prohibited preamble: "${firstSentence}"`);
      }
    }

    // Check that first sentence contains a direct comparative judgment
    const directAnswerPatterns = [
      /\b(?:has\s+the\s+longer|longer\s+notice|shorter\s+notice)\b/i,
      /\b(?:both\s+(?:contracts|use|have)|same\s+governing\s+law|no\s+differences?)\b/i,
      /\b(?:differ|differs|higher|lower|exceeds|winner)\b/i,
      /\byes\b/i,
      /\bno\b/i,
    ];
    if (!directAnswerPatterns.some((p) => p.test(firstSentence))) {
      errors.push(`First sentence does not provide a direct comparative answer: "${firstSentence}"`);
    }

    // Check for Difference: or No difference:
    if (!/\b(?:difference:|no\s+difference:)/i.test(answer)) {
      errors.push('Answer is missing an explicit "Difference:" or "No difference:" section');
    }

    return {
      valid: errors.length === 0,
      errors,
      firstSentence,
    };
  }

  it('validates compliant comparison answer for "Which contract has the longer notice period?"', () => {
    const compliantAnswer = `Version 2 has the longer notice period: 60 days versus 30 days in Version 1.

**Termination Notice Period**:
- Document 1 (large-contract-v1-150pages.pdf): Provides for termination for convenience with thirty (30) days' written notice [1].
- Document 2 (large-contract-v2-150pages.pdf): Provides for termination for convenience with sixty (60) days' written notice [2].
- Difference: Version 2 requires double the notice duration (60 days vs 30 days), giving the terminating party longer lead time.

<<<QUOTES>>>
{
  "answerType": "comparison",
  "citations": [
    { "id": 1, "doc": "DOC_1", "quote": "by providing thirty (30) days' written notice." },
    { "id": 2, "doc": "DOC_2", "quote": "by providing sixty (60) days' written notice." }
  ]
}`;

    const prose = compliantAnswer.split('<<<QUOTES>>>')[0];
    const validation = validateComparisonAnswerFormat(prose);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.firstSentence).toBe(
      'Version 2 has the longer notice period: 60 days versus 30 days in Version 1.'
    );
  });

  it('rejects answers that bury the answer under legal preamble or omit "Difference:"', () => {
    const nonCompliantAnswer = `Both contracts are commercial agreements governed by UAE law and contain standard provisions regarding termination and notices. Notice provisions are important mechanisms that allow parties to allocate risk when concluding commercial relationships.

In Section 21 of Document 1, there is a notice period. In Section 21 of Document 2, there is another notice period.

In conclusion, Version 2 has the longer notice period.`;

    const validation = validateComparisonAnswerFormat(nonCompliantAnswer);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes('prohibited preamble'))).toBe(true);
    expect(validation.errors.some((e) => e.includes('missing an explicit "Difference:"'))).toBe(true);
  });
});
