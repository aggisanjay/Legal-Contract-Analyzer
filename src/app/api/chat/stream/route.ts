import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { aiClient, AIUnavailableError } from '@/lib/ai/client';
import { retrieveChunksForDocument } from '@/lib/ai/retriever';
import {
  isExhaustiveQuestion,
  isComparativeQuestion,
  executeTargetedRetrieval,
  executeMapReduceRetrieval,
  enforceAbsenceCoverage,
  isAbsenceClaim,
  parseQuotesPayload,
  resolveDocumentFromAlias,
} from '@/lib/ai/coverage';
import { CONTRACT_QA_SYSTEM_PROMPT, MULTI_DOC_QA_SYSTEM_PROMPT } from '@/lib/ai/prompts';
import { runAgenticDocumentResearch } from '@/lib/ai/agent';
import { verifyQuoteForDocument } from '@/lib/quotes/quote-verifier';
import { VerifiedCitation } from '@/lib/types';
import { deduplicateVerifiedCitations, normalizeQuoteForDedup } from '@/lib/utils/format';
import { checkQuoteSupport, sanitizeProcessDescriptions } from '@/lib/quotes/quote-support';
import {
  StreamQuoteDelimiterParser,
  cleanAnswerPreambleAndSeparators,
  MACHINE_DELIMITER,
  LEGACY_DELIMITER,
} from '@/lib/ai/stream-cleaner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const body = await req.json();
    const {
      documentId,
      documentIds,
      question,
      useAgent = false,
      forceMapReduce = false,
      conversationId: existingConvId,
    } = body;

    if (!question || typeof question !== 'string') {
      return new Response('Question is required', { status: 400 });
    }

    const docIds: string[] =
      documentIds && Array.isArray(documentIds) && documentIds.length > 0
        ? documentIds
        : documentId
        ? [documentId]
        : [];

    if (docIds.length === 0) {
      return new Response('At least one document ID is required', { status: 400 });
    }

    console.log(`[Chat Stream API] Received ${docIds.length} document ID(s):`, docIds);

    // Find or create conversation
    let convId = existingConvId;
    if (!convId) {
      const conv = await prisma.conversation.create({
        data: {
          documentId: docIds.length === 1 ? docIds[0] : null,
          documentIds: docIds.length > 1 ? docIds : undefined,
          title: question.slice(0, 80),
        },
      });
      convId = conv.id;
    }

    // Save user message
    await prisma.message.create({
      data: {
        conversationId: convId,
        role: 'user',
        content: question,
      },
    });

    const isMultiDoc = docIds.length > 1;

    // ReadableStream for Server-Sent Events
    const stream = new ReadableStream({
      async start(controller) {
        let fullGeneratedText = '';
        const collectedCitations: VerifiedCitation[] = [];
        const collectedUnverified: Array<{
          id: string;
          documentId: string;
          documentName: string;
          quote: string;
          verified: false;
          reason?: string;
          citationNumber?: number;
        }> = [];

        function sendEvent(event: string, data: unknown) {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          } catch {
            // Client closed stream connection
          }
        }

        // Emit meta event first containing conversationId (assignment requirement)
        sendEvent('meta', { conversationId: convId });

        // Guard: If question asks to compare / mentions two documents but only 1 is selected, refuse to answer
        if (docIds.length === 1 && isComparativeQuestion(question)) {
          const refusal = 'Only 1 document is selected. Select the other version in the library to compare.';
          sendEvent('token', { text: refusal });
          await prisma.message.create({
            data: {
              conversationId: convId,
              role: 'assistant',
              content: refusal,
              verifiedCount: 0,
              unverifiedCount: 0,
            },
          });
          sendEvent('done', {});
          controller.close();
          return;
        }

        // Server-side stop handler: listen to abort signal and persist partial message
        let persistedOnAbort = false;
        const persistPartialMessage = async () => {
          if (persistedOnAbort) return;
          persistedOnAbort = true;
          if (fullGeneratedText.trim().length > 0) {
            await prisma.message
              .create({
                data: {
                  conversationId: convId,
                  role: 'assistant',
                  content: fullGeneratedText.trim(),
                  citations: JSON.parse(JSON.stringify(collectedCitations)),
                  interrupted: true,
                  verifiedCount: collectedCitations.length,
                  unverifiedCount: collectedUnverified.length,
                },
              })
              .catch(() => {});
          }
        };

        req.signal.addEventListener('abort', persistPartialMessage);

        try {
          let retrievalResult: any = null;
          const isExhaustive = isExhaustiveQuestion(question) || Boolean(forceMapReduce);

          if (useAgent && !isMultiDoc && !isExhaustive) {
            // --- Part C: Agentic Document Research for targeted questions ---
            const doc = await prisma.document.findUnique({
              where: { id: docIds[0] },
              select: { originalFilename: true, pageCount: true },
            });

            const streamStart = Date.now();
            let firstTokenTime: number | null = null;

            const agentRes = await runAgenticDocumentResearch({
              documentId: docIds[0],
              documentName: doc?.originalFilename || 'contract.pdf',
              pageCount: doc?.pageCount,
              question,
              signal: req.signal,
              onProgress: (progress) => {
                sendEvent('status', {
                  message: progress.message,
                  stage: progress.stage,
                  round: progress.round,
                  toolCall: progress.toolCall,
                });
              },
              onToken: (token) => {
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                  console.log(`[Agent Stream] First token arrived after ${firstTokenTime - streamStart}ms`);
                }
                fullGeneratedText += token;
                sendEvent('token', { text: token });
              },
            });

            const completionTime = Date.now();
            console.log(
              `[Agent Stream] Completed in ${completionTime - streamStart}ms (first token arrived at ${
                firstTokenTime ? firstTokenTime - streamStart : 0
              }ms)`
            );

            // Emit REAL coverage from the agent (deleted hardcoded coverage object)
            sendEvent('coverage', agentRes.coverage);

            // Ensure fullGeneratedText matches final sanitized answer
            fullGeneratedText = agentRes.answer;

            for (const cit of agentRes.citations) {
              if (cit.verified) {
                collectedCitations.push(cit);
                sendEvent('citation', cit);
              } else {
                collectedUnverified.push(cit as any);
                sendEvent('unverified', cit);
              }
            }
          } else if (isMultiDoc) {
            // --- Multi-Document Analysis ---
            sendEvent('status', { message: `Retrieving evidence across ${docIds.length} contracts...` });

            const docEvidenceList: Array<{
              id: string;
              name: string;
              alias: string;
              index: number;
              evidence: string;
              pageCount: number;
            }> = [];

            for (let i = 0; i < docIds.length; i++) {
              const dId = docIds[i];
              const doc = await prisma.document.findUnique({
                where: { id: dId },
                select: { id: true, originalFilename: true, pageCount: true },
              });
              if (!doc) continue;

              sendEvent('status', { message: `Searching "${doc.originalFilename}"...` });
              const chunks = await retrieveChunksForDocument(dId, question, 6);
              const text = chunks.length > 0
                ? chunks.map((c) => `[Page ${c.pageStart}]\n${c.text}`).join('\n---\n')
                : `Not found in ${doc.originalFilename}`;

              docEvidenceList.push({
                id: doc.id,
                name: doc.originalFilename,
                alias: `DOC_${i + 1}`,
                index: i + 1,
                evidence: text,
                pageCount: doc.pageCount,
              });
            }

            const promptMessages = [
              {
                role: 'system' as const,
                content: MULTI_DOC_QA_SYSTEM_PROMPT,
              },
              {
                role: 'user' as const,
                content:
                  `QUESTION:\n${question}\n\nCONTRACTS EVIDENCE:\n` +
                  docEvidenceList
                    .map(
                      (d) =>
                        `=== DOCUMENT ${d.index} (alias: ${d.alias}, file: ${d.name}) ===\n${d.evidence}`
                    )
                    .join('\n\n'),
              },
            ];

            sendEvent('status', { message: 'Analyzing substantive differences across contracts...' });

            const streamStart = Date.now();
            let firstTokenTime: number | null = null;
            let quotesJsonBuffer = '';

            const parser = new StreamQuoteDelimiterParser((token) => {
              if (!firstTokenTime) {
                firstTokenTime = Date.now();
                console.log(`[MultiDoc Stream] First token arrived after ${firstTokenTime - streamStart}ms`);
              }
              fullGeneratedText += token;
              sendEvent('token', { text: token });
            });

            const streamGen = aiClient.streamChatCompletion({
              messages: promptMessages,
              temperature: 0.1,
              signal: req.signal,
              onProviderChange: (provider) => {
                sendEvent('status', { message: `Generating comparative analysis via ${provider}...` });
              },
            });

            for await (const chunk of streamGen) {
              if (req.signal.aborted) break;
              parser.feed(chunk.text);
            }

            const flushed = parser.flush();
            fullGeneratedText = flushed.prose;
            quotesJsonBuffer = flushed.quotesJson;

            const completionTime = Date.now();
            console.log(
              `[MultiDoc Stream] Completed in ${completionTime - streamStart}ms (first token arrived at ${
                firstTokenTime ? firstTokenTime - streamStart : 0
              }ms)`
            );

            // Verify candidate quotes for multi-document mode
            sendEvent('status', { message: 'Verifying quotations against each contract...' });

            let parsedPayload = parseQuotesPayload(quotesJsonBuffer, 'comparison');
            let candidateCitations = parsedPayload.citations;

            // If no citations parsed, attempt quick fallback repair
            if (candidateCitations.length === 0 && quotesJsonBuffer.trim().length > 0) {
              try {
                const repair = await aiClient.createChatCompletion({
                  messages: [
                    {
                      role: 'system',
                      content:
                        'Extract candidate quotes as a valid JSON object: {"answerType": "comparison", "citations": [{"id": 1, "doc": "DOC_1", "quote": "verbatim text"}]}. Return ONLY valid JSON.',
                    },
                    { role: 'user', content: quotesJsonBuffer },
                  ],
                  temperature: 0,
                });
                parsedPayload = parseQuotesPayload(repair.content || '', 'comparison');
                candidateCitations = parsedPayload.citations;
              } catch {
                sendEvent('notice', { message: 'No verifiable quotes could be produced.' });
              }
            }

            const seenQuoteKeys = new Set<string>();
            for (let i = 0; i < candidateCitations.length; i++) {
              const cand = candidateCitations[i];
              if (!cand.quote) continue;

              const targetDocInfo = resolveDocumentFromAlias(cand.doc || cand.documentId, docEvidenceList);
              if (!targetDocInfo) {
                console.warn(
                  `[quote-verify] Multi-doc quote rejected: unknown document (alias provided: "${cand.doc || cand.documentId}")`
                );
                const unv = {
                  id: `unv_${Date.now()}_${i}`,
                  documentId: cand.doc || cand.documentId || 'unknown',
                  documentName: 'Unknown Document',
                  quote: cand.quote,
                  verified: false as const,
                  reason: 'unknown document',
                  citationNumber: cand.id || i + 1,
                };
                collectedUnverified.push(unv);
                sendEvent('unverified', unv);
                continue;
              }

              const quoteKey = `${targetDocInfo.id}::${normalizeQuoteForDedup(cand.quote)}`;
              if (seenQuoteKeys.has(quoteKey)) continue;
              seenQuoteKeys.add(quoteKey);

              const vResult = await verifyQuoteForDocument(targetDocInfo.id, cand.quote);
              if (vResult.verified) {
                // In comparison mode, quotes are never marked absent
                const support = checkQuoteSupport(question, fullGeneratedText, vResult.quote, false);
                const cit: VerifiedCitation = {
                  id: `cit_${Date.now()}_${i}`,
                  documentId: targetDocInfo.id,
                  documentName: targetDocInfo.name,
                  quote: vResult.quote,
                  verified: true,
                  startOffset: vResult.startOffset,
                  endOffset: vResult.endOffset,
                  pageStart: vResult.pageStart,
                  pageEnd: vResult.pageEnd,
                  occurrences: vResult.occurrences,
                  supportStatus: support.supportStatus,
                  supportWarning: support.warning,
                };
                collectedCitations.push(cit);
                sendEvent('citation', cit);
              } else {
                console.log(
                  `[quote-verify] Doc ${cand.doc || targetDocInfo.name} quote rejected: ${vResult.reason} in ${targetDocInfo.name} (normalized quote length: ${cand.quote.trim().length})`
                );
                const unv = {
                  id: `unv_${Date.now()}_${i}`,
                  documentId: targetDocInfo.id,
                  documentName: targetDocInfo.name,
                  quote: cand.quote,
                  verified: false as const,
                  reason: vResult.reason,
                  citationNumber: cand.id || i + 1,
                };
                collectedUnverified.push(unv);
                sendEvent('unverified', unv);
              }
            }

            // Multi-doc quote repair pass:
            // When candidate quotes were emitted but ALL of them failed verification,
            // make a single quick repair call to re-quote verbatim from the evidence passages.
            if (collectedCitations.length === 0 && candidateCitations.length > 0) {
              try {
                sendEvent('status', { message: 'Re-quoting verbatim from contracts evidence...' });
                const combinedEvidence = docEvidenceList
                  .map(
                    (d) =>
                      `=== DOCUMENT ${d.index} (alias: ${d.alias}, file: ${d.name}) ===\n${d.evidence}`
                  )
                  .join('\n\n');

                const repairRes = await aiClient.createChatCompletion({
                  messages: [
                    {
                      role: 'system',
                      content:
                        'Extract 1 to 4 EXACT, VERBATIM quotes from the contracts evidence that directly support the answer. For each quote, specify which document it came from using its alias (e.g. "DOC_1", "DOC_2"). Return ONLY a valid JSON object:\n{"citations": [{"id": 1, "doc": "DOC_1", "quote": "exact verbatim text"}]}',
                    },
                    {
                      role: 'user',
                      content: `ANSWER:\n${fullGeneratedText}\n\nCONTRACTS EVIDENCE:\n${combinedEvidence}`,
                    },
                  ],
                  temperature: 0,
                });

                const repairedPayload = parseQuotesPayload(repairRes.content || '', 'comparison');
                for (let rIdx = 0; rIdx < repairedPayload.citations.length; rIdx++) {
                  const rq = repairedPayload.citations[rIdx];
                  if (!rq.quote) continue;

                  const targetDoc = resolveDocumentFromAlias(rq.doc || rq.documentId, docEvidenceList);
                  if (!targetDoc) continue;

                  const rv = await verifyQuoteForDocument(targetDoc.id, rq.quote);
                  if (rv.verified) {
                    const support = checkQuoteSupport(question, fullGeneratedText, rv.quote, false);
                    const repCit: VerifiedCitation = {
                      id: `cit_${Date.now()}_rep_${rIdx}`,
                      documentId: targetDoc.id,
                      documentName: targetDoc.name,
                      quote: rv.quote,
                      verified: true,
                      startOffset: rv.startOffset,
                      endOffset: rv.endOffset,
                      pageStart: rv.pageStart,
                      pageEnd: rv.pageEnd,
                      occurrences: rv.occurrences,
                      supportStatus: support.supportStatus,
                      supportWarning: support.warning,
                    };
                    collectedCitations.push(repCit);
                    sendEvent('citation', repCit);
                  }
                }
              } catch (repairErr) {
                console.warn('[MultiDoc Repair] Repair pass failed:', repairErr);
              }
            }
          } else {
            // --- Single Document QA with Coverage Honesty & Delimiter Streaming ---
            const doc = await prisma.document.findUnique({
              where: { id: docIds[0] },
              select: { id: true, originalFilename: true, pageCount: true },
            });

            if (!doc) {
              throw new Error('Document not found');
            }

            if (isExhaustive) {
              sendEvent('status', { message: 'Initiating full-document map-reduce review...' });
              retrievalResult = await executeMapReduceRetrieval(
                docIds[0],
                question,
                doc.pageCount,
                {
                  onProgress: (msg) => {
                    sendEvent('status', { message: msg });
                  },
                }
              );
            } else {
              sendEvent('status', { message: 'Retrieving targeted contract clauses...' });
              retrievalResult = await executeTargetedRetrieval(
                docIds[0],
                question,
                doc.pageCount
              );
            }

            // Emit coverage event immediately
            sendEvent('coverage', retrievalResult.coverage);

            // Coverage honesty check: if empty and incomplete coverage, enforce refusal to claim absence
            if (retrievalResult.emptyAndIncomplete) {
              const msg =
                retrievalResult.incompleteMessage ||
                `I searched pages ${retrievalResult.coverage.searchedPagesDesc || '1–50'} and found nothing, but pages ${
                  retrievalResult.coverage.unreadPagesDesc || '51–150'
                } were not read, so I cannot confirm the clause is absent.`;
              fullGeneratedText = msg;
              sendEvent('token', { text: msg });
            } else if (retrievalResult.isExhaustiveAbsent) {
              const absentMsg = `The requested clause or term is not present in the document (searched all ${doc.pageCount} pages).`;
              fullGeneratedText = absentMsg;
              sendEvent('token', { text: absentMsg });
            } else if (!retrievalResult.evidenceText || retrievalResult.evidenceText.trim().length === 0) {
              const noEvidence =
                "I couldn't find sufficient evidence in the uploaded contract to answer this reliably.";
              fullGeneratedText = noEvidence;
              sendEvent('token', { text: noEvidence });
            } else {
              sendEvent('status', { message: 'Synthesizing verified legal answer...' });

              const promptMessages = [
                {
                  role: 'system' as const,
                  content: CONTRACT_QA_SYSTEM_PROMPT,
                },
                {
                  role: 'user' as const,
                  content: `QUESTION:\n${question}\n\nEVIDENCE:\n${retrievalResult.evidenceText}`,
                },
              ];

              const streamStart = Date.now();
              let firstTokenTime: number | null = null;
              let quotesJsonBuffer = '';

              const parser = new StreamQuoteDelimiterParser((token) => {
                if (!firstTokenTime) {
                  firstTokenTime = Date.now();
                  console.log(`[SingleDoc Stream] First token arrived after ${firstTokenTime - streamStart}ms`);
                }
                fullGeneratedText += token;
                sendEvent('token', { text: token });
              });

              const streamGen = aiClient.streamChatCompletion({
                messages: promptMessages,
                temperature: 0.1,
                signal: req.signal,
                onProviderChange: (provider) => {
                  sendEvent('status', { message: `Streaming response via ${provider}...` });
                },
              });

              for await (const chunk of streamGen) {
                if (req.signal.aborted) break;
                parser.feed(chunk.text);
              }

              const flushed = parser.flush();
              fullGeneratedText = flushed.prose;
              quotesJsonBuffer = flushed.quotesJson;

              const completionTime = Date.now();
              console.log(
                `[SingleDoc Stream] Completed in ${completionTime - streamStart}ms (first token arrived at ${
                  firstTokenTime ? firstTokenTime - streamStart : 0
                }ms)`
              );

              // Verify quotations
              sendEvent('status', { message: 'Verifying quotations...' });

              let candidateCitations: Array<{ id?: number; quote: string; chunkId?: string }> = [];
              if (quotesJsonBuffer.trim().length > 0) {
                try {
                  const jsonMatch = quotesJsonBuffer.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    candidateCitations = JSON.parse(jsonMatch[0]);
                  }
                } catch {
                  // Retry repair once
                  try {
                    const repair = await aiClient.createChatCompletion({
                      messages: [
                        {
                          role: 'system',
                          content:
                            'Convert the candidate quotes into a valid JSON array: [{"id": 1, "quote": "verbatim text"}]. Return ONLY the valid JSON array.',
                        },
                        { role: 'user', content: quotesJsonBuffer },
                      ],
                      temperature: 0,
                    });
                    const repMatch = repair.content?.match(/\[[\s\S]*\]/);
                    if (repMatch) {
                      candidateCitations = JSON.parse(repMatch[0]);
                    }
                  } catch {
                    sendEvent('notice', { message: 'No verifiable quotes could be produced.' });
                  }
                }
              }

              const seenSingleQuoteKeys = new Set<string>();
              for (let i = 0; i < candidateCitations.length; i++) {
                const cand = candidateCitations[i];
                if (!cand.quote) continue;

                const quoteKey = `${docIds[0]}::${normalizeQuoteForDedup(cand.quote)}`;
                if (seenSingleQuoteKeys.has(quoteKey)) continue;
                seenSingleQuoteKeys.add(quoteKey);

                const vResult = await verifyQuoteForDocument(
                  docIds[0],
                  cand.quote,
                  cand.chunkId
                );

                if (vResult.verified) {
                  const isAbsence = isAbsenceClaim(fullGeneratedText);
                  const support = checkQuoteSupport(question, fullGeneratedText, vResult.quote, isAbsence);
                  const cit: VerifiedCitation = {
                    id: `cit_${Date.now()}_${i}`,
                    documentId: docIds[0],
                    documentName: doc.originalFilename,
                    quote: vResult.quote,
                    verified: true,
                    startOffset: vResult.startOffset,
                    endOffset: vResult.endOffset,
                    pageStart: vResult.pageStart,
                    pageEnd: vResult.pageEnd,
                    occurrences: vResult.occurrences,
                    supportStatus: support.supportStatus,
                    supportWarning: support.warning,
                  };
                  collectedCitations.push(cit);
                  sendEvent('citation', cit);
                } else {
                  const unv = {
                    id: `unv_${Date.now()}_${i}`,
                    documentId: docIds[0],
                    documentName: doc.originalFilename,
                    quote: cand.quote,
                    verified: false as const,
                    reason: vResult.reason,
                    citationNumber: cand.id || i + 1,
                  };
                  collectedUnverified.push(unv);
                  sendEvent('unverified', unv);
                }
              }
            }
          }

          // Sanitize any self-referential process descriptions from the generated answer
          fullGeneratedText = sanitizeProcessDescriptions(fullGeneratedText);

          // If answer has zero verified citations and is not a "not found" answer, attempt ONE quote repair retry
          const textLower = fullGeneratedText.toLowerCase();
          const isNotFoundAnswer =
            textLower.includes('not found') ||
            textLower.includes('not present') ||
            textLower.includes("couldn't find") ||
            textLower.includes('cannot confirm the clause is absent') ||
            textLower.includes("can't confirm this clause is absent") ||
            isAbsenceClaim(fullGeneratedText);

          // Quote repair step:
          // If ALL quotes fail verification for an answer that is not a "not found" answer,
          // run ONE retry that asks the model to re-quote verbatim from the evidence text supplied, then re-verify.
          if (
            !isMultiDoc &&
            collectedCitations.length === 0 &&
            !isNotFoundAnswer &&
            fullGeneratedText.trim().length > 0 &&
            docIds[0]
          ) {
            try {
              let evidenceForRepair = '';
              if (typeof retrievalResult !== 'undefined' && retrievalResult?.evidenceText) {
                evidenceForRepair = retrievalResult.evidenceText;
              } else {
                const chunks = await retrieveChunksForDocument(docIds[0], question, 4);
                evidenceForRepair = chunks.map((c) => `[Page ${c.pageStart}]\n${c.text}`).join('\n\n');
              }

              if (evidenceForRepair.trim().length > 0) {
                sendEvent('status', { message: 'Re-quoting verbatim from evidence to verify...' });
                const repairRes = await aiClient.createChatCompletion({
                  messages: [
                    {
                      role: 'system',
                      content:
                        'Extract 1 to 3 EXACT, VERBATIM quotes from the following contract evidence text that directly support the given answer. Return ONLY a valid JSON array of objects: [{"quote": "exact verbatim text"}]. Do not paraphrase.',
                    },
                    {
                      role: 'user',
                      content: `ANSWER:\n${fullGeneratedText}\n\nEVIDENCE:\n${evidenceForRepair}`,
                    },
                  ],
                  temperature: 0,
                });

                const repairMatch = repairRes.content?.match(/\[[\s\S]*\]/);
                if (repairMatch) {
                  const repairedQuotes: Array<{ quote: string }> = JSON.parse(repairMatch[0]);
                  for (let rIdx = 0; rIdx < repairedQuotes.length; rIdx++) {
                    const rq = repairedQuotes[rIdx];
                    if (!rq.quote) continue;
                    const rv = await verifyQuoteForDocument(docIds[0], rq.quote);
                    if (rv.verified) {
                      const isAbsence = isAbsenceClaim(fullGeneratedText);
                      const support = checkQuoteSupport(question, fullGeneratedText, rv.quote, isAbsence);
                      const repCit: VerifiedCitation = {
                        id: `cit_${Date.now()}_rep_${rIdx}`,
                        documentId: docIds[0],
                        documentName: 'Contract',
                        quote: rv.quote,
                        verified: true,
                        startOffset: rv.startOffset,
                        endOffset: rv.endOffset,
                        pageStart: rv.pageStart,
                        pageEnd: rv.pageEnd,
                        occurrences: rv.occurrences,
                        supportStatus: support.supportStatus,
                        supportWarning: support.warning,
                      };
                      collectedCitations.push(repCit);
                      sendEvent('citation', repCit);
                    }
                  }
                }
              }
            } catch (repairErr) {
              console.warn('[Quote Repair] Retry error:', repairErr);
            }
          }

          // Only if repair fails, show the warning
          if (collectedCitations.length === 0 && !isNotFoundAnswer && fullGeneratedText.trim().length > 0) {
            sendEvent('notice', {
              message: 'This answer has no verified quotes. Treat it as unsupported.',
            });
          }

          // Persist completed message in database if not aborted
          if (!req.signal.aborted) {
            const finalCitations = deduplicateVerifiedCitations(collectedCitations);
            await prisma.message.create({
              data: {
                conversationId: convId,
                role: 'assistant',
                content: fullGeneratedText.trim(),
                citations: JSON.parse(JSON.stringify(finalCitations)),
                interrupted: false,
                verifiedCount: collectedCitations.length,
                unverifiedCount: collectedUnverified.length,
              },
            });

            sendEvent('done', { conversationId: convId });
          }
        } catch (err: unknown) {
          const isAIUnavailable = err instanceof AIUnavailableError;
          const errMessage = isAIUnavailable
            ? 'AI provider unavailable or rate-limited. Try again shortly.'
            : err instanceof Error
            ? err.message
            : 'An error occurred during chat generation.';

          sendEvent('error', { message: errMessage });

          // Preserve partial assistant message if anything was generated before error
          if (fullGeneratedText.trim()) {
            await prisma.message
              .create({
                data: {
                  conversationId: convId,
                  role: 'assistant',
                  content: fullGeneratedText.trim(),
                  citations: JSON.parse(JSON.stringify(collectedCitations)),
                  interrupted: true,
                  verifiedCount: collectedCitations.length,
                  unverifiedCount: collectedUnverified.length,
                },
              })
              .catch(() => {});
          }
        } finally {
          req.signal.removeEventListener('abort', persistPartialMessage);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err: unknown) {
    console.error('Chat stream initialization error:', err);
    return new Response('Internal server error', { status: 500 });
  }
}
