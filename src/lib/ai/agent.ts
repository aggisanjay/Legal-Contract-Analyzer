import { z } from 'zod';
import { aiClient, ChatMessageParam, ToolDefinition } from './client';
import {
  retrieveChunksForDocument,
  getSectionContent,
  listDocumentClauses,
  detectDirectSectionQuestion,
} from './retriever';
import { verifyQuoteForDocument } from '../quotes/quote-verifier';
import { AGENT_RESEARCH_SYSTEM_PROMPT } from './prompts';
import { prisma } from '../prisma';
import { AgentProgressEvent, VerifiedCitation } from '../types';
import { enforceAbsenceCoverage } from './coverage';
import { deduplicateVerifiedCitations } from '../utils/format';
import { checkQuoteSupport, sanitizeProcessDescriptions } from '../quotes/quote-support';

import {
  MACHINE_DELIMITER,
  LEGACY_DELIMITER,
  StreamQuoteDelimiterParser,
  cleanAnswerPreambleAndSeparators,
} from './stream-cleaner';

export const SearchDocumentSchema = z.object({
  query: z.string().min(1, 'Query must not be empty'),
  documentId: z.string().optional(),
  topK: z.number().int().positive().optional().default(4),
});

export const GetSectionSchema = z.object({
  sectionNumber: z.string().min(1, 'Section number must not be empty'),
  offset: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().optional().default(15000),
  documentId: z.string().optional(),
});

export const ListClausesSchema = z.object({
  documentId: z.string().optional(),
});

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_document',
      description: 'Search contract clauses and text for specific terms, topics, or numbers.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or clause topic',
          },
          documentId: {
            type: 'string',
            description: 'Optional document ID to search within in multi-document mode',
          },
          topK: {
            type: 'integer',
            description: 'Number of passages to return (default 4)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_section',
      description: 'Retrieve the full text of a specific contract section by its number (e.g. "55", "12", "14.2", "Article 55").',
      parameters: {
        type: 'object',
        properties: {
          sectionNumber: {
            type: 'string',
            description: 'The section or clause number, e.g. "12", "14.2", "55", "Article 55"',
          },
          offset: {
            type: 'integer',
            description: 'Optional character offset for paging if section was truncated',
          },
          limit: {
            type: 'integer',
            description: 'Optional character limit to retrieve (default 15000)',
          },
          documentId: {
            type: 'string',
            description: 'Optional document ID',
          },
        },
        required: ['sectionNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_clauses',
      description: 'List all indexed section numbers and clause headings in the contract.',
      parameters: {
        type: 'object',
        properties: {
          documentId: {
            type: 'string',
            description: 'Optional document ID',
          },
        },
      },
    },
  },
];

export interface RunAgentOptions {
  documentId: string;
  documentIds?: string[];
  documentName?: string;
  pageCount?: number;
  question: string;
  onProgress?: (event: AgentProgressEvent & { resultSummary?: string }) => void;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  maxRounds?: number;
}

export interface AgentCoverageInfo {
  chunksExamined: number;
  chunksTotal: number;
  pagesExamined: number;
  pagesTotal: number;
  pagesExaminedList: number[];
  strategy: 'agentic';
  incomplete: boolean;
}

export interface AgentResult {
  answer: string;
  citations: VerifiedCitation[];
  roundsExecuted: number;
  coverage: AgentCoverageInfo;
}

const MAX_CHAR_BUDGET = 70000;
const MAX_TOOLS_PER_ROUND = 4;

/**
 * Executes Part C: Hardened Agentic Document Research with tool step timelines,
 * character budget limits, multi-document capability, and structured quote verification.
 */
