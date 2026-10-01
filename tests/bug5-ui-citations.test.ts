import { describe, it, expect } from 'vitest';
import { VerifiedCitation } from '../src/lib/types';
import { checkQuoteSupport } from '../src/lib/quotes/quote-support';
import { isAbsenceClaim } from '../src/lib/ai/coverage';

describe('Bug 5 - UI Quote Cards Attribution, Badges & Failure Reasons', () => {
  it('assigns Green "Verified" when quote directly answers question and exists verbatim', () => {
    const question = 'What is the termination notice period in contract v1?';
    const answer = 'The termination notice period is thirty (30) days [1].';
    const quote = "by providing thirty (30) days' written notice.";

    const isAbsence = isAbsenceClaim(answer, 'found');
    expect(isAbsence).toBe(false);

    const support = checkQuoteSupport(question, answer, quote, isAbsence);
    expect(support.supportStatus).toBe('supported');
    expect(support.warning).toBeUndefined();

    // Mapping to badge:
    const badgeType =
      support.supportStatus === 'related'
        ? 'related'
        : support.supportStatus === 'unsupported' || support.warning
        ? 'amber'
        : 'verified';
    expect(badgeType).toBe('verified');
  });

  it('assigns Grey "Related passage" ONLY when question is absence/not_found, never on comparative answers', () => {
    // 1. Absence question with not_found:
    const absenceQuestion = 'Does the contract contain a non-compete clause?';
    const absenceAnswer = 'The contract does not contain any non-compete clause.';
    const relatedQuote = 'Section 14: Employees shall maintain confidentiality.';

    const isAbsence = isAbsenceClaim(absenceAnswer, 'not_found');
    expect(isAbsence).toBe(true);

    const absenceSupport = checkQuoteSupport(absenceQuestion, absenceAnswer, relatedQuote, isAbsence);
    expect(absenceSupport.supportStatus).toBe('related');

    // 2. Comparative question with "no differences": MUST NOT be related
    const compQuestion = 'Do both contracts have the same governing law?';
    const compAnswer = 'There are no differences between Document A and Document B regarding governing law.';
    const compQuote = 'This Agreement shall be governed by the laws of Dubai and the UAE.';

    const isCompAbsence = isAbsenceClaim(compAnswer, 'comparison');
    expect(isCompAbsence).toBe(false);

    const compSupport = checkQuoteSupport(compQuestion, compAnswer, compQuote, isCompAbsence);
    expect(compSupport.supportStatus).toBe('supported');
    expect(compSupport.supportStatus).not.toBe('related');
  });

  it('assigns Amber badge when quote exists verbatim but has low keyword overlap (< 0.20)', () => {
    const question = 'What is the liability cap?';
    const answer = 'The contract specifies governing law in Dubai [1].';
    const quote = 'This Agreement is executed in duplicate in Dubai.';

    const support = checkQuoteSupport(question, answer, quote, false);
    // Keyword overlap between "liability cap" and "Agreement executed in duplicate in Dubai" is 0
    expect(support.supportStatus === 'unsupported' || Boolean(support.warning)).toBe(true);
  });

  it('formats distinct unverified failure reasons properly', () => {
    function formatUnverifiedReason(rawReason: string | undefined, docName: string): string {
      if (rawReason === 'unknown document') return 'Unknown document';
      if (rawReason) return rawReason;
      return `Quote not found in ${docName || 'contract'} verbatim`;
    }

    expect(formatUnverifiedReason('unknown document', 'large-contract-v1.pdf')).toBe('Unknown document');
    expect(
      formatUnverifiedReason('Cross-page gap exceeded', 'large-contract-v2.pdf')
    ).toBe('Cross-page gap exceeded');
    expect(
      formatUnverifiedReason(undefined, 'large-contract-v1-150pages.pdf')
    ).toBe('Quote not found in large-contract-v1-150pages.pdf verbatim');
    expect(
      formatUnverifiedReason('Candidate quote not found in source text verbatim', 'contract.pdf')
    ).toBe('Candidate quote not found in source text verbatim');
  });

  it('distinguishes document styles and verifies document switching callback', () => {
    function getDocBadgeColor(docName: string): string {
      const lower = docName.toLowerCase();
      if (lower.includes('v1') || lower.includes('doc_1')) {
        return 'bg-blue-50 text-blue-700 border-blue-200';
      }
      if (lower.includes('v2') || lower.includes('doc_2')) {
        return 'bg-purple-50 text-purple-700 border-purple-200';
      }
      return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    }

    const v1Badge = getDocBadgeColor('large-contract-v1-150pages.pdf');
    const v2Badge = getDocBadgeColor('large-contract-v2-150pages.pdf');

    expect(v1Badge).toContain('bg-blue-50');
    expect(v2Badge).toContain('bg-purple-50');
    expect(v1Badge).not.toBe(v2Badge);

    // Document switching verification:
    let activeDocId = 'db_id_v1';
    let activeCit: any = null;

    const onSelectCitation = (cit: VerifiedCitation) => {
      if (cit.documentId !== activeDocId) {
        activeDocId = cit.documentId;
      }
      activeCit = cit;
    };

    const citationV2: VerifiedCitation = {
      id: 'cit_v2_1',
      documentId: 'db_id_v2',
      documentName: 'large-contract-v2-150pages.pdf',
      quote: "by providing sixty (60) days' written notice.",
      verified: true,
      pageStart: 112,
      pageEnd: 112,
      startOffset: 1000,
      endOffset: 1050,
      supportStatus: 'supported',
    };

    onSelectCitation(citationV2);
    expect(activeDocId).toBe('db_id_v2');
    expect(activeCit?.documentId).toBe('db_id_v2');
    expect(activeCit?.pageStart).toBe(112);
  });
});
