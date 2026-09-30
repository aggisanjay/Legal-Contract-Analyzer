import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

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
          content: m.content,
          citations: m.citations,
          interrupted: m.interrupted,
          verifiedCount: m.verifiedCount,
          unverifiedCount: m.unverifiedCount,
          createdAt: m.createdAt,
        })),
      });
    }

    // Case 2: List conversations for a document (including multi-doc ones that include it)
    if (!documentId) {
      return NextResponse.json({ error: 'documentId or conversationId is required' }, { status: 400 });
    }

    // Fetch conversations where documentId equals target, or multi-doc conversations that include it
    const allConvs = await prisma.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: { messages: true },
        },
      },
    });

    const relevant = allConvs.filter((c) => {
      if (c.documentId === documentId) return true;
      if (Array.isArray(c.documentIds) && (c.documentIds as string[]).includes(documentId)) return true;
      return false;
    });

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
