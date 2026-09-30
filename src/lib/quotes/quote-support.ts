import { VerifiedCitation } from '../types';

export interface QuoteSupportCheckResult {
  supportsClaim: boolean;
  warning?: string;
  supportStatus: 'supported' | 'unsupported' | 'related';
}

/**
 * Checks whether a verified quote actually supports the claim/question.
 * - For absence/not-found answers, marks quotes as "related" rather than evidence.
 * - For normal answers, performs keyword overlap gating to detect irrelevant quotes.
 */
export function checkQuoteSupport(
  question: string,
  answer: string,
  quote: string,
  isAbsenceAnswer = false
): QuoteSupportCheckResult {
  if (isAbsenceAnswer) {
    return {
      supportsClaim: false,
      warning: 'Related passages (do not answer the question)',
      supportStatus: 'related',
    };
  }

  // Tokenize question to extract core subject keywords
  const stopWords = new Set([
    'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
    'does', 'did', 'do', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on',
    'at', 'to', 'for', 'of', 'with', 'by', 'about', 'against', 'between',
    'into', 'through', 'during', 'before', 'after', 'above', 'below', 'from',
    'up', 'down', 'in', 'out', 'off', 'over', 'under', 'again', 'further',
    'then', 'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few',
    'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
    'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just',
    'should', 'now', 'contract', 'agreement', 'document', 'clause', 'section',
    'article', 'say', 'state', 'mention', 'contain', 'include', 'provide',
  ]);

  const cleanWords = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

  const qKeywords = cleanWords(question);
  const quoteWords = new Set(cleanWords(quote));

  if (qKeywords.length === 0) {
    return { supportsClaim: true, supportStatus: 'supported' };
  }

  // Count question keywords present in the quote (or in stems/substrings)
  let overlapCount = 0;
  for (const qk of qKeywords) {
    for (const qw of quoteWords) {
      if (qw === qk || qw.startsWith(qk) || qk.startsWith(qw)) {
        overlapCount++;
        break;
      }
    }
  }

  // If question specifically asks about a distinct subject (e.g. non-compete)
  // and the quote contains 0 overlapping keywords with the question terms:
  if (overlapCount === 0) {
    return {
      supportsClaim: false,
      warning: 'Verified text, but may not support this claim',
      supportStatus: 'unsupported',
    };
  }

  return {
    supportsClaim: true,
    supportStatus: 'supported',
  };
}

/**
 * Strips self-referential process descriptions such as "based on a thorough review",
 * "after reviewing the clause index", etc.
 */
export function sanitizeProcessDescriptions(text: string): string {
  if (!text) return '';
  return text
    .replace(/(?:based on\s+)?(?:a\s+)?(?:thorough|comprehensive|careful|detailed)\s+review\s+of\s+the\s+contract(?:\s+and\s+its\s+clause\s+index)?(?:[,\.]\s*)/gi, '')
    .replace(/based on the clause index(?:[,\.]\s*)/gi, '')
    .replace(/after reviewing the contract and its clause index(?:[,\.]\s*)/gi, '')
    .replace(/^I reviewed (?:all|the) (?:sections|contract|clauses)(?:\s+of\s+the\s+contract)?[,\.]\s*/gi, '')
    .trim();
}
