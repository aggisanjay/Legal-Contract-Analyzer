import { prisma } from '../prisma';
import { aiClient } from '../ai/client';
import { ClauseDifference, ContractComparisonResult, SignificanceLevel } from '../types';

/**
 * Compares two contracts at the clause and substantive legal level.
 */
export async function compareContracts(
  documentAId: string,
  documentBId: string
): Promise<ContractComparisonResult> {
  const [docA, docB] = await Promise.all([
    prisma.document.findUnique({
      where: { id: documentAId },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    }),
    prisma.document.findUnique({
      where: { id: documentBId },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    }),
  ]);

  if (!docA || !docB) {
    throw new Error('One or both documents to compare were not found.');
  }

  // Group chunks into sections/clauses for Document A and B
  const clausesA = extractClausesFromDocument(docA.extractedText || '', docA.chunks);
  const clausesB = extractClausesFromDocument(docB.extractedText || '', docB.chunks);

  const differences: ClauseDifference[] = [];

  // Match clauses across A and B by normalized title / section number / topic
  const matchedB = new Set<string>();

  for (const clauseA of clausesA) {
    // Find best match in clausesB
    let bestMatch: typeof clausesB[0] | null = null;
    let highestSim = 0;

    for (const clauseB of clausesB) {
      const sim = calculateClauseSimilarity(clauseA, clauseB);
      if (sim > highestSim && sim > 0.4) {
        highestSim = sim;
        bestMatch = clauseB;
      }
    }

    if (bestMatch) {
      matchedB.add(bestMatch.id);

      // Check if texts differ substantively
      if (normalizeText(clauseA.text) !== normalizeText(bestMatch.text)) {
        const analysis = await analyzeSubstantiveChange(
          clauseA.title,
          clauseA.text,
          bestMatch.text
        );

        differences.push({
          id: `diff_${clauseA.id}_${bestMatch.id}`,
          sectionNumber: clauseA.sectionNumber || bestMatch.sectionNumber,
          title: clauseA.title,
          significance: analysis.significance,
          originalText: clauseA.text,
          revisedText: bestMatch.text,
          substantiveChange: analysis.substantiveChange,
          plainLanguageImpact: analysis.plainLanguageImpact,
        });
      }
    } else {
      // Clause deleted in B
      const analysis = classifyClauseRemoval(clauseA.title, clauseA.text);
      differences.push({
        id: `diff_del_${clauseA.id}`,
        sectionNumber: clauseA.sectionNumber,
        title: clauseA.title,
        significance: analysis.significance,
        originalText: clauseA.text,
        revisedText: '[Clause removed in revised contract]',
        substantiveChange: `Clause "${clauseA.title}" was completely omitted.`,
        plainLanguageImpact: analysis.plainLanguageImpact,
      });
    }
  }

  // Check for clauses newly added in B
  for (const clauseB of clausesB) {
    if (!matchedB.has(clauseB.id)) {
      const analysis = classifyClauseAddition(clauseB.title, clauseB.text);
      differences.push({
        id: `diff_add_${clauseB.id}`,
        sectionNumber: clauseB.sectionNumber,
        title: clauseB.title,
        significance: analysis.significance,
        originalText: '[New clause added in revised contract]',
        revisedText: clauseB.text,
        substantiveChange: `New clause "${clauseB.title}" introduced.`,
        plainLanguageImpact: analysis.plainLanguageImpact,
      });
    }
  }

  // Calculate summary metrics
  const highCount = differences.filter((d) => d.significance === 'HIGH').length;
  const mediumCount = differences.filter((d) => d.significance === 'MEDIUM').length;
  const lowCount = differences.filter((d) => d.significance === 'LOW').length;

  let generalAssessment = 'No substantive differences detected between these two contract versions.';
  if (highCount > 0) {
    generalAssessment = `Found ${highCount} high-significance substantive legal change(s) impacting core liability, termination, or obligations. Review with legal counsel.`;
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

  // Persist comparison in database
  await prisma.comparison.create({
    data: {
      documentAId,
      documentBId,
      result: JSON.parse(JSON.stringify(result)),
    },
  });

  return result;
}

interface InternalClause {
  id: string;
  sectionNumber?: string;
  title: string;
  text: string;
}

function extractClausesFromDocument(
  text: string,
  chunks: Array<{ sectionNumber?: string | null; sectionTitle?: string | null; text: string }>
): InternalClause[] {
  // If chunks already have structured section data
  const grouped = new Map<string, { sectionNumber?: string; title: string; texts: string[] }>();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const key = (chunk.sectionTitle || chunk.sectionNumber || `Section_${Math.floor(i / 2)}`).trim();
    const existing = grouped.get(key);
    if (existing) {
      existing.texts.push(chunk.text);
    } else {
      grouped.set(key, {
        sectionNumber: chunk.sectionNumber || undefined,
        title: chunk.sectionTitle || key,
        texts: [chunk.text],
      });
    }
  }

  const clauses: InternalClause[] = [];
  let idx = 0;
  for (const [key, data] of grouped.entries()) {
    clauses.push({
      id: `clause_${idx++}`,
      sectionNumber: data.sectionNumber,
      title: data.title,
      text: data.texts.join('\n\n'),
    });
  }

  return clauses;
}

