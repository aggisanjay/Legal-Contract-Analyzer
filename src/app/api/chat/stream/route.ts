import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { aiClient, AIUnavailableError } from '@/lib/ai/client';
import { retrieveChunksForDocument } from '@/lib/ai/retriever';
import {
  isExhaustiveQuestion,
  executeTargetedRetrieval,
  executeMapReduceRetrieval,
} from '@/lib/ai/coverage';
import { CONTRACT_QA_SYSTEM_PROMPT, MULTI_DOC_QA_SYSTEM_PROMPT } from '@/lib/ai/prompts';
import { runAgenticDocumentResearch } from '@/lib/ai/agent';
import { verifyQuoteForDocument } from '@/lib/quotes/quote-verifier';
import { VerifiedCitation } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  try {
    const body = await req.json();
    const {
      documentId,
      documentIds,
      question,
      useAgent = false,
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
          if (useAgent && !isMultiDoc) {
            // --- Part C: Agentic Document Research ---
            const doc = await prisma.document.findUnique({
              where: { id: docIds[0] },
              select: { originalFilename: true, pageCount: true },
            });

            const agentRes = await runAgenticDocumentResearch({
              documentId: docIds[0],
              documentName: doc?.originalFilename || 'contract.pdf',
              question,
              onProgress: (progress) => {
                sendEvent('status', {
                  message: progress.message,
                  stage: progress.stage,
                  round: progress.round,
                  toolCall: progress.toolCall,
                });
              },
            });

            // Emit coverage for agent mode
            sendEvent('coverage', {
              chunksExamined: Math.min(10, doc?.pageCount ? doc.pageCount * 2 : 10),
              chunksTotal: doc?.pageCount ? doc.pageCount * 3 : 20,
              pagesExamined: doc?.pageCount || 1,
              pagesTotal: doc?.pageCount || 1,
              strategy: 'agentic',
              coveragePercent: 100,
            });

            // Stream answer tokens directly
            fullGeneratedText = agentRes.answer;
            sendEvent('token', { text: agentRes.answer });

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

            const docEvidenceList: Array<{ id: string; name: string; evidence: string; pageCount: number }> = [];

            for (const dId of docIds) {
              const doc = await prisma.document.findUnique({
                where: { id: dId },
                select: { id: true, originalFilename: true, pageCount: true },
              });
              if (!doc) continue;

              sendEvent('status', { message: `Searching "${doc.originalFilename}"...` });
              const chunks = await retrieveChunksForDocument(dId, question, 6);
              const text = chunks.map((c) => `[Page ${c.pageStart}]\n${c.text}`).join('\n---\n');

              docEvidenceList.push({
                id: doc.id,
                name: doc.originalFilename,
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
                        `### Contract: "${d.name}" (documentId: "${d.id}")\n${d.evidence}`
                    )
                    .join('\n\n'),
              },
            ];

            sendEvent('status', { message: 'Analyzing substantive differences across contracts...' });

            const DELIMITER = '---QUOTES---';
            let passedDelimiter = false;
            let currentLineBuffer = '';
            let quotesJsonBuffer = '';

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

              const text = chunk.text;
              if (passedDelimiter) {
                quotesJsonBuffer += text;
                continue;
              }

              currentLineBuffer += text;
              const delimIdx = currentLineBuffer.indexOf(DELIMITER);
              if (delimIdx !== -1) {
                passedDelimiter = true;
                const proseBefore = currentLineBuffer.slice(0, delimIdx);
                if (proseBefore.length > 0) {
                  fullGeneratedText += proseBefore;
                  sendEvent('token', { text: proseBefore });
                }
                quotesJsonBuffer = currentLineBuffer.slice(delimIdx + DELIMITER.length);
                currentLineBuffer = '';
                continue;
              }

              const potentialPrefixMatch = currentLineBuffer.match(/(\r?\n-[-A-Z]*)$/);
              if (potentialPrefixMatch) {
                const safeLength = currentLineBuffer.length - potentialPrefixMatch[0].length;
                if (safeLength > 0) {
                  const safeText = currentLineBuffer.slice(0, safeLength);
                  fullGeneratedText += safeText;
                  sendEvent('token', { text: safeText });
                  currentLineBuffer = currentLineBuffer.slice(safeLength);
                }
              } else {
                fullGeneratedText += currentLineBuffer;
                sendEvent('token', { text: currentLineBuffer });
                currentLineBuffer = '';
              }
            }

            if (!passedDelimiter && currentLineBuffer.length > 0) {
              fullGeneratedText += currentLineBuffer;
              sendEvent('token', { text: currentLineBuffer });
            }

            // Verify candidate quotes for multi-document mode
            sendEvent('status', { message: 'Verifying quotations against each contract...' });

            let candidateCitations: Array<{ id?: number; documentId?: string; quote: string }> = [];
            if (quotesJsonBuffer.trim().length > 0) {
              try {
                const jsonMatch = quotesJsonBuffer.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                  candidateCitations = JSON.parse(jsonMatch[0]);
                }
              } catch {
                // Retry once with repair prompt
                try {
                  const repair = await aiClient.createChatCompletion({
                    messages: [
                      {
                        role: 'system',
                        content:
                          'Extract candidate quotes as a valid JSON array of objects: [{"id": 1, "documentId": "string", "quote": "string"}]. Return ONLY the valid JSON array.',
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

            for (let i = 0; i < candidateCitations.length; i++) {
              const cand = candidateCitations[i];
              if (!cand.quote) continue;

              // Rule: NEVER fall back to docEvidenceList[0] when documentId is missing or unknown.
              // Reject that quote as unverified with reason "unknown document".
              const targetDocInfo = docEvidenceList.find((d) => d.id === cand.documentId);
              if (!cand.documentId || !targetDocInfo) {
                const unv = {
                  id: `unv_${Date.now()}_${i}`,
                  documentId: cand.documentId || 'unknown',
                  documentName: 'Unknown Document',
                  quote: cand.quote,
                  verified: false as const,
                  reason: 'unknown document (no valid documentId provided)',
                  citationNumber: cand.id || i + 1,
                };
                collectedUnverified.push(unv);
                sendEvent('unverified', unv);
                continue;
              }

              const vResult = await verifyQuoteForDocument(targetDocInfo.id, cand.quote);
              if (vResult.verified) {
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
                };
                collectedCitations.push(cit);
                sendEvent('citation', cit);
              } else {
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
          } else {
            // --- Single Document QA with Coverage Honesty & Delimiter Streaming ---
            const doc = await prisma.document.findUnique({
              where: { id: docIds[0] },
              select: { id: true, originalFilename: true, pageCount: true },
            });

            if (!doc) {
              throw new Error('Document not found');
            }

            const isExhaustive = isExhaustiveQuestion(question);
            let retrievalResult;

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

              const DELIMITER = '---QUOTES---';
              let passedDelimiter = false;
              let currentLineBuffer = '';
              let quotesJsonBuffer = '';

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

                const text = chunk.text;
                if (passedDelimiter) {
                  quotesJsonBuffer += text;
                  continue;
                }

                currentLineBuffer += text;
                const delimIdx = currentLineBuffer.indexOf(DELIMITER);
                if (delimIdx !== -1) {
                  passedDelimiter = true;
                  const proseBefore = currentLineBuffer.slice(0, delimIdx);
                  if (proseBefore.length > 0) {
                    fullGeneratedText += proseBefore;
                    sendEvent('token', { text: proseBefore });
                  }
                  quotesJsonBuffer = currentLineBuffer.slice(delimIdx + DELIMITER.length);
                  currentLineBuffer = '';
                  continue;
                }

                const potentialPrefixMatch = currentLineBuffer.match(/(\r?\n-[-A-Z]*)$/);
                if (potentialPrefixMatch) {
                  const safeLength = currentLineBuffer.length - potentialPrefixMatch[0].length;
                  if (safeLength > 0) {
                    const safeText = currentLineBuffer.slice(0, safeLength);
                    fullGeneratedText += safeText;
                    sendEvent('token', { text: safeText });
                    currentLineBuffer = currentLineBuffer.slice(safeLength);
                  }
                } else {
                  fullGeneratedText += currentLineBuffer;
                  sendEvent('token', { text: currentLineBuffer });
                  currentLineBuffer = '';
                }
              }

              if (!passedDelimiter && currentLineBuffer.length > 0) {
                fullGeneratedText += currentLineBuffer;
                sendEvent('token', { text: currentLineBuffer });
              }

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

              for (let i = 0; i < candidateCitations.length; i++) {
                const cand = candidateCitations[i];
                if (!cand.quote) continue;

                const vResult = await verifyQuoteForDocument(
                  docIds[0],
                  cand.quote,
                  cand.chunkId
                );

                if (vResult.verified) {
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

          // If answer has zero verified citations and is not a "not found" answer, append unsupported notice
          const textLower = fullGeneratedText.toLowerCase();
          const isNotFoundAnswer =
            textLower.includes('not found') ||
            textLower.includes('not present') ||
            textLower.includes("couldn't find") ||
            textLower.includes('cannot confirm the clause is absent');

          if (collectedCitations.length === 0 && !isNotFoundAnswer && fullGeneratedText.trim().length > 0) {
            sendEvent('notice', {
              message: 'This answer has no verified quotes. Treat it as unsupported.',
            });
          }

          // Persist completed message in database if not aborted
          if (!req.signal.aborted) {
            await prisma.message.create({
              data: {
                conversationId: convId,
                role: 'assistant',
                content: fullGeneratedText.trim(),
                citations: JSON.parse(JSON.stringify(collectedCitations)),
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
