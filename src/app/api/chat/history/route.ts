import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const documentId = searchParams.get('documentId');

    if (!documentId) {
      return NextResponse.json({ error: 'documentId is required' }, { status: 400 });
    }

    const conversation = await prisma.conversation.findFirst({
      where: { documentId },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!conversation) {
      return NextResponse.json({ conversation: null, messages: [] });
    }

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
      },
      messages: conversation.messages.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        role: m.role,
        content: m.content,
        citations: m.citations,
        interrupted: m.interrupted,
        createdAt: m.createdAt,
      })),
    });
  } catch (err: unknown) {
    console.error('Failed to get chat history:', err);
    return NextResponse.json({ error: 'Failed to retrieve chat history' }, { status: 500 });
  }
}

/**
 * Endpoint called when generation is aborted / stopped to persist the partial response.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { conversationId, role, content, citations, interrupted = true } = body;

    if (!conversationId || !content) {
      return NextResponse.json({ error: 'conversationId and content are required' }, { status: 400 });
    }

    const message = await prisma.message.create({
      data: {
        conversationId,
        role: role || 'assistant',
        content,
        citations: citations ? JSON.parse(JSON.stringify(citations)) : null,
        interrupted,
      },
    });

    return NextResponse.json({ success: true, messageId: message.id });
  } catch (err: unknown) {
    console.error('Failed to save interrupted message:', err);
    return NextResponse.json({ error: 'Failed to save message' }, { status: 500 });
  }
}