function calculateClauseSimilarity(a: InternalClause, b: InternalClause): number {
  if (a.sectionNumber && b.sectionNumber && a.sectionNumber === b.sectionNumber) {
    return 0.95;
  }

  const titleA = a.title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const titleB = b.title.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (titleA === titleB && titleA.length > 3) return 0.9;
  if (titleA.includes(titleB) || titleB.includes(titleA)) return 0.75;

  return 0;
}

function normalizeText(str: string): string {
  return str.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Analyzes substantive changes and determines legal significance (HIGH, MEDIUM, LOW).
 */
async function analyzeSubstantiveChange(
  title: string,
  oldText: string,
  newText: string
): Promise<{ significance: SignificanceLevel; substantiveChange: string; plainLanguageImpact: string }> {
  const titleLower = title.toLowerCase();

  // Pattern detection for HIGH significance legal categories:
  // Liability, Indemnity, Termination, Governing Law, Payment, Confidentiality, Warranties
  const isHighTopic =
    titleLower.includes('liabilit') ||
    titleLower.includes('indemn') ||
    titleLower.includes('terminat') ||
    titleLower.includes('govern') ||
    titleLower.includes('law') ||
    titleLower.includes('warrant') ||
    titleLower.includes('payment') ||
    titleLower.includes('confidential');

  // Check for monetary amount changes (e.g. AED 100,000 -> AED 1,000,000 or $50,000 -> $100,000)
  const moneyRegex = /(?:AED|USD|EUR|GBP|\$|€|£)\s*[\d,]+(?:\.\d+)?/gi;
  const moneyOld = oldText.match(moneyRegex) || [];
  const moneyNew = newText.match(moneyRegex) || [];

  if (moneyOld.length > 0 && moneyNew.length > 0 && moneyOld[0] !== moneyNew[0]) {
    return {
      significance: 'HIGH',
      substantiveChange: `Amount modified: ${moneyOld[0]} → ${moneyNew[0]}`,
      plainLanguageImpact: `The financial cap or obligation increased or shifted from ${moneyOld[0]} to ${moneyNew[0]}.`,
    };
  }

  // Check for day / notice period changes (e.g. 30 days -> 60 days)
  const daysRegex = /(\d+)\s*(?:days|business days|months)/gi;
  const daysOld = oldText.match(daysRegex) || [];
  const daysNew = newText.match(daysRegex) || [];

  if (daysOld.length > 0 && daysNew.length > 0 && daysOld[0] !== daysNew[0]) {
    const sig: SignificanceLevel = isHighTopic ? 'HIGH' : 'MEDIUM';
    return {
      significance: sig,
      substantiveChange: `Timeframe modified: ${daysOld[0]} → ${daysNew[0]}`,
      plainLanguageImpact: `The required notice period or deadline shifted from ${daysOld[0]} to ${daysNew[0]}.`,
    };
  }

  if (isHighTopic) {
    return {
      significance: 'HIGH',
      substantiveChange: `Substantive alterations made to ${title}.`,
      plainLanguageImpact: `Changes to ${title} directly affect legal exposure and rights under the contract.`,
    };
  }

  // Minor vs procedural
  if (titleLower.includes('notice') || titleLower.includes('procedure') || titleLower.includes('audit')) {
    return {
      significance: 'MEDIUM',
      substantiveChange: `Procedural adjustments to ${title}.`,
      plainLanguageImpact: `Operational steps or requirements have been revised.`,
    };
  }

  return {
    significance: 'LOW',
    substantiveChange: `Minor wording or stylistic adjustments.`,
    plainLanguageImpact: `No material shift in contractual legal rights or obligations.`,
  };
}

function classifyClauseRemoval(
  title: string,
  text: string
): { significance: SignificanceLevel; plainLanguageImpact: string } {
  const lower = (title + ' ' + text).toLowerCase();
  if (/liabilit|indemn|terminat|govern|law|confidential|payment/.test(lower)) {
    return {
      significance: 'HIGH',
      plainLanguageImpact: `Removal of this critical clause may expose parties to unlimited exposure or jurisdictional uncertainty.`,
    };
  }
  return {
    significance: 'MEDIUM',
    plainLanguageImpact: `The provision was omitted in the revised version.`,
  };
}

function classifyClauseAddition(
  title: string,
  text: string
): { significance: SignificanceLevel; plainLanguageImpact: string } {
  const lower = (title + ' ' + text).toLowerCase();
  if (/liabilit|indemn|terminat|govern|law|confidential|payment/.test(lower)) {
    return {
      significance: 'HIGH',
      plainLanguageImpact: `A new material obligation or legal restriction was introduced.`,
    };
  }
  return {
    significance: 'MEDIUM',
    plainLanguageImpact: `A new contractual section was added.`,
  };
}
