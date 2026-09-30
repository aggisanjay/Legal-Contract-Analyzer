import { z } from 'zod';
import { aiClient, ChatMessageParam, ToolDefinition } from './client';
import { retrieveChunksForDocument, getSectionContent, listDocumentClauses } from './retriever';
import { verifyQuoteForDocument } from '../quotes/quote-verifier';
import { AGENT_RESEARCH_SYSTEM_PROMPT } from './prompts';
import { AgentProgressEvent, VerifiedCitation } from '../types';

export const SearchDocumentSchema = z.object({
  query: z.string().min(1, 'Query must not be empty'),
  topK: z.number().int().positive().optional().default(4),
});

export const GetSectionSchema = z.object({
  sectionNumber: z.string().min(1, 'Section number must not be empty'),
});

export const ListClausesSchema = z.object({});

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_document',
      description: 'Search the contract for specific clauses, terms, numbers, or topics using semantic retrieval.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query, e.g. "customer termination early" or "liability cap"',
          },
          topK: {
            type: 'integer',
            description: 'Number of chunks to return (default 4)',
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
      description: 'Retrieve the full text of a specific contract section or clause by its number.',
      parameters: {
        type: 'object',
        properties: {
          sectionNumber: {
            type: 'string',
            description: 'The section or clause number, e.g. "12", "14.2", or "5"',
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
        properties: {},
      },
    },
  },
];

export interface RunAgentOptions {
  documentId: string;
  documentName?: string;
  question: string;
  onProgress?: (event: AgentProgressEvent) => void;
  maxRounds?: number;
}

export interface AgentResult {
  answer: string;
  citations: VerifiedCitation[];
  roundsExecuted: number;
}

/**
 * Executes Part C: Agentic Document Research.
 */
