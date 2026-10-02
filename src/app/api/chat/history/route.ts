import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizeCitationMarkers } from '@/lib/ai/stream-cleaner';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const documentId = searchParams.get('documentId');
    const conversationId = searchParams.get('conversationId');

    // Case 1: Load a specific conversation and all its messages with verified citations
    if (conversationId) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!conversation) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      return NextResponse.json({
        conversation: {
          id: conversation.id,
          title: conversation.title,
          documentId: conversation.documentId,
          documentIds: conversation.documentIds,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        messages: conversation.messages.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: normalizeCitationMarkers(m.content),
          citations: m.citations,
          interrupted: m.interrupted,
          verifiedCount: m.verifiedCount,
          unverifiedCount: m.unverifiedCount,
          createdAt: m.createdAt,
        })),
      });
    }

    // Case 2: List conversations or get latest conversation for document(s)
    const documentIdsParam = searchParams.get('documentIds');
    const isLatest = searchParams.get('latest') === 'true';

    const targetDocIds = documentIdsParam
      ? documentIdsParam.split(',').map((s) => s.trim()).filter(Boolean)
      : documentId
      ? [documentId]
      : [];

    if (targetDocIds.length === 0) {
      return NextResponse.json({ error: 'documentId, documentIds, or conversationId is required' }, { status: 400 });
    }

    // Fetch conversations where documentId equals target, or multi-doc conversations that include them
    const allConvs = await prisma.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: { messages: true },
        },
      },
    });

    const relevant = allConvs.filter((c) => {
      if (targetDocIds.length > 1) {
        if (Array.isArray(c.documentIds)) {
          const convDocIds = c.documentIds as string[];
          return targetDocIds.every((id) => convDocIds.includes(id));
        }
        return false;
      } else {
        const singleId = targetDocIds[0];
        if (c.documentId === singleId) return true;
        if (Array.isArray(c.documentIds) && (c.documentIds as string[]).includes(singleId)) return true;
        return false;
      }
    });

    // If latest=true, return the latest conversation with all its messages
    if (isLatest) {
      if (relevant.length === 0) {
        return NextResponse.json({ conversation: null, messages: [] });
      }

      const latestConv = await prisma.conversation.findUnique({
        where: { id: relevant[0].id },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!latestConv) {
        return NextResponse.json({ conversation: null, messages: [] });
      }

      return NextResponse.json({
        conversation: {
          id: latestConv.id,
          title: latestConv.title,
          documentId: latestConv.documentId,
          documentIds: latestConv.documentIds,
          createdAt: latestConv.createdAt,
          updatedAt: latestConv.updatedAt,
        },
        messages: latestConv.messages.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: normalizeCitationMarkers(m.content),
          citations: m.citations,
          interrupted: m.interrupted,
          verifiedCount: m.verifiedCount,
          unverifiedCount: m.unverifiedCount,
          createdAt: m.createdAt,
        })),
      });
    }

    const mapped = relevant.map((c) => ({
      id: c.id,
      title: c.title,
      documentId: c.documentId,
      documentIds: c.documentIds,
      messageCount: c._count.messages,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    return NextResponse.json({ conversations: mapped });
  } catch (err: unknown) {
    console.error('Failed to get chat history:', err);
    return NextResponse.json({ error: 'Failed to retrieve chat history' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const conversationId = searchParams.get('conversationId');
    const documentId = searchParams.get('documentId');
    const deleteAll = searchParams.get('all') === 'true';

    // Case 1: Delete a specific conversation by ID
    if (conversationId) {
      await prisma.conversation.delete({
        where: { id: conversationId },
      });
      return NextResponse.json({ success: true, deletedConversationId: conversationId });
    }

    // Case 2: Delete all conversations for a document
    if (documentId && deleteAll) {
      const deleteResult = await prisma.conversation.deleteMany({
        where: { documentId },
      });
      return NextResponse.json({ success: true, count: deleteResult.count });
    }

    // Also support JSON body
    try {
      const body = await req.json();
      if (body?.conversationId) {
        await prisma.conversation.delete({
          where: { id: body.conversationId },
        });
        return NextResponse.json({ success: true, deletedConversationId: body.conversationId });
      }
      if (body?.documentId && body?.all) {
        const deleteResult = await prisma.conversation.deleteMany({
          where: { documentId: body.documentId },
        });
        return NextResponse.json({ success: true, count: deleteResult.count });
      }
    } catch {
      // Body was empty or not JSON, continue
    }

    return NextResponse.json(
      { error: 'conversationId or documentId with all=true is required' },
      { status: 400 }
    );
  } catch (err: unknown) {
    console.error('Failed to delete conversation history:', err);
    return NextResponse.json({ error: 'Failed to delete conversation history' }, { status: 500 });
  }
}