export async function runAgenticDocumentResearch(
  options: RunAgentOptions
): Promise<AgentResult> {
  const {
    documentId,
    documentIds = [documentId],
    documentName = 'contract.pdf',
    question,
    onProgress,
    onToken,
    signal,
  } = options;
  const maxRounds = options.maxRounds || parseInt(process.env.MAX_AGENT_ROUNDS || '5', 10) || 5;

  onProgress?.({
    stage: 'searching',
    message: `Initiating agent research: "${question.slice(0, 50)}..."`,
    round: 1,
  });

  const messages: ChatMessageParam[] = [
    {
      role: 'system',
      content: AGENT_RESEARCH_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Analyze this contract to answer the following question:\n"${question}"\n\nUse your research tools to explore the document before answering. Structure your final answer with prose and inline markers [[1]], [[2]], followed by delimiter "<<<QUOTES>>>" and the JSON array of candidate quotes.`,
    },
  ];

  let round = 0;
  let finalResponseText: string | null = null;
  let totalCharsAccumulated = 0;
  let hitBudgetLimit = false;
  let hitCapBeforeAnswering = false;

  const examinedChunkIds = new Set<string>();
  const examinedPagesSet = new Set<number>();
  const executedToolCalls = new Map<string, number>();
  const queryCounts = new Map<string, number>();

  // Direct section question shortcut: skip agent loop for "What does Article N say?"
  const directSec = detectDirectSectionQuestion(question);
  if (directSec.isDirectSection && directSec.sectionNumber) {
    onProgress?.({
      stage: 'reading',
      message: `Direct section shortcut: reading Section/Article ${directSec.sectionNumber}...`,
      round: 1,
    });

    const section = await getSectionContent(documentId, directSec.sectionNumber);
    if (section && section.text.trim().length > 0) {
      for (const cid of section.chunkIds) examinedChunkIds.add(cid);
      for (const p of section.pages) examinedPagesSet.add(p);

      const sectionPrompt = `You are summarizing Section/Article ${directSec.sectionNumber}${section.heading ? ` (${section.heading})` : ''} from page ${section.pageStart} to ${section.pageEnd} of the contract.

Text:
"""
${section.text}
"""

Question: "${question}"

STRICT INSTRUCTIONS:
1. Quote and summarize the operative sentences directly (e.g. covenants, liability caps, remedies, termination terms). Do NOT paraphrase filler text.
2. Provide at most 5 concise sentences highlighting the operative terms.
3. Include verbatim inline citations [[1]], [[2]] for each operative quote.
4. Structure your response into prose followed by the delimiter "<<<QUOTES>>>" and the JSON array of candidate quotes.
5. NEVER describe your own review process.`;

      try {
        if (onToken) {
          const parser = new StreamQuoteDelimiterParser(onToken);
          const streamGen = aiClient.streamChatCompletion({
            messages: [
              { role: 'system', content: AGENT_RESEARCH_SYSTEM_PROMPT },
              { role: 'user', content: sectionPrompt },
            ],
            temperature: 0.1,
            signal,
          });
          for await (const chunk of streamGen) {
            if (signal?.aborted) break;
            parser.feed(chunk.text);
          }
          const flushed = parser.flush();
          finalResponseText = `${flushed.prose}\n<<<QUOTES>>>\n${flushed.quotesJson}`;
        } else {
          const comp = await aiClient.createChatCompletion({
            messages: [
              { role: 'system', content: AGENT_RESEARCH_SYSTEM_PROMPT },
              { role: 'user', content: sectionPrompt },
            ],
            temperature: 0.1,
          });
          if (comp.content) {
            finalResponseText = comp.content;
          }
        }
        round = 1;
      } catch (err) {
        console.warn('[Agent] Direct section shortcut failed, falling back to agent search:', err);
      }
    }
  }

  while (!finalResponseText && round < maxRounds) {
    round++;

    onProgress?.({
      stage: 'reasoning',
      message: `Agent reasoning (Round ${round} of ${maxRounds})...`,
      round,
    });

    // Check token / character budget guard
    if (totalCharsAccumulated > MAX_CHAR_BUDGET) {
      hitBudgetLimit = true;
      hitCapBeforeAnswering = true;
      break;
    }

    const isLastRound = round >= maxRounds;

    if (isLastRound && onToken) {
      const parser = new StreamQuoteDelimiterParser(onToken);
      try {
        const streamGen = aiClient.streamChatCompletion({
          messages,
          temperature: 0.1,
          signal,
        });
        for await (const chunk of streamGen) {
          if (signal?.aborted) break;
          parser.feed(chunk.text);
        }
        const flushed = parser.flush();
        finalResponseText = `${flushed.prose}\n<<<QUOTES>>>\n${flushed.quotesJson}`;
        hitCapBeforeAnswering = true;
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'AI streaming completion failed';
        onProgress?.({
          stage: 'error',
          message: `Research round error: ${msg}. Finalizing with gathered evidence.`,
          round,
        });
        break;
      }
    }

    let completion;
    try {
      completion = await aiClient.createChatCompletion({
        messages,
        tools: isLastRound ? undefined : AGENT_TOOLS,
        temperature: 0.1,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'AI completion failed';
      onProgress?.({
        stage: 'error',
        message: `Research round error: ${msg}. Finalizing with gathered evidence.`,
        round,
      });
      break;
    }

    const toolCalls = completion.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      // Append assistant's tool call message
      messages.push({
        role: 'assistant',
        content: completion.content || '',
        tool_calls: toolCalls,
        extra_content: completion.extra_content,
      });

      // Cap tool calls per round at MAX_TOOLS_PER_ROUND (e.g. 4)
      const callsToRun = toolCalls.slice(0, MAX_TOOLS_PER_ROUND);

      for (const call of callsToRun) {
        const toolName = call.function.name;
        const callSig = `${toolName}:${call.function.arguments || ''}`;

        // Deduplicate repeated identical tool calls
        if (executedToolCalls.has(callSig)) {
          const dupRes = {
            status: 'already retrieved',
            message: 'This exact tool call was already executed previously. Use the evidence already retrieved instead of repeating the call.',
          };
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify(dupRes),
          });
          continue;
        }
        executedToolCalls.set(callSig, (executedToolCalls.get(callSig) || 0) + 1);

        let parsedArgs: Record<string, unknown> = {};

        try {
          parsedArgs = JSON.parse(call.function.arguments || '{}');
        } catch {
          const errRes = { error: 'Malformed JSON arguments. Please provide valid parameters.' };
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify(errRes),
          });
          onProgress?.({
            stage: 'error',
            message: `Malformed arguments in tool: ${toolName}`,
            toolCall: { tool: toolName, args: {} },
            resultSummary: 'Malformed arguments',
            round,
          });
          continue;
        }

        // Target document resolution
        const targetDocId = (parsedArgs.documentId as string) || documentId;

        if (toolName === 'search_document') {
          const validated = SearchDocumentSchema.safeParse(parsedArgs);
          if (!validated.success) {
            const errRes = {
              error: 'Validation failed for search_document',
              issues: validated.error.issues,
            };
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify(errRes),
            });
            continue;
          }

          const normQuery = validated.data.query.trim().toLowerCase();
          const queryCount = (queryCounts.get(normQuery) || 0) + 1;
          queryCounts.set(normQuery, queryCount);
          if (queryCount > 2) {
            const limitRes = {
              status: 'query limit reached',
              message: `The query "${validated.data.query}" has already been executed 2 times. Please formulate your final answer from the gathered evidence.`,
            };
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify(limitRes),
            });
            continue;
          }

          onProgress?.({
            stage: 'searching',
            message: `Searching for: "${validated.data.query}"...`,
            toolCall: { tool: 'search_document', args: validated.data },
            round,
          });

          const chunks = await retrieveChunksForDocument(
            targetDocId,
            validated.data.query,
            validated.data.topK
          );

          // Track examined chunks and pages
          for (const c of chunks) {
            examinedChunkIds.add(c.id);
            for (let p = c.pageStart; p <= c.pageEnd; p++) {
              examinedPagesSet.add(p);
            }
          }

          const summary = `Found ${chunks.length} passages for "${validated.data.query}"`;
          onProgress?.({
            stage: 'reading',
            message: summary,
            toolCall: { tool: 'search_document', args: validated.data },
            resultSummary: summary,
            round,
          });

          const content = JSON.stringify({
            results: chunks.map((c) => ({
              chunkId: c.id,
              documentId: targetDocId,
              section: c.sectionTitle ? `${c.sectionNumber || ''} - ${c.sectionTitle}` : undefined,
              page: c.pageStart,
              text: c.text,
            })),
          });
          totalCharsAccumulated += content.length;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content,
          });
        } else if (toolName === 'get_section') {
          const validated = GetSectionSchema.safeParse(parsedArgs);
          if (!validated.success) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify({ error: 'Validation failed for get_section' }),
            });
            continue;
          }

          onProgress?.({
            stage: 'reading',
            message: `Reading section: "${validated.data.sectionNumber}"...`,
            toolCall: { tool: 'get_section', args: validated.data },
            round,
          });

          const section = await getSectionContent(
            targetDocId,
            validated.data.sectionNumber,
            validated.data.offset,
            validated.data.limit
          );

          // Track examined chunks and pages
          if (section) {
            for (const cid of section.chunkIds) {
              examinedChunkIds.add(cid);
            }
            for (const p of section.pages) {
              examinedPagesSet.add(p);
            }
          }

          const summary = section ? `Read ${section.text.length} chars from section ${section.sectionNumber}` : 'Section not found';

          onProgress?.({
            stage: 'reading',
            message: summary,
            toolCall: { tool: 'get_section', args: validated.data },
            resultSummary: summary,
            round,
          });

          const content = JSON.stringify(section || { error: `Section ${validated.data.sectionNumber} not found.` });
          totalCharsAccumulated += content.length;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content,
          });
        } else if (toolName === 'list_clauses') {
          onProgress?.({
            stage: 'reading',
            message: 'Listing contract clauses and sections...',
            toolCall: { tool: 'list_clauses', args: {} },
            round,
          });

          const clauses = await listDocumentClauses(targetDocId);

          // Track examined clauses and pages
          for (const cl of clauses) {
            if (cl.chunkId) examinedChunkIds.add(cl.chunkId);
            examinedPagesSet.add(cl.page);
          }

          const summary = `Found ${clauses.length} indexed clauses`;

          onProgress?.({
            stage: 'reading',
            message: summary,
            toolCall: { tool: 'list_clauses', args: {} },
            resultSummary: summary,
            round,
          });

          const content = JSON.stringify({ clauses });
          totalCharsAccumulated += content.length;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content,
          });
        } else {
          // Unknown tool name: structured error with valid tools list
          const errorMsg = `Unknown tool "${toolName}". Valid tools: search_document, get_section, list_clauses.`;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({ error: errorMsg }),
          });
          onProgress?.({
            stage: 'error',
            message: errorMsg,
            toolCall: { tool: toolName, args: {} },
            resultSummary: 'Invalid tool name',
            round,
          });
        }
      }
    } else if (completion.content) {
      if (isLastRound) {
        hitCapBeforeAnswering = true;
      }
      finalResponseText = completion.content;
      if (onToken) {
        const parser = new StreamQuoteDelimiterParser(onToken);
        parser.feed(completion.content);
        const flushed = parser.flush();
        finalResponseText = `${flushed.prose}\n<<<QUOTES>>>\n${flushed.quotesJson}`;
      }
      break;
    } else {
      break;
    }
  }

  // If cap was hit or budget was exceeded, force a final answer call with tools disabled
  if (!finalResponseText) {
    hitCapBeforeAnswering = true;
    const forcedReason = hitBudgetLimit
      ? 'Context budget reached.'
      : `Research stopped at ${round} rounds.`;

    onProgress?.({
      stage: 'generating',
      message: `${forcedReason} Formulating final verified response...`,
      round,
    });

    messages.push({
      role: 'user',
      content: `${forcedReason} Please formulate your final legal answer using only the gathered evidence. Include inline citations [[1]], [[2]], followed by the delimiter "<<<QUOTES>>>" and the JSON array of candidate quotes.`,
    });

    try {
      if (onToken) {
        const parser = new StreamQuoteDelimiterParser(onToken);
        const streamGen = aiClient.streamChatCompletion({
          messages,
          temperature: 0.1,
          signal,
        });
        for await (const chunk of streamGen) {
          if (signal?.aborted) break;
          parser.feed(chunk.text);
        }
        const flushed = parser.flush();
        finalResponseText = `${flushed.prose}\n<<<QUOTES>>>\n${flushed.quotesJson}`;
      } else {
        const finalComp = await aiClient.createChatCompletion({
          messages,
          temperature: 0.1,
        });
        finalResponseText = finalComp.content || '';
      }
    } catch {
      finalResponseText =
        "I couldn't find sufficient evidence in the uploaded contract to answer this reliably.";
    }
  }

  // Parse prose and quotes from finalResponseText using machine or legacy delimiter
  let answerProse = finalResponseText;
  let quotesJson = '';

  let delimIdx = finalResponseText.indexOf(MACHINE_DELIMITER);
  let delimLen = MACHINE_DELIMITER.length;
  if (delimIdx === -1) {
    delimIdx = finalResponseText.indexOf(LEGACY_DELIMITER);
    delimLen = LEGACY_DELIMITER.length;
  }

  if (delimIdx !== -1) {
    answerProse = finalResponseText.slice(0, delimIdx).trim();
    quotesJson = finalResponseText.slice(delimIdx + delimLen).trim();
  }

  // Strip any lone "---" lines or conversational preambles
  answerProse = cleanAnswerPreambleAndSeparators(answerProse);

  let candidateCitations: Array<{ id?: number; documentId?: string; quote: string; chunkId?: string }> = [];
  if (quotesJson) {
    try {
      const match = quotesJson.match(/\[[\s\S]*\]/);
      if (match) {
        candidateCitations = JSON.parse(match[0]);
      }
    } catch {
      // Fallback regex extraction if JSON was slightly malformed
      const regexQuotes = Array.from(quotesJson.matchAll(/"quote"\s*:\s*"([^"]+)"/g));
      candidateCitations = regexQuotes.map((m, idx) => ({ id: idx + 1, quote: m[1] }));
    }
  }

  // Move "Research stopped at N rounds" to a small footer note under the answer, ONLY when cap was hit before answering
  if (hitCapBeforeAnswering && !answerProse.includes(`Research stopped at ${maxRounds} rounds`)) {
    answerProse = `${answerProse}\n\n*(Research stopped at ${maxRounds} rounds)*`;
  }

  // Verify quotes against canonical document text
  onProgress?.({
    stage: 'verifying',
    message: 'Verifying citations against canonical document text...',
    round,
  });

  let totalDocPages = options.pageCount || 1;
  let totalDocChunks = examinedChunkIds.size;
  try {
    const docMeta = await prisma.document.findUnique({
      where: { id: documentId },
      select: { pageCount: true, _count: { select: { chunks: true } } },
    });
    if (docMeta) {
      totalDocPages = Math.max(docMeta.pageCount, 1);
      totalDocChunks = docMeta._count?.chunks || examinedChunkIds.size;
    }
  } catch {
    // DB fallback
  }

  const pagesExaminedList = Array.from(examinedPagesSet).sort((a, b) => a - b);
  const pagesExamined = pagesExaminedList.length;
  const pagesTotal = totalDocPages;
  const incomplete = pagesExamined < pagesTotal;

  // Sanitize self-referential descriptions and enforce absence claim protection
  answerProse = sanitizeProcessDescriptions(answerProse);
  const enforced = enforceAbsenceCoverage(
    answerProse,
    pagesExaminedList,
    pagesExamined,
    pagesTotal
  );
  answerProse = enforced.modifiedText;

  const verifiedCitations: VerifiedCitation[] = [];

  for (let i = 0; i < candidateCitations.length; i++) {
    const candidate = candidateCitations[i];
    if (!candidate.quote) continue;

    const docToVerify = candidate.documentId || documentId;
    const vResult = await verifyQuoteForDocument(docToVerify, candidate.quote, candidate.chunkId);

    if (vResult.verified) {
      const support = checkQuoteSupport(question, answerProse, vResult.quote, enforced.isAbsence);
      verifiedCitations.push({
        id: `cit_${Date.now()}_${i}`,
        documentId: docToVerify,
        documentName,
        quote: vResult.quote,
        verified: true,
        startOffset: vResult.startOffset,
        endOffset: vResult.endOffset,
        pageStart: vResult.pageStart,
        pageEnd: vResult.pageEnd,
        occurrences: vResult.occurrences,
        supportStatus: support.supportStatus,
        supportWarning: support.warning,
      });
    } else {
      console.warn(`[Agent] Rejected unverified quote: "${candidate.quote}" (${vResult.reason})`);
    }
  }

  const dedupedCitations = deduplicateVerifiedCitations(verifiedCitations);

  onProgress?.({
    stage: 'done',
    message: `Research complete with ${dedupedCitations.length} verified citation${dedupedCitations.length === 1 ? '' : 's'}.`,
    round,
  });

  const coverage: AgentCoverageInfo = {
    chunksExamined: examinedChunkIds.size,
    chunksTotal: totalDocChunks,
    pagesExamined,
    pagesTotal,
    pagesExaminedList,
    strategy: 'agentic',
    incomplete,
  };

  return {
    answer: answerProse,
    citations: dedupedCitations,
    roundsExecuted: round,
    coverage,
  };
}
