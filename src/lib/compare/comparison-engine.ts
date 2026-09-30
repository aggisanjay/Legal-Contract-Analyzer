import { prisma } from '../prisma';
import { aiClient } from '../ai/client';
import { ClauseDifference, ContractComparisonResult, SignificanceLevel } from '../types';

export interface DiffSegment {
  type: 'equal' | 'insert' | 'delete';
  text: string;
}

/**
 * Computes word-level LCS (Longest Common Subsequence) diff segments.
 * Fast, memory-bounded, zero external dependencies.
 */
export function computeWordLcsDiff(textA: string, textB: string): DiffSegment[] {
  const wordsA = textA.split(/(\s+)/).filter(Boolean);
  const wordsB = textB.split(/(\s+)/).filter(Boolean);

  const m = wordsA.length;
  const n = wordsB.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ type: 'insert', text: textB }];
  if (n === 0) return [{ type: 'delete', text: textA }];

  // Fallback for extremely huge blocks to avoid memory limits
  if (m * n > 4000000) {
    return [
      { type: 'delete', text: textA },
      { type: 'insert', text: textB },
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (wordsA[i] === wordsB[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const rawSegments: DiffSegment[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && wordsA[i - 1] === wordsB[j - 1]) {
      rawSegments.push({ type: 'equal', text: wordsA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawSegments.push({ type: 'insert', text: wordsB[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawSegments.push({ type: 'delete', text: wordsA[i - 1] });
      i--;
    }
  }

  rawSegments.reverse();

  // Merge consecutive segments of the same type
  const merged: DiffSegment[] = [];
  for (const seg of rawSegments) {
    if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
      merged[merged.length - 1].text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

/**
 * Computes token Jaccard similarity between two text blocks.
 */
export function computeTokenJaccard(textA: string, textB: string): number {
  const setA = new Set(
    textA
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
  const setB = new Set(
    textB
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export interface InternalClause {
  id: string;
  sectionNumber?: string;
  title: string;
  text: string;
}

/**
 * Splits document text into clean clauses by detected section headings or paragraphs.
 * Does NOT group overlapping chunks to prevent text pollution.
 */
export function extractClausesFromDocument(extractedText: string): InternalClause[] {
  if (!extractedText || !extractedText.trim()) return [];

  const clauses: InternalClause[] = [];
  const lines = extractedText.split('\n');

  let currentNumber: string | undefined;
  let currentTitle = 'General Provisions';
  let currentLines: string[] = [];
  let clauseIndex = 0;

  const sectionRegex =
    /^(?:(?:SECTION|CLAUSE|ARTICLE)\s+([0-9A-Z.]+)|([0-9]{1,2}(?:\.[0-9]+)*))\s*[:.—-]?\s*(.*)$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      currentLines.push('');
      continue;
    }

    const match = trimmed.match(sectionRegex);
    if (match && trimmed.length < 120) {
      // Flush previous clause if non-empty
      const textBlock = currentLines.join('\n').trim();
      if (textBlock.length > 0) {
        clauses.push({
          id: `clause_${clauseIndex++}`,
          sectionNumber: currentNumber,
          title: currentTitle,
          text: textBlock,
        });
        currentLines = [];
      }

      currentNumber = (match[1] || match[2] || '').trim();
      currentTitle = (match[3] || `Section ${currentNumber}`).trim();
      currentLines = [trimmed];
    } else {
      currentLines.push(line);
    }
  }

  // Flush trailing clause
  const finalBlock = currentLines.join('\n').trim();
  if (finalBlock.length > 0) {
    clauses.push({
      id: `clause_${clauseIndex++}`,
      sectionNumber: currentNumber,
      title: currentTitle,
      text: finalBlock,
    });
  }

  // If no numbered sections were detected, split by double newlines
  if (clauses.length <= 1 && extractedText.includes('\n\n')) {
    const paragraphs = extractedText.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 20);
    return paragraphs.map((p, idx) => ({
      id: `clause_p_${idx}`,
      title: `Paragraph ${idx + 1}`,
      text: p,
    }));
  }

  return clauses;
}

/**
 * Deterministic guard: checks if numbers, currencies, durations, or modal verbs differ.
 */
export function extractDifferencesGuard(oldText: string, newText: string): {
  hasNumericChange: boolean;
  hasModalChange: boolean;
  numericSummary?: string;
  isRewordedOnly: boolean;
} {
  const moneyRegex = /(?:AED|USD|EUR|GBP|\$|€|£)\s*[\d,]+(?:\.\d+)?/gi;
  const moneyOld = oldText.match(moneyRegex) || [];
  const moneyNew = newText.match(moneyRegex) || [];

  const durRegex = /\b\d+\s*(?:business\s+)?(?:days|months|years|hours|weeks)\b/gi;
  const durOld = oldText.match(durRegex) || [];
  const durNew = newText.match(durRegex) || [];

  const numRegex = /\b\d+(?:,\d+)*(?:\.\d+)?\b/g;
  const numsOld = oldText.match(numRegex) || [];
  const numsNew = newText.match(numRegex) || [];

  const modalRegex = /\b(shall|may|must|not|cannot|will|should)\b/gi;
  const modalsOld = (oldText.match(modalRegex) || []).map((m) => m.toLowerCase()).sort().join(' ');
  const modalsNew = (newText.match(modalRegex) || []).map((m) => m.toLowerCase()).sort().join(' ');

  let hasNumericChange = false;
  let numericSummary = '';

  if (moneyOld.join(' ') !== moneyNew.join(' ')) {
    hasNumericChange = true;
    numericSummary = `${moneyOld[0] || 'none'} → ${moneyNew[0] || 'none'}`;
  } else if (durOld.join(' ') !== durNew.join(' ')) {
    hasNumericChange = true;
    numericSummary = `${durOld[0] || 'none'} → ${durNew[0] || 'none'}`;
  } else if (numsOld.join(' ') !== numsNew.join(' ')) {
    hasNumericChange = true;
    numericSummary = `${numsOld[0] || 'none'} → ${numsNew[0] || 'none'}`;
  }

  const hasModalChange = modalsOld !== modalsNew;
  const jaccard = computeTokenJaccard(oldText, newText);
  const isRewordedOnly = !hasNumericChange && !hasModalChange && jaccard >= 0.75;

  return {
    hasNumericChange,
    hasModalChange,
    numericSummary: numericSummary || undefined,
    isRewordedOnly,
  };
}

/**
 * Analyzes substantive changes and determines legal significance (HIGH, MEDIUM, LOW).
 */
export async function analyzeSubstantiveChange(
  title: string,
  oldText: string,
  newText: string
): Promise<{
  significance: SignificanceLevel;
  changeType: 'added' | 'removed' | 'modified' | 'reworded';
  substantiveChange: string;
  plainLanguageImpact: string;
  numericOrDateChanges?: string;
}> {
  const guard = extractDifferencesGuard(oldText, newText);
  const titleLower = title.toLowerCase();

  const isHighTopic =
    titleLower.includes('liabilit') ||
    titleLower.includes('indemn') ||
    titleLower.includes('terminat') ||
    titleLower.includes('govern') ||
    titleLower.includes('law') ||
    titleLower.includes('warrant') ||
    titleLower.includes('payment') ||
    titleLower.includes('confidential');

  // Try calling LLM for structured evaluation
  try {
    const prompt = `Compare these two contract clause versions:
SECTION TITLE: "${title}"

ORIGINAL VERSION:
"${oldText}"

REVISED VERSION:
"${newText}"

Return JSON:
{
  "significance": "HIGH" | "MEDIUM" | "LOW",
  "changeType": "modified" | "reworded",
  "substantiveChange": "One-sentence plain-language summary of what legally changed",
  "plainLanguageImpact": "Impact on rights and legal exposure",
  "numericChanges": "e.g. AED 100,000 → AED 1,000,000 or null"
}`;

    const completion = await aiClient.createChatCompletion({
      messages: [
        {
          role: 'system',
          content: 'You are an expert contract difference analyzer. Output valid JSON only.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      responseFormatJson: true,
    });

    const parsedMatch = completion.content?.match(/\{[\s\S]*\}/);
    if (parsedMatch) {
      const data = JSON.parse(parsedMatch[0]);
      let sig: SignificanceLevel = data.significance || 'MEDIUM';

      // Deterministic guard enforcement:
      // If numbers, currencies, durations, or modal verbs differ, significance can never be LOW!
      if ((guard.hasNumericChange || guard.hasModalChange) && sig === 'LOW') {
        sig = 'MEDIUM';
      }
      if (guard.hasNumericChange && isHighTopic) {
        sig = 'HIGH';
      }

      const cType = guard.isRewordedOnly ? 'reworded' : data.changeType || 'modified';

      return {
        significance: sig,
        changeType: cType,
        substantiveChange: data.substantiveChange || `Revisions made to ${title}.`,
        plainLanguageImpact: data.plainLanguageImpact || 'Contract terms have been updated.',
        numericOrDateChanges: guard.numericSummary || data.numericChanges || undefined,
      };
    }
  } catch {
    // Graceful fallback to rules-based classifier marked auto-classified
  }

  // Rules-based deterministic fallback
  let fallbackSig: SignificanceLevel = 'LOW';
  if (guard.hasNumericChange && isHighTopic) {
    fallbackSig = 'HIGH';
  } else if (guard.hasNumericChange || isHighTopic || guard.hasModalChange) {
    fallbackSig = 'MEDIUM';
  }

  const changeType = guard.isRewordedOnly ? 'reworded' : 'modified';
  const numericDesc = guard.numericSummary ? ` (${guard.numericSummary})` : '';

  return {
    significance: fallbackSig,
    changeType,
    substantiveChange: `[auto-classified] Clause "${title}" modified${numericDesc}.`,
    plainLanguageImpact: guard.hasNumericChange
      ? `Material amounts or timeframes changed: ${guard.numericSummary}.`
      : `Substantive alterations made to ${title}.`,
    numericOrDateChanges: guard.numericSummary,
  };
}

/**
 * Main comparison engine entry point.
 */
export async function compareContracts(
  documentAId: string,
  documentBId: string
): Promise<ContractComparisonResult> {
  const [docA, docB] = await Promise.all([
    prisma.document.findUnique({
      where: { id: documentAId },
      select: { id: true, originalFilename: true, extractedText: true },
    }),
    prisma.document.findUnique({
      where: { id: documentBId },
      select: { id: true, originalFilename: true, extractedText: true },
    }),
  ]);

  if (!docA || !docB) {
    throw new Error('One or both documents to compare were not found.');
  }

  const clausesA = extractClausesFromDocument(docA.extractedText || '');
  const clausesB = extractClausesFromDocument(docB.extractedText || '');

  const differences: ClauseDifference[] = [];
  const matchedB = new Set<string>();

  // Multi-pass clause alignment:
  // Pass 1: exact section number + title match
  // Pass 2: title similarity
  // Pass 3: text similarity (token Jaccard >= 0.5) to catch renumbered clauses
  for (const clauseA of clausesA) {
    let bestMatch: InternalClause | null = null;
    let highestSim = 0;

    for (const clauseB of clausesB) {
      if (matchedB.has(clauseB.id)) continue;

      let sim = 0;
      // Exact number + title
      if (
        clauseA.sectionNumber &&
        clauseB.sectionNumber &&
        clauseA.sectionNumber.toLowerCase() === clauseB.sectionNumber.toLowerCase()
      ) {
        sim = 0.95;
      } else {
        const titleA = clauseA.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        const titleB = clauseB.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (titleA === titleB && titleA.length > 3) {
          sim = 0.9;
        } else if (titleA.includes(titleB) || titleB.includes(titleA)) {
          sim = 0.75;
        } else {
          // Token Jaccard >= 0.5 to catch renumbered clauses
          const textSim = computeTokenJaccard(clauseA.text, clauseB.text);
          if (textSim >= 0.5) {
            sim = textSim;
          }
        }
      }

      if (sim > highestSim && sim >= 0.5) {
        highestSim = sim;
        bestMatch = clauseB;
      }
    }

    if (bestMatch) {
      matchedB.add(bestMatch.id);

      // Skip clauses that are equal after normalization
      const normA = clauseA.text.replace(/\s+/g, ' ').trim().toLowerCase();
      const normB = bestMatch.text.replace(/\s+/g, ' ').trim().toLowerCase();

      if (normA !== normB) {
        const analysis = await analyzeSubstantiveChange(
          clauseA.title,
          clauseA.text,
          bestMatch.text
        );

        const diffSegments = computeWordLcsDiff(clauseA.text, bestMatch.text);

        differences.push({
          id: `diff_${clauseA.id}_${bestMatch.id}`,
          sectionNumber: clauseA.sectionNumber || bestMatch.sectionNumber,
          title: clauseA.title,
          significance: analysis.significance,
          changeType: analysis.changeType,
          originalText: clauseA.text,
          revisedText: bestMatch.text,
          substantiveChange: analysis.substantiveChange,
          plainLanguageImpact: analysis.plainLanguageImpact,
          numericOrDateChanges: analysis.numericOrDateChanges,
          diffSegments,
        });
      }
    } else {
      // Unmatched in B -> Clause removed
      const guard = extractDifferencesGuard(clauseA.text, '');
      const lower = (clauseA.title + ' ' + clauseA.text).toLowerCase();
      const isCritical = /liabilit|indemn|terminat|govern|law|confidential|payment/.test(lower);
      const significance: SignificanceLevel = isCritical ? 'HIGH' : 'MEDIUM';

      differences.push({
        id: `diff_del_${clauseA.id}`,
        sectionNumber: clauseA.sectionNumber,
        title: clauseA.title,
        significance,
        changeType: 'removed',
        originalText: clauseA.text,
        revisedText: '[Clause removed in revised contract]',
        substantiveChange: `Clause "${clauseA.title}" was completely omitted.`,
        plainLanguageImpact: isCritical
          ? `Removal of ${clauseA.title} creates material legal exposure or shifts standard rights.`
          : 'Provision was removed in revised contract.',
        numericOrDateChanges: guard.numericSummary,
        diffSegments: [{ type: 'delete', text: clauseA.text }],
      });
    }
  }

  // Unmatched in A -> Clause newly added in B
  for (const clauseB of clausesB) {
    if (!matchedB.has(clauseB.id)) {
      const guard = extractDifferencesGuard('', clauseB.text);
      const lower = (clauseB.title + ' ' + clauseB.text).toLowerCase();
      const isCritical = /liabilit|indemn|terminat|govern|law|confidential|payment/.test(lower);
      const significance: SignificanceLevel = isCritical ? 'HIGH' : 'MEDIUM';

      differences.push({
        id: `diff_add_${clauseB.id}`,
        sectionNumber: clauseB.sectionNumber,
        title: clauseB.title,
        significance,
        changeType: 'added',
        originalText: '[New clause added in revised contract]',
        revisedText: clauseB.text,
        substantiveChange: `New clause "${clauseB.title}" introduced.`,
        plainLanguageImpact: isCritical
          ? `Introduction of ${clauseB.title} adds substantial contractual obligations or restrictions.`
          : 'A new clause was added to the contract.',
        numericOrDateChanges: guard.numericSummary,
        diffSegments: [{ type: 'insert', text: clauseB.text }],
      });
    }
  }

  // Calculate summary metrics
  const highCount = differences.filter((d) => d.significance === 'HIGH').length;
  const mediumCount = differences.filter((d) => d.significance === 'MEDIUM').length;
  const lowCount = differences.filter((d) => d.significance === 'LOW').length;

  let generalAssessment = 'No substantive differences detected between these two contract versions.';
  if (highCount > 0) {
    generalAssessment = `Found ${highCount} high-significance substantive legal change(s) impacting core liability, termination, or financial obligations. Review carefully with legal counsel.`;
  } else if (mediumCount > 0) {
    generalAssessment = `Found ${mediumCount} medium-significance procedural or operational adjustment(s).`;
  } else if (lowCount > 0) {
    generalAssessment = `Found ${lowCount} minor stylistic or formatting adjustment(s).`;
  }

  const result: ContractComparisonResult = {
    documentAId,
    documentAName: docA.originalFilename,
    documentBId,
    documentBName: docB.originalFilename,
    differences,
    summary: {
      highCount,
      mediumCount,
      lowCount,
      totalCount: differences.length,
      generalAssessment,
    },
  };

  // Persist in database
  await prisma.comparison.create({
    data: {
      documentAId,
      documentBId,
      result: JSON.parse(JSON.stringify(result)),
    },
  });

  return result;
}
