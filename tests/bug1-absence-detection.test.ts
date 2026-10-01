import { describe, it, expect } from 'vitest';
import { isAbsenceClaim, enforceAbsenceCoverage, parseQuotesPayload } from '../src/lib/ai/coverage';
import { checkQuoteSupport } from '../src/lib/quotes/quote-support';

describe('Bug 1: Absence Detection Based on Retrieval/Extraction & answerType', () => {
  it('(a) "same governing law" answer containing "There are no differences" keeps quotes as green Verified', () => {
    const question = 'Do both contracts have the same governing law?';
    const answer =
      'Yes — both contracts use the same governing law (Dubai / UAE federal law).\n\n' +
      '**Governing Law**:\n' +
      '- DOC_1 (large-contract-v1-150pages.pdf): Governed by the laws of Dubai [1].\n' +
      '- DOC_2 (large-contract-v2-150pages.pdf): Governed by the laws of Dubai [2].\n' +
      '- Difference: There are no differences between Document A and Document B regarding governing law.';

    const machinePayload = JSON.stringify({
      answerType: 'comparison',
      citations: [
        { id: 1, doc: 'DOC_1', quote: 'This Agreement shall be governed by the laws of the Emirate of Dubai.' },
        { id: 2, doc: 'DOC_2', quote: 'This Contract is governed in all respects by Dubai law.' },
      ],
    });

    const parsed = parseQuotesPayload(machinePayload, 'comparison');
    expect(parsed.answerType).toBe('comparison');
    expect(parsed.citations.length).toBe(2);

    // Must NOT be classified as an absence claim
    const isAbsence = isAbsenceClaim(answer, parsed.answerType);
    expect(isAbsence).toBe(false);

    // Verified quotes must receive supportStatus: 'supported' (Green "Verified"), NEVER 'related'
    for (const c of parsed.citations) {
      const support = checkQuoteSupport(question, answer, c.quote, isAbsence);
      expect(support.supportStatus).toBe('supported');
      expect(support.warning).toBeUndefined();
    }
  });

  it('(b) the non-compete question over 150/150 pages gives not_found with no green quotes', () => {
    const question = 'Does the contract contain a non-compete clause?';
    const answer = 'The contract contains no non-compete clause (searched all 150 pages).';
    const machinePayload = JSON.stringify({
      answerType: 'not_found',
      citations: [],
    });

    const parsed = parseQuotesPayload(machinePayload, 'not_found');
    expect(parsed.answerType).toBe('not_found');

    const isAbsence = isAbsenceClaim(answer, parsed.answerType);
    expect(isAbsence).toBe(true);

    // If any passage was returned, it must be marked as 'related' (not green 'supported')
    const passage = '14. Confidentiality and Non-Disclosure obligations between parties.';
    const support = checkQuoteSupport(question, answer, passage, isAbsence);
    expect(support.supportStatus).toBe('related');
    expect(support.warning).toBe('Related passages (do not answer the question)');
  });

  it('(c) a partial-coverage not_found is rewritten to "I looked at pages X but did not read the whole document…"', () => {
    const rawAnswer = 'The contract does not contain a non-compete clause.';
    const pagesExaminedList = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const pagesExamined = 10;
    const pagesTotal = 150;

    const result = enforceAbsenceCoverage(
      rawAnswer,
      pagesExaminedList,
      pagesExamined,
      pagesTotal,
      'not_found'
    );

    expect(result.isAbsence).toBe(true);
    expect(result.modifiedText).toBe(
      "I looked at pages 1–10 but did not read the whole document, so I can't confirm this clause is absent."
    );
  });

  it('(d) a comparison answer with the words "no differences" is never rewritten', () => {
    const rawAnswer =
      'There are no differences between Document A and Document B regarding the limitation of liability cap.';
    const pagesExaminedList = [1, 2, 3, 4, 5];
    const pagesExamined = 5;
    const pagesTotal = 150;

    const result = enforceAbsenceCoverage(
      rawAnswer,
      pagesExaminedList,
      pagesExamined,
      pagesTotal,
      'comparison'
    );

    expect(result.isAbsence).toBe(false);
    expect(result.modifiedText).toBe(rawAnswer);
    expect(result.modifiedText).not.toContain("can't confirm this clause is absent");
  });
});
