'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  Square,
  Sparkles,
  CheckCircle2,
  ExternalLink,
  Bot,
  User,
  Loader2,
  FileText,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import { ChatMessage, DocumentMetadata, VerifiedCitation } from '@/lib/types';

interface ChatPanelProps {
  activeDocument: DocumentMetadata | null;
  selectedDocuments: DocumentMetadata[];
  useAgent: boolean;
  onSelectCitation: (citation: VerifiedCitation) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  activeDocument,
  selectedDocuments,
  useAgent,
  onSelectCitation,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputQuestion, setInputQuestion] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isMultiDoc = selectedDocuments.length > 1;

  // Load chat history when active document changes
  useEffect(() => {
    if (!activeDocument) {
      setMessages([]);
      setConversationId(null);
      return;
    }

    let isMounted = true;
    setIsLoadingHistory(true);

    async function loadHistory() {
      try {
        const res = await fetch(`/api/chat/history?documentId=${activeDocument!.id}`);
        if (!res.ok) return;
        const data = await res.json();
        if (isMounted) {
          if (data.conversation) {
            setConversationId(data.conversation.id);
            setMessages(data.messages || []);
          } else {
            setConversationId(null);
            setMessages([]);
          }
        }
      } catch (err) {
        console.warn('Failed to load history:', err);
      } finally {
        if (isMounted) setIsLoadingHistory(false);
      }
    }

    loadHistory();

    return () => {
      isMounted = false;
    };
  }, [activeDocument?.id]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingStatus]);

  // Submit Question & Stream SSE Response
  const handleSubmit = async (e?: React.FormEvent, customQuestion?: string) => {
    if (e) e.preventDefault();
    const q = (customQuestion || inputQuestion).trim();
    if (!q || isStreaming) return;

    if (!activeDocument && !isMultiDoc) return;

    setInputQuestion('');
    const userMsgId = `user_${Date.now()}`;
    const assistantMsgId = `asst_${Date.now()}`;

    // Add user message immediately
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: q,
      createdAt: new Date().toISOString(),
    };

    // Add placeholder assistant message
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      citations: [],
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
    setIsStreaming(true);
    setStreamingStatus(useAgent ? 'Initializing agentic research loop...' : 'Searching contract evidence...');

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const payload: Record<string, unknown> = {
        question: q,
        useAgent,
        conversationId,
      };

      if (isMultiDoc) {
        payload.documentIds = selectedDocuments.map((d) => d.id);
      } else {
        payload.documentId = activeDocument!.id;
      }

      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Server returned ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const evtBlock of events) {
          const lines = evtBlock.split('\n');
          let eventType = '';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              eventData = line.slice(6).trim();
            }
          }

          if (!eventType || !eventData) continue;

          try {
            const parsed = JSON.parse(eventData);

            if (eventType === 'status') {
              setStreamingStatus(parsed.message || null);
            } else if (eventType === 'token') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: m.content + parsed.text }
                    : m
                )
              );
            } else if (eventType === 'citation') {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id === assistantMsgId) {
                    const existing = m.citations || [];
                    return { ...m, citations: [...existing, parsed] };
                  }
                  return m;
                })
              );
            } else if (eventType === 'done') {
              if (parsed.conversationId) {
                setConversationId(parsed.conversationId);
              }
            } else if (eventType === 'error') {
              setStreamingStatus(`Error: ${parsed.message}`);
            }
          } catch {
            // Ignore unparseable frames
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        // Interrupted by user
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, interrupted: true } : m
          )
        );
      } else {
        console.error('Chat stream error:', err);
        setStreamingStatus('An error occurred during response generation.');
      }
    } finally {
      setIsStreaming(false);
      setStreamingStatus(null);
      abortControllerRef.current = null;
    }
  };

  // Stop Generation button handler (Section 24)
  const handleStopGenerating = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();

      // Find last assistant message to persist partial output
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && conversationId) {
        try {
          await fetch('/api/chat/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              conversationId,
              role: 'assistant',
              content: lastMsg.content,
              citations: lastMsg.citations,
              interrupted: true,
            }),
          });
        } catch {
          // Ignore
        }
      }
    }
  };

  const sampleQuestions = [
    'What is the limitation of liability cap?',
    'What are the termination for convenience terms?',
    'What is the governing law of this agreement?',
    'Does this contract contain an early termination penalty?',
  ];

  return (
    <section className="w-96 border-l border-slate-200 bg-white flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h2 className="font-semibold text-xs text-slate-800">
              {isMultiDoc ? `Cross-Contract Analysis (${selectedDocuments.length})` : 'AI Contract Assistant'}
            </h2>
            <p className="text-[10px] text-slate-400">
              {useAgent ? 'Autonomous Agentic Research' : 'Grounded RAG with Verified Citations'}
            </p>
          </div>
        </div>

        {useAgent && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-amber-600" />
            Agentic
          </span>
        )}
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoadingHistory ? (
          <div className="p-8 text-center text-xs text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
            Loading conversation history...
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 px-2 text-slate-400">
            <HelpCircle className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-[1.5]" />
            <h4 className="text-xs font-semibold text-slate-700 mb-1">
              Ask a question about this contract
            </h4>
            <p className="text-[11px] text-slate-400 mb-4 leading-relaxed">
              Every factual assertion is grounded with exact, independently verified quotations linked to the PDF passage.
            </p>

            <div className="space-y-1.5 text-left">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block px-1">
                Suggested Questions
              </span>
              {sampleQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSubmit(undefined, q)}
                  className="w-full text-left text-xs p-2 rounded-lg bg-slate-50 hover:bg-blue-50 hover:text-blue-700 text-slate-600 border border-slate-200/70 transition-colors block"
                >
                  "{q}"
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.role === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              <div
                className={`max-w-[92%] rounded-2xl p-3 text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white shadow-sm rounded-br-xs'
                    : 'bg-slate-100 text-slate-800 border border-slate-200/80 rounded-bl-xs'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>

                {msg.interrupted && (
                  <span className="inline-block mt-2 text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                    Generation stopped by user
                  </span>
                )}
              </div>

              {/* Verified Citations List */}
              {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
                <div className="w-full mt-2 space-y-1.5 pl-1">
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block">
                    Verified Citations ({msg.citations.length})
                  </span>
                  {msg.citations.map((cit, cIdx) => (
                    <div
                      key={`cit_${cIdx}`}
                      onClick={() => onSelectCitation(cit)}
                      className="group p-2.5 rounded-xl bg-amber-50/70 hover:bg-amber-100/80 border border-amber-200/90 transition-all cursor-pointer shadow-xs"
                    >
                      <div className="flex items-center justify-between text-[10px] text-amber-800 font-semibold mb-1">
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          <span className="text-emerald-700">Verified Quote</span>
                        </span>
                        <span className="flex items-center gap-1 text-slate-500 font-normal">
                          <span>{cit.documentName}</span>
                          {cit.pageStart && <span>· Page {cit.pageStart}</span>}
                        </span>
                      </div>

                      <p className="text-[11px] text-slate-800 italic leading-snug mb-1 font-serif">
                        "{cit.quote}"
                      </p>

                      <div className="flex items-center justify-end text-[10px] text-blue-600 font-medium group-hover:underline gap-0.5">
                        <span>Open in document</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}

        {/* Live Agent / Streaming Progress Indicator */}
        {isStreaming && (
          <div className="p-3 rounded-xl bg-blue-50/80 border border-blue-200 text-xs text-blue-800 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600 shrink-0" />
            <span className="text-[11px] font-medium animate-pulse">
              {streamingStatus || 'Analyzing contract...'}
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Stop Generating Button */}
      {isStreaming && (
        <div className="px-4 py-1.5 flex justify-center">
          <button
            onClick={handleStopGenerating}
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-800 hover:bg-slate-900 text-white shadow-sm transition-all"
          >
            <Square className="w-3 h-3 fill-white" />
            <span>Stop generating</span>
          </button>
        </div>
      )}

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-slate-200 bg-white">
        <div className="relative flex items-center">
          <input
            type="text"
            placeholder={
              isMultiDoc
                ? `Ask across ${selectedDocuments.length} selected contracts...`
                : 'Ask a question about this contract...'
            }
            value={inputQuestion}
            onChange={(e) => setInputQuestion(e.target.value)}
            disabled={isStreaming}
            className="w-full text-xs pl-3 pr-10 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white text-slate-800 placeholder-slate-400 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!inputQuestion.trim() || isStreaming}
            className="absolute right-1.5 p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:hover:bg-blue-600 text-white transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </section>
  );
};
