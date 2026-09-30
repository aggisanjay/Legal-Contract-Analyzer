import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { aiClient } from '@/lib/ai/client';
import { retrieveChunksForDocument } from '@/lib/ai/retriever';
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

    const docIds: string[] = documentIds && Array.isArray(documentIds) && documentIds.length > 0
      ? documentIds
      : documentId ? [documentId] : [];

    if (docIds.length === 0) {
      return new Response('At least one document ID is required', { status: 400 });
    }

    // Find or create conversation
    let convId = existingConvId;
    if (!convId) {
      const conv = await prisma.conversation.create({
        data: {
          documentId: docIds.length === 1 ? docIds[0] : null,
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

        function sendEvent(event: string, data: unknown) {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          } catch {
            // Client closed connection
          }
        }

        try {
          if (useAgent && !isMultiDoc) {
            // --- Part C: Agentic Document Research ---
            const doc = await prisma.document.findUnique({
              where: { id: docIds[0] },
              select: { originalFilename: true },
            });

            const agentRes = await runAgenticDocumentResearch({
              documentId: docIds[0],
              documentName: doc?.originalFilename || 'contract.pdf',
              question,
              onProgress: (progress) => {
                sendEvent('status', { message: progress.message });
              },
            });

            // Stream tokens of the verified answer
            sendEvent('status', { message: 'Rendering verified response...' });
            const words = agentRes.answer.split(' ');
            for (const word of words) {
              fullGeneratedText += word + ' ';
              sendEvent('token', { text: word + ' ' });
              await new Promise((r) => setTimeout(r, 15));
            }

            // Emit verified citations
            for (const cit of agentRes.citations) {
              collectedCitations.push(cit);
              sendEvent('citation', cit);
            }
          } else if (isMultiDoc) {
            // --- Multi-Document Analysis ---
            sendEvent('status', { message: `Retrieving evidence across ${docIds.length} contracts...` });

            const docEvidenceList: Array<{ id: string; name: string; evidence: string }> = [];

            for (const dId of docIds) {
              const doc = await prisma.document.findUnique({
                where: { id: dId },
                select: { id: true, originalFilename: true },
              });
              if (!doc) continue;

              sendEvent('status', { message: `Searching "${doc.originalFilename}"...` });
              const chunks = await retrieveChunksForDocument(dId, question, 4);
              const text = chunks.map((c) => c.text).join('\n---\n');

              docEvidenceList.push({
                id: doc.id,
                name: doc.originalFilename,
                evidence: text,
              });
            }

            sendEvent('status', { message: 'Analyzing substantive differences across contracts...' });

            const promptMessages = [
              {
                role: 'system' as const,
                content: MULTI_DOC_QA_SYSTEM_PROMPT,
              },
              {
                role: 'user' as const,
                content: `QUESTION:\n${question}\n\nCONTRACTS EVIDENCE:\n` +
                  docEvidenceList
                    .map((d) => `### Contract: ${d.name} (documentId: "${d.id}")\n${d.evidence}`)
                    .join('\n\n'),
              },
            ];

            const completion = await aiClient.createChatCompletion({
              messages: promptMessages,
              temperature: 0.1,
              responseFormatJson: true,
            });

            let parsedAnswer = "I couldn't find sufficient evidence across the uploaded contracts to answer this reliably.";
            let candidateCitations: Array<{ documentId?: string; quote: string }> = [];

            try {
              const jsonMatch = completion.content?.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.answer) parsedAnswer = parsed.answer;
                if (Array.isArray(parsed.citations)) candidateCitations = parsed.citations;
              } else {
                parsedAnswer = completion.content || parsedAnswer;
              }
            } catch {
              parsedAnswer = completion.content || parsedAnswer;
            }

            // Stream answer tokens
            const words = parsedAnswer.split(' ');
            for (const word of words) {
              fullGeneratedText += word + ' ';
              sendEvent('token', { text: word + ' ' });
              await new Promise((r) => setTimeout(r, 15));
            }

            // Independently verify citations against each specific document!
            sendEvent('status', { message: 'Verifying citations for each contract...' });

            for (let i = 0; i < candidateCitations.length; i++) {
              const cand = candidateCitations[i];
              if (!cand.quote) continue;

              const targetDocId = cand.documentId || docEvidenceList[0]?.id;
              const targetDocInfo = docEvidenceList.find((d) => d.id === targetDocId) || docEvidenceList[0];

              if (!targetDocId) continue;

              const vResult = await verifyQuoteForDocument(targetDocId, cand.quote);
              if (vResult.verified) {
                const cit: VerifiedCitation = {
                  id: `cit_${Date.now()}_${i}`,
                  documentId: targetDocId,
                  documentName: targetDocInfo?.name || 'Contract',
                  quote: vResult.quote,
                  verified: true,
                  startOffset: vResult.startOffset,
                  endOffset: vResult.endOffset,
                  pageStart: vResult.pageStart,
                  pageEnd: vResult.pageEnd,
                };
                collectedCitations.push(cit);
                sendEvent('citation', cit);
              }
            }
          } else {
            // --- Single Document Standard Retrieval QA ---
            sendEvent('status', { message: 'Searching contract evidence...' });

            const doc = await prisma.document.findUnique({
              where: { id: docIds[0] },
              select: { id: true, originalFilename: true },
            });

            if (!doc) {
              throw new Error('Document not found');
            }

            const chunks = await retrieveChunksForDocument(docIds[0], question, 5);

            if (chunks.length === 0) {
              const noEvidenceText = "I couldn't find sufficient evidence in the uploaded contract to answer this reliably.";
              fullGeneratedText = noEvidenceText;
              sendEvent('token', { text: noEvidenceText });
            } else {
              sendEvent('status', { message: 'Reviewing contract clauses...' });

              const evidenceBlock = chunks
                .map((c, i) => `[Evidence ${i + 1} - ChunkID: ${c.id} - Page ${c.pageStart}]\n${c.text}`)
                .join('\n\n');

              const promptMessages = [
                {
                  role: 'system' as const,
                  content: CONTRACT_QA_SYSTEM_PROMPT,
                },
                {
                  role: 'user' as const,
                  content: `QUESTION:\n${question}\n\nEVIDENCE:\n${evidenceBlock}`,
                },
              ];

              sendEvent('status', { message: 'Formulating legal answer...' });

              const completion = await aiClient.createChatCompletion({
                messages: promptMessages,
                temperature: 0.1,
                responseFormatJson: true,
              });

              let parsedAnswer = "I couldn't find sufficient evidence in the uploaded contract to answer this reliably.";
              let candidateCitations: Array<{ quote: string; chunkId?: string }> = [];

              try {
                const jsonMatch = completion.content?.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (parsed.answer) parsedAnswer = parsed.answer;
                  if (Array.isArray(parsed.citations)) candidateCitations = parsed.citations;
                } else {
                  parsedAnswer = completion.content || parsedAnswer;
                }
              } catch {
                parsedAnswer = completion.content || parsedAnswer;
              }

              // Stream tokens progressively
              const words = parsedAnswer.split(' ');
              for (const word of words) {
                fullGeneratedText += word + ' ';
                sendEvent('token', { text: word + ' ' });
                await new Promise((r) => setTimeout(r, 15));
              }

              // Backend Quote Verification
              sendEvent('status', { message: 'Verifying quotations...' });

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
                }
              }
            }
          }

          // Persist the completed assistant message in database
          await prisma.message.create({
            data: {
              conversationId: convId,
              role: 'assistant',
              content: fullGeneratedText.trim(),
              citations: JSON.parse(JSON.stringify(collectedCitations)),
            },
          });

          sendEvent('done', { conversationId: convId });
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : 'An error occurred during chat generation.';
          sendEvent('error', { message: errMessage });

          // Preserve partial assistant message if anything was generated before error
          if (fullGeneratedText.trim()) {
            await prisma.message.create({
              data: {
                conversationId: convId,
                role: 'assistant',
                content: fullGeneratedText.trim(),
                citations: JSON.parse(JSON.stringify(collectedCitations)),
                interrupted: true,
              },
            }).catch(() => {});
          }
        } finally {
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