export async function runAgenticDocumentResearch(
  options: RunAgentOptions
): Promise<AgentResult> {
  const { documentId, documentName = 'contract.pdf', question, onProgress } = options;
  const maxRounds = options.maxRounds || parseInt(process.env.MAX_AGENT_ROUNDS || '5', 10) || 5;

  onProgress?.({
    stage: 'searching',
    message: `Initiating agent research for: "${question.slice(0, 50)}..."`,
    round: 1,
  });

  const messages: ChatMessageParam[] = [
    {
      role: 'system',
      content: AGENT_RESEARCH_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Analyze this contract to answer the following question:\n"${question}"\n\nUse your research tools to explore the document before answering. Output your final response in valid JSON.`,
    },
  ];

  let round = 0;
  let finalJsonString: string | null = null;

  while (round < maxRounds) {
    round++;

    onProgress?.({
      stage: 'reasoning',
      message: `Agent reasoning (Round ${round} of ${maxRounds})...`,
      round,
    });

    let completion;
    try {
      completion = await aiClient.createChatCompletion({
        messages,
        tools: AGENT_TOOLS,
        temperature: 0.1,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'AI completion failed';
      onProgress?.({
        stage: 'error',
        message: `Research round error: ${msg}. Retrying...`,
        round,
      });
      break;
    }

    const toolCalls = completion.tool_calls;

    // Check if the agent wants to execute tool calls
    if (toolCalls && toolCalls.length > 0) {
      // Append assistant's tool call message
      messages.push({
        role: 'assistant',
        content: completion.content || '',
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const toolName = call.function.name;
        let parsedArgs: Record<string, unknown> = {};

        try {
          parsedArgs = JSON.parse(call.function.arguments || '{}');
        } catch {
          // Malformed JSON arguments
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({
              error: 'Malformed JSON arguments. Please provide valid JSON parameters.',
            }),
          });
          onProgress?.({
            stage: 'error',
            message: `Malformed arguments in tool call: ${toolName}. Recovering...`,
            round,
          });
          continue;
        }

        // Validate and execute tool
        if (toolName === 'search_document') {
          const validated = SearchDocumentSchema.safeParse(parsedArgs);
          if (!validated.success) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify({
                error: 'Validation failed for search_document',
                issues: validated.error.issues,
              }),
            });
            onProgress?.({
              stage: 'error',
              message: `Invalid search arguments: ${validated.error.issues[0]?.message}`,
              round,
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
            documentId,
            validated.data.query,
            validated.data.topK
          );

          onProgress?.({
            stage: 'reading',
            message: `Found ${chunks.length} relevant passages for "${validated.data.query}".`,
            round,
          });

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({
              results: chunks.map((c) => ({
                chunkId: c.id,
                section: c.sectionTitle ? `${c.sectionNumber || ''} - ${c.sectionTitle}` : undefined,
                page: c.pageStart,
                text: c.text,
              })),
            }),
          });
        } else if (toolName === 'get_section') {
          const validated = GetSectionSchema.safeParse(parsedArgs);
          if (!validated.success) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify({
                error: 'Validation failed for get_section',
                issues: validated.error.issues,
              }),
            });
            onProgress?.({
              stage: 'error',
              message: `Invalid section arguments: ${validated.error.issues[0]?.message}`,
              round,
            });
            continue;
          }

          onProgress?.({
            stage: 'reading',
            message: `Reading Section ${validated.data.sectionNumber}...`,
            toolCall: { tool: 'get_section', args: validated.data },
            round,
          });

          const sec = await getSectionContent(documentId, validated.data.sectionNumber);

          if (!sec) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify({
                error: `Section "${validated.data.sectionNumber}" not found in contract index.`,
              }),
            });
            onProgress?.({
              stage: 'reading',
              message: `Section ${validated.data.sectionNumber} not found. Continuing search...`,
              round,
            });
          } else {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify({
                sectionNumber: sec.sectionNumber,
                pageStart: sec.pageStart,
                pageEnd: sec.pageEnd,
                text: sec.text,
              }),
            });
            onProgress?.({
              stage: 'reading',
              message: `Retrieved Section ${sec.sectionNumber} (Pages ${sec.pageStart}-${sec.pageEnd}).`,
              round,
            });
          }
        } else if (toolName === 'list_clauses') {
          const validated = ListClausesSchema.safeParse(parsedArgs);
          if (!validated.success) {
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: toolName,
              content: JSON.stringify({ error: 'Validation failed' }),
            });
            continue;
          }

          onProgress?.({
            stage: 'searching',
            message: 'Listing all indexed contract clauses...',
            toolCall: { tool: 'list_clauses', args: {} },
            round,
          });

          const clauses = await listDocumentClauses(documentId);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({ clauses }),
          });

          onProgress?.({
            stage: 'reading',
            message: `Indexed ${clauses.length} contract clauses.`,
            round,
          });
        } else {
          // Unknown tool call: structured recovery
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify({
              error: `Unknown tool "${toolName}". Available tools are search_document, get_section, and list_clauses.`,
            }),
          });
          onProgress?.({
            stage: 'error',
            message: `The requested research operation "${toolName}" was invalid. Retrying with available tools.`,
            round,
          });
        }
      }
    } else if (completion.content) {
      // The agent provided a final textual response
      finalJsonString = completion.content;
      break;
    } else {
      break;
    }
  }

  // If no final JSON was formulated, ask the model to synthesize from gathered evidence
  if (!finalJsonString) {
    onProgress?.({
      stage: 'generating',
      message: 'Synthesizing evidence and finalizing answer...',
      round,
    });

    messages.push({
      role: 'user',
      content:
        'Please formulate your final answer based on the retrieved evidence. Output JSON with "answer" and "citations".',
    });

    try {
      const finalComp = await aiClient.createChatCompletion({
        messages,
        temperature: 0.1,
        responseFormatJson: true,
      });
      finalJsonString = finalComp.content || '';
    } catch {
      finalJsonString = JSON.stringify({
        answer: "I couldn't find sufficient evidence in the uploaded contract to answer this reliably.",
        citations: [],
      });
    }
  }

  // Parse structured answer
  let parsedAnswer = "I couldn't find sufficient evidence in the uploaded contract to answer this reliably.";
  let candidateCitations: Array<{ quote: string; chunkId?: string }> = [];

  try {
    const jsonMatch = finalJsonString?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.answer) parsedAnswer = parsed.answer;
      if (Array.isArray(parsed.citations)) candidateCitations = parsed.citations;
    } else {
      parsedAnswer = finalJsonString || parsedAnswer;
    }
  } catch {
    parsedAnswer = finalJsonString || parsedAnswer;
  }

  // Step: Backend Quote Verification
  onProgress?.({
    stage: 'verifying',
    message: 'Verifying citations against canonical document text...',
    round,
  });

  const verifiedCitations: VerifiedCitation[] = [];

  for (let i = 0; i < candidateCitations.length; i++) {
    const candidate = candidateCitations[i];
    if (!candidate.quote) continue;

    const vResult = await verifyQuoteForDocument(
      documentId,
      candidate.quote,
      candidate.chunkId
    );

    if (vResult.verified) {
      verifiedCitations.push({
        id: `cit_${Date.now()}_${i}`,
        documentId,
        documentName,
        quote: vResult.quote,
        verified: true,
        startOffset: vResult.startOffset,
        endOffset: vResult.endOffset,
        pageStart: vResult.pageStart,
        pageEnd: vResult.pageEnd,
      });
    } else {
      // Per Section 21: Unsupported or hallucinated quotes must NEVER be shown as verified!
      console.warn(`Quote verification rejected unverified quote: "${candidate.quote}"`);
    }
  }

  onProgress?.({
    stage: 'done',
    message: `Answer ready with ${verifiedCitations.length} verified citation${verifiedCitations.length === 1 ? '' : 's'}.`,
    round,
  });

  return {
    answer: parsedAnswer,
    citations: verifiedCitations,
    roundsExecuted: round,
  };
}
