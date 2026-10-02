'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
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
  AlertTriangle,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  History,
  RotateCcw,
  X,
  Plus,
  ShieldAlert,
  ArrowDown,
  Copy,
  Check,
  Trash2,
} from 'lucide-react';
import {
  ChatMessage,
  DocumentMetadata,
  VerifiedCitation,
  CoverageInfo,
  AgentTimelineStep,
} from '@/lib/types';
import { formatPageRanges, deduplicateVerifiedCitations } from '@/lib/utils/format';
import { normalizeCitationMarkers } from '@/lib/ai/stream-cleaner';

interface ChatPanelProps {
  activeDocument: DocumentMetadata | null;
  selectedDocuments: DocumentMetadata[];
  useAgent: boolean;
  onSelectCitation: (citation: VerifiedCitation) => void;
}

interface HistoryConversationItem {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  documentIds?: string[];
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
  const [currentTimeline, setCurrentTimeline] = useState<AgentTimelineStep[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [expandedQuotes, setExpandedQuotes] = useState<Record<string, boolean>>({});
  const [expandedTimelines, setExpandedTimelines] = useState<Record<string, boolean>>({});
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [pastConversations, setPastConversations] = useState<HistoryConversationItem[]>([]);
  const [isLoadingPastConversations, setIsLoadingPastConversations] = useState(false);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [revealedUnsupportedAnswers, setRevealedUnsupportedAnswers] = useState<Record<string, boolean>>({});
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedQuoteId, setCopiedQuoteId] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isMultiDoc = selectedDocuments.length > 1;
  const readyDocs = useMemo(
    () => selectedDocuments.filter((d) => d.status === 'READY'),
    [selectedDocuments]
  );
  const canChat = (activeDocument?.status === 'READY') || readyDocs.length > 0;

  // 1-Click Clipboard Copy Handler
  const handleCopyText = async (text: string, id: string, isQuote = false) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (isQuote) {
        setCopiedQuoteId(id);
        setTimeout(() => setCopiedQuoteId(null), 2000);
      } else {
        setCopiedMessageId(id);
        setTimeout(() => setCopiedMessageId(null), 2000);
      }
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  // Handle user scroll detection
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    setUserScrolledUp(distanceFromBottom > 80);
  };

  const scrollToBottom = (smooth = true) => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
      setUserScrolledUp(false);
    }
  };

  // The active chat session context is determined by selected documents (for multi-doc cross analysis)
  // or the single active/selected document.
  const chatContextKey = useMemo(() => {
    if (selectedDocuments.length > 1) {
      return selectedDocuments.map((d) => d.id).sort().join(',');
    }
    if (selectedDocuments.length === 1) {
      return selectedDocuments[0].id;
    }
    return activeDocument?.id || null;
  }, [selectedDocuments, activeDocument?.id]);

  // Load chat history ONLY when the chat context (selected document/documents) actually changes
  useEffect(() => {
    if (!chatContextKey) {
      setMessages([]);
      setConversationId(null);
      setCurrentTimeline([]);
      setIsLoadingHistory(false);
      return;
    }

    let isMounted = true;
    setIsLoadingHistory(true);

    async function loadLatestConversation() {
      try {
        const readyIds = selectedDocuments.filter((d) => d.status === 'READY').map((d) => d.id);
        const url = selectedDocuments.length > 1 && readyIds.length > 1
          ? `/api/chat/history?documentIds=${readyIds.join(',')}&latest=true`
          : `/api/chat/history?documentId=${chatContextKey}&latest=true`;

        const res = await fetch(url);
        if (!res.ok) {
          if (isMounted) {
            setConversationId(null);
            setMessages([]);
          }
          return;
        }
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
        console.warn('Failed to load chat history:', err);
      } finally {
        if (isMounted) {
          setIsLoadingHistory(false);
        }
      }
    }

    loadLatestConversation();

    return () => {
      isMounted = false;
      setIsLoadingHistory(false);
    };
  }, [chatContextKey]);

  // Auto-scroll when new tokens/messages arrive unless user scrolled up
  useEffect(() => {
    if (!userScrolledUp) {
      scrollToBottom(false);
    }
  }, [messages, streamingStatus, currentTimeline]);

  // Load past conversations for the drawer
  const loadPastConversationsList = async () => {
    if (!chatContextKey) return;
    setIsLoadingPastConversations(true);
    try {
      const readyIds = readyDocs.map((d) => d.id);
      const url = isMultiDoc && readyIds.length > 1
        ? `/api/chat/history?documentIds=${readyIds.join(',')}`
        : `/api/chat/history?documentId=${activeDocument?.id || chatContextKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setPastConversations(data.conversations || []);
      }
    } catch (err) {
      console.error('Failed to list past conversations:', err);
    } finally {
      setIsLoadingPastConversations(false);
    }
  };

  const handleOpenHistoryDrawer = () => {
    setIsHistoryDrawerOpen(true);
    loadPastConversationsList();
  };

  const handleReopenConversation = async (convId: string) => {
    setIsLoadingHistory(true);
    setIsHistoryDrawerOpen(false);
    try {
      const res = await fetch(`/api/chat/history?conversationId=${convId}`);
      if (res.ok) {
        const data = await res.json();
        setConversationId(convId);
        setMessages(data.messages || []);
      }
    } catch (err) {
      console.error('Failed to reopen conversation:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleStartNewChat = () => {
    setConversationId(null);
    setMessages([]);
    setCurrentTimeline([]);
    setIsHistoryDrawerOpen(false);
  };

  // Delete a specific conversation by ID
  const handleDeleteConversation = async (convId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      const res = await fetch(`/api/chat/history?conversationId=${convId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete conversation');

      setPastConversations((prev) => prev.filter((c) => c.id !== convId));
      if (conversationId === convId) {
        setConversationId(null);
        setMessages([]);
        setCurrentTimeline([]);
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  // Clear or delete current active conversation
  const handleClearCurrentChat = async () => {
    if (conversationId) {
      await handleDeleteConversation(conversationId);
    } else {
      setMessages([]);
      setCurrentTimeline([]);
    }
  };

  // Clear all conversations for the active document
  const handleClearAllHistory = async () => {
    if (!activeDocument) return;
    try {
      const res = await fetch(`/api/chat/history?documentId=${activeDocument.id}&all=true`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to clear history');

      setPastConversations([]);
      setConversationId(null);
      setMessages([]);
      setCurrentTimeline([]);
    } catch (err) {
      console.error('Failed to clear all history:', err);
    }
  };

  // Submit Question & Stream SSE Response
  const handleSubmit = async (
    e?: React.FormEvent,
    customQuestion?: string,
    options?: { forceMapReduce?: boolean }
  ) => {
    if (e) e.preventDefault();
    const q = (customQuestion || inputQuestion).trim();
    if (!q || isStreaming) return;

    if (!canChat) {
      setNetworkError('Please upload or select a ready contract document from the library first.');
      return;
    }

    if (!customQuestion) {
      setInputQuestion('');
      if (textareaRef.current) {
        textareaRef.current.style.height = '38px';
      }
    }
    setNetworkError(null);
    const userMsgId = `user_${Date.now()}`;
    const assistantMsgId = `asst_${Date.now()}`;

    // Add user message
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
      unverifiedCitations: [],
      timeline: [],
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg, initialAssistantMsg]);
    setIsStreaming(true);
    setStreamingStatus(
      options?.forceMapReduce
        ? 'Conducting exhaustive review of all document pages...'
        : useAgent
        ? 'Initializing autonomous research agent...'
        : 'Searching contract evidence...'
    );
    setCurrentTimeline([]);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const payload: Record<string, unknown> = {
        question: q,
        useAgent: options?.forceMapReduce ? false : useAgent,
        forceMapReduce: Boolean(options?.forceMapReduce),
        conversationId,
      };

      if (isMultiDoc) {
        payload.documentIds = readyDocs.map((d) => d.id);
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
        throw new Error(`Server returned status ${response.status}`);
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

            if (eventType === 'meta') {
              if (parsed.conversationId) {
                setConversationId(parsed.conversationId);
              }
            } else if (eventType === 'status') {
              setStreamingStatus(parsed.message || null);
              if (parsed.timelineStep) {
                const step = parsed.timelineStep as AgentTimelineStep;
                setCurrentTimeline((prev) => [...prev, step]);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, timeline: [...(m.timeline || []), step] }
                      : m
                  )
                );
              }
            } else if (eventType === 'token') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: m.content + (parsed.text || '') }
                    : m
                )
              );
            } else if (eventType === 'coverage') {
              const coverageInfo = parsed as CoverageInfo;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, coverage: coverageInfo } : m
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
            } else if (eventType === 'unverified') {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id === assistantMsgId) {
                    const existing = m.unverifiedCitations || [];
                    return { ...m, unverifiedCitations: [...existing, parsed] };
                  }
                  return m;
                })
              );
            } else if (eventType === 'notice') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, notice: parsed.message } : m
                )
              );
            } else if (eventType === 'done') {
              if (parsed.conversationId) {
                setConversationId(parsed.conversationId);
              }
            } else if (eventType === 'error') {
              setNetworkError(parsed.message || 'AI provider unavailable or rate-limited. Try again shortly.');
              setStreamingStatus(null);
            }
          } catch {
            // Ignore frame parse errors
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        // Interrupted by user stop
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, interrupted: true } : m
          )
        );
      } else {
        const errorMsg = (err as Error).message || 'Connection interrupted. Please try again.';
        setNetworkError(errorMsg);
      }
    } finally {
      setIsStreaming(false);
      setStreamingStatus(null);
      abortControllerRef.current = null;
    }
  };

  // Stop Generation: genuinely aborts the stream and immediately re-enables input
  const handleStopGenerating = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setStreamingStatus(null);
  };

  const toggleQuoteExpand = (quoteId: string) => {
    setExpandedQuotes((prev) => ({ ...prev, [quoteId]: !prev[quoteId] }));
  };

  const toggleTimelineExpand = (msgId: string) => {
    setExpandedTimelines((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  // Render prose with inline clickable [n] chips and basic markdown
  const renderMessageContent = (content: string, citations: VerifiedCitation[] = []) => {
    if (!content) return null;

    // Normalize any complex or nested citation markers
    let mainText = normalizeCitationMarkers(content);
    let capFootnote: string | null = null;
    const capMatch = mainText.match(/\*\((Research stopped at \d+ rounds)\)\*/i);
    if (capMatch) {
      capFootnote = capMatch[1];
      mainText = mainText.replace(/\*\((Research stopped at \d+ rounds)\)\*/i, '').trim();
    }

    // Split text by lines to handle headers and bullet points
    const lines = mainText.split('\n');

    const renderInlineFormatting = (line: string, lineKey: string) => {
      // Normalize line first to handle any unnormalized inline sequences
      const normalizedLine = normalizeCitationMarkers(line);
      // Tokenize by citation markers [n] or [[n]], and bold **text**
      const tokens = normalizedLine.split(/(\[\[\d+\]\]|\[\d+\]|\*\*[^*]+\*\*)/g);

      return tokens.map((token, tIdx) => {
        const key = `${lineKey}_t_${tIdx}`;

        // Citation chip: [[n]] or [n]
        const citMatch = token.match(/^(?:\[\[(\d+)\]\]|\[(\d+)\])$/);
        if (citMatch) {
          const citNum = parseInt(citMatch[1] || citMatch[2], 10);
          const citation =
            citations.find((c) => (c as any).citationNumber === citNum || c.id === String(citNum) || c.id === `cit_${citNum}`) ||
            citations[citNum - 1] ||
            citations[0];

          let tooltip = `Citation [${citNum}]`;
          if (citation) {
            const docLabel = isMultiDoc && citation.documentName ? `${citation.documentName}: ` : '';
            const preview = citation.quote.length > 80 ? `${citation.quote.slice(0, 80)}…` : citation.quote;
            tooltip = `${docLabel}"${preview}"`;
          }

          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                if (citation) {
                  onSelectCitation(citation);
                  const cardEl = document.getElementById(`quote-card-${citation.id}`);
                  if (cardEl) {
                    cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    cardEl.classList.add('ring-2', 'ring-emerald-500');
                    setTimeout(() => {
                      cardEl.classList.remove('ring-2', 'ring-emerald-500');
                    }, 2000);
                  }
                }
              }}
              className="inline-flex items-center justify-center px-1.5 py-0.2 mx-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-300 transition-all cursor-pointer align-baseline shadow-2xs"
              title={tooltip}
            >
              [{citNum}]
            </button>
          );
        }

        // Bold: **text**
        const boldMatch = token.match(/^\*\*([^*]+)\*\*$/);
        if (boldMatch) {
          return <strong key={key} className="font-semibold text-slate-900">{boldMatch[1]}</strong>;
        }

        return <span key={key}>{token}</span>;
      });
    };

    return (
      <div className="leading-relaxed text-xs space-y-1.5">
        {lines.map((line, lIdx) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return <div key={`line_${lIdx}`} className="h-1.5" />;
          }

          // Header: ### Heading
          if (trimmed.startsWith('### ')) {
            return (
              <h4 key={`line_${lIdx}`} className="font-semibold text-slate-900 text-xs mt-2 mb-0.5">
                {renderInlineFormatting(trimmed.slice(4), `h_${lIdx}`)}
              </h4>
            );
          }

          // Bullet list item: - Item or * Item
          if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            return (
              <div key={`line_${lIdx}`} className="flex items-start gap-1.5 ml-2">
                <span className="text-slate-400 select-none">•</span>
                <span className="flex-1">{renderInlineFormatting(trimmed.slice(2), `b_${lIdx}`)}</span>
              </div>
            );
          }

          return (
            <p key={`line_${lIdx}`} className="whitespace-pre-wrap">
              {renderInlineFormatting(line, `p_${lIdx}`)}
            </p>
          );
        })}

        {capFootnote && (
          <div className="mt-2.5 pt-1.5 border-t border-slate-200/60 text-[10px] text-slate-400 italic">
            *({capFootnote})
          </div>
        )}
      </div>
    );
  };

  const sampleQuestions = [
    'What is the limitation of liability cap?',
    'What are the termination for convenience notice periods?',
    'What is the governing law and jurisdiction?',
    'Does the contract contain an early termination penalty or liquidated damages?',
  ];

  return (
    <section className="w-full border-l border-slate-200 bg-white flex flex-col h-full shrink-0 relative">
      {/* Header */}
      <div className="p-3.5 border-b border-slate-200 flex items-center justify-between bg-white shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
            <Bot className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-xs text-slate-800 truncate">
              {isMultiDoc
                ? `Cross-Contract Analysis (${readyDocs.length})`
                : activeDocument
                ? activeDocument.originalFilename
                : 'Legal Assistant'}
            </h2>
            <p className="text-[10px] text-slate-400">
              {useAgent ? 'Agentic Multi-Step Research' : 'Grounded RAG with Verified Citations'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {useAgent && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-amber-600" />
              Agentic
            </span>
          )}

          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClearCurrentChat}
              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
              title="Clear / delete current conversation"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={handleOpenHistoryDrawer}
            className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
            title="Conversation History"
          >
            <History className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Multi-Doc Pill Banner */}
      {isMultiDoc && (
        <div className="px-3 py-1.5 bg-blue-50/70 border-b border-blue-100 flex items-center gap-1.5 overflow-x-auto text-[11px] text-blue-800 shrink-0">
          <span className="font-semibold shrink-0">Asking across {readyDocs.length} documents:</span>
          <div className="flex items-center gap-1 flex-wrap">
            {readyDocs.map((d) => (
              <span
                key={d.id}
                className="px-1.5 py-0.5 rounded-md bg-white border border-blue-200 text-[10px] font-medium text-slate-700 truncate max-w-[130px]"
                title={d.originalFilename}
              >
                {d.originalFilename}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 space-y-4 no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {isLoadingHistory ? (
          <div className="p-8 text-center text-xs text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
            Loading conversation...
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 px-2 text-slate-400">
            <HelpCircle className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-[1.5]" />
            <h4 className="text-xs font-semibold text-slate-700 mb-1">
              {canChat ? 'Ask a question about this contract' : 'Upload or select a ready contract'}
            </h4>
            <p className="text-[11px] text-slate-400 mb-4 leading-relaxed">
              Every assertion is backed by server-verified quotations matched against canonical contract text.
            </p>

            {canChat && (
              <div className="space-y-1.5 text-left">
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block px-1">
                  Sample Questions
                </span>
                {sampleQuestions.map((q, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSubmit(undefined, q)}
                    className="w-full text-left text-xs p-2 rounded-lg bg-slate-50 hover:bg-blue-50 hover:text-blue-700 text-slate-600 border border-slate-200/70 transition-colors block"
                  >
                    "{q}"
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === 'user';
            const citations = msg.citations || [];
            const unverified = msg.unverifiedCitations || [];
            const timeline = msg.timeline || [];
            const isTimelineExpanded = expandedTimelines[msg.id] ?? false;
            const isCurrentlyGenerating = isStreaming && !isUser && msg.id === messages[messages.length - 1]?.id;
            const shouldCollapseUnsupported =
              !isUser &&
              !isCurrentlyGenerating &&
              !isStreaming &&
              citations.length === 0 &&
              !msg.interrupted &&
              msg.content.trim().length > 0 &&
              !revealedUnsupportedAnswers[msg.id];

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Message Bubble or Collapsed Warning Banner */}
                {shouldCollapseUnsupported ? (
                  <div className="w-full rounded-2xl p-3.5 bg-amber-50 border border-amber-300 text-amber-900 rounded-bl-xs shadow-2xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <span className="font-semibold text-xs">No verified quotes — unsupported.</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setRevealedUnsupportedAnswers((prev) => ({ ...prev, [msg.id]: true }))}
                        className="text-xs font-semibold text-amber-800 underline hover:text-amber-950 shrink-0 cursor-pointer"
                      >
                        Show anyway
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className={`max-w-[95%] rounded-2xl p-3 text-xs leading-relaxed ${
                      isUser
                        ? 'bg-blue-600 text-white shadow-sm rounded-br-xs'
                        : 'bg-slate-100 text-slate-800 border border-slate-200/80 rounded-bl-xs w-full'
                    }`}
                  >
                    {!isUser && !isStreaming && citations.length === 0 && !msg.interrupted && msg.content.trim().length > 0 && (
                      <div className="mb-2 pb-2 border-b border-amber-200/80 flex items-center justify-between text-[10px] text-amber-800">
                        <span className="font-medium flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 text-amber-600" />
                          No verified quotes (unsupported)
                        </span>
                        <button
                          type="button"
                          onClick={() => setRevealedUnsupportedAnswers((prev) => ({ ...prev, [msg.id]: false }))}
                          className="underline hover:text-amber-950"
                        >
                          Collapse
                        </button>
                      </div>
                    )}
                    {isUser ? (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    ) : (
                      renderMessageContent(msg.content, citations)
                    )}

                    {msg.interrupted && (
                      <span className="inline-flex items-center gap-1 mt-2 text-[10px] font-semibold text-amber-800 bg-amber-100/80 px-2 py-0.5 rounded border border-amber-300">
                        <span>Stopped</span>
                      </span>
                    )}

                    {!isUser && msg.content.trim().length > 0 && !isStreaming && (
                      <div className="mt-2 pt-1.5 border-t border-slate-200/60 flex items-center justify-end">
                        <button
                          type="button"
                          onClick={() => handleCopyText(msg.content, msg.id)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-200/70 text-slate-500 hover:text-slate-800 transition-colors text-[10px] font-medium"
                          title="Copy response to clipboard"
                        >
                          {copiedMessageId === msg.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-600" />
                              <span className="text-emerald-600 font-semibold">Copied!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3 text-slate-400" />
                              <span>Copy response</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Notice Banner (Unsupported Answer / Zero Verified Quotes) */}
                {msg.notice && (
                  <div className="w-full mt-2 p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-[11px] text-amber-900 flex items-start gap-2 shadow-2xs">
                    <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="leading-snug">
                      <span className="font-semibold block mb-0.5">Verification Warning</span>
                      <span>{msg.notice}</span>
                    </div>
                  </div>
                )}

                {/* Coverage Bar */}
                {msg.coverage && (
                  <div className="w-full mt-2 p-2 rounded-lg bg-slate-50 border border-slate-200 text-[10px] flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          msg.coverage.pagesExamined >= msg.coverage.pagesTotal &&
                          !msg.coverage.incomplete &&
                          msg.coverage.strategy === 'map-reduce'
                            ? 'bg-emerald-500'
                            : 'bg-amber-500'
                        }`}
                      />
                      <span
                        className="font-medium text-slate-700"
                        title={
                          msg.coverage.pagesExaminedList && msg.coverage.pagesExaminedList.length > 0
                            ? `Examined pages: ${msg.coverage.pagesExaminedList.join(', ')}`
                            : undefined
                        }
                      >
                        {msg.coverage.summary
                          ? msg.coverage.strategy === 'map-reduce' && !msg.coverage.incomplete
                            ? msg.coverage.summary
                            : `${msg.coverage.summary}. Not an exhaustive read.`
                          : msg.coverage.pagesExamined >= msg.coverage.pagesTotal &&
                            !msg.coverage.incomplete &&
                            msg.coverage.strategy === 'map-reduce'
                          ? `Read all ${msg.coverage.pagesTotal} of ${msg.coverage.pagesTotal} pages`
                          : `Looked at ${
                              msg.coverage.pagesExaminedList && msg.coverage.pagesExaminedList.length > 0
                                ? msg.coverage.pagesExaminedList.length === 1
                                  ? `page ${msg.coverage.pagesExaminedList[0]}`
                                  : `pages ${formatPageRanges(msg.coverage.pagesExaminedList)}`
                                : `pages`
                            } (${msg.coverage.pagesExamined} of ${msg.coverage.pagesTotal}). Not an exhaustive read.`}
                      </span>
                    </div>

                    {(msg.coverage.pagesExamined < msg.coverage.pagesTotal ||
                      msg.coverage.incomplete ||
                      msg.coverage.strategy !== 'map-reduce') && (
                      <button
                        type="button"
                        onClick={() => {
                          const msgIdx = messages.findIndex((m) => m.id === msg.id);
                          const userMsg = msgIdx > 0 ? messages[msgIdx - 1] : undefined;
                          const qToRerun = userMsg?.content || msg.content;
                          handleSubmit(undefined, qToRerun, { forceMapReduce: true });
                        }}
                        className="text-blue-600 hover:text-blue-800 font-semibold underline flex items-center gap-0.5"
                      >
                        <RotateCcw className="w-2.5 h-2.5" />
                        Search the whole document
                      </button>
                    )}
                  </div>
                )}

                {/* Agent Step Timeline */}
                {timeline.length > 0 && (
                  <div className="w-full mt-2 rounded-xl border border-blue-100 bg-blue-50/50 p-2.5 text-xs">
                    <div
                      onClick={() => toggleTimelineExpand(msg.id)}
                      className="flex items-center justify-between cursor-pointer text-blue-900 font-semibold text-[11px]"
                    >
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                        <span>Research Timeline ({timeline.length} step{timeline.length === 1 ? '' : 's'})</span>
                      </span>
                      {isTimelineExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5 text-blue-600" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5 text-blue-600" />
                      )}
                    </div>

                    {isTimelineExpanded && (
                      <div className="mt-2 space-y-1.5 border-t border-blue-100 pt-2">
                        {timeline.map((st, sIdx) => (
                          <div
                            key={`tl_${sIdx}`}
                            className="text-[10px] text-slate-700 flex items-start gap-1.5 font-mono"
                          >
                            <span className="text-blue-600 shrink-0">→</span>
                            <span className="leading-snug">{st.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Verified Citations List */}
                {!isUser && citations.length > 0 && (() => {
                  const distinctCitations = deduplicateVerifiedCitations(citations);
                  return (
                    <div className="w-full mt-2.5 space-y-2">
                      <div className="flex items-center justify-between text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-1">
                        <span>Verified Quotes ({distinctCitations.length})</span>
                        <span className="text-emerald-700 font-medium normal-case">Server Verified</span>
                      </div>

                      {distinctCitations.map((cit, cIdx) => {
                        const isExpanded = expandedQuotes[cit.id || `c_${cIdx}`] ?? false;
                        const isMultiOcc = cit.occurrences && cit.occurrences.length > 1;
                        const occPages = isMultiOcc
                          ? cit.occurrences!.map((o: any) => (o.pageStart === o.pageEnd ? `${o.pageStart}` : `${o.pageStart}–${o.pageEnd}`)).join(', ')
                          : '';
                        const pageLabel = isMultiOcc
                          ? `Occurs ${cit.occurrences!.length}× — pp. ${occPages}`
                          : cit.pageStart && cit.pageEnd && cit.pageEnd > cit.pageStart
                          ? `pp. ${cit.pageStart}–${cit.pageEnd}`
                          : cit.pageStart
                          ? `p. ${cit.pageStart}`
                          : '';

                      return (
                        <div
                          key={`cit_${cit.id || cIdx}`}
                          id={`quote-card-${cit.id || cIdx}`}
                          className={`p-3 rounded-xl transition-all shadow-2xs border ${
                            cit.supportStatus === 'related'
                              ? 'bg-slate-50/80 hover:bg-slate-100/60 border-slate-300'
                              : cit.supportStatus === 'unsupported' || cit.supportWarning
                              ? 'bg-amber-50/60 hover:bg-amber-50 border-amber-300'
                              : 'bg-emerald-50/60 hover:bg-emerald-50 border-emerald-200'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] mb-1.5 gap-2">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                  cit.supportStatus === 'related'
                                    ? 'bg-slate-100 text-slate-700 border-slate-300'
                                    : cit.supportStatus === 'unsupported' || cit.supportWarning
                                    ? 'bg-amber-100 text-amber-900 border-amber-300'
                                    : 'bg-emerald-100 text-emerald-800 border-emerald-200'
                                }`}
                              >
                                {cit.supportStatus === 'related' ? (
                                  <>
                                    <FileText className="w-3 h-3 text-slate-500" />
                                    Related passage (does not answer question)
                                  </>
                                ) : cit.supportStatus === 'unsupported' || cit.supportWarning ? (
                                  <>
                                    <AlertTriangle className="w-3 h-3 text-amber-600" />
                                    Verified text, but may not support this claim
                                  </>
                                ) : (
                                  <>
                                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                    Verified
                                  </>
                                )}
                              </span>
                              {pageLabel && (
                                <span className="font-mono text-[10px] text-slate-600 font-medium">
                                  {pageLabel}
                                </span>
                              )}
                            </div>

                            {cit.documentName && (
                              <button
                                type="button"
                                onClick={() => onSelectCitation(cit)}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors cursor-pointer shrink-0 ${
                                  cit.documentName.toLowerCase().includes('v1') || cit.documentName.toLowerCase().includes('doc_1')
                                    ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                                    : cit.documentName.toLowerCase().includes('v2') || cit.documentName.toLowerCase().includes('doc_2')
                                    ? 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100'
                                    : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'
                                }`}
                                title={`Switch viewer to ${cit.documentName} and jump to quote`}
                              >
                                <FileText className="w-2.5 h-2.5" />
                                <span className="truncate max-w-[140px]">{cit.documentName}</span>
                              </button>
                            )}
                          </div>

                          {/* Quote Preview */}
                          <p
                            className={`text-[11px] text-slate-800 font-serif italic leading-relaxed ${
                              !isExpanded ? 'line-clamp-2' : ''
                            }`}
                          >
                            "{cit.quote}"
                          </p>

                          <div className="mt-2 pt-1 border-t border-emerald-100 flex items-center justify-between text-[10px] gap-2">
                            <div className="flex items-center gap-2">
                              {cit.quote.length > 110 && (
                                <button
                                  type="button"
                                  onClick={() => toggleQuoteExpand(cit.id || `c_${cIdx}`)}
                                  className="text-slate-500 hover:text-slate-800 font-medium underline"
                                >
                                  {isExpanded ? 'Show less' : 'Expand quote'}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleCopyText(cit.quote, cit.id || `c_${cIdx}`, true)}
                                className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800 font-medium transition-colors"
                                title="Copy quote to clipboard"
                              >
                                {copiedQuoteId === (cit.id || `c_${cIdx}`) ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-600" />
                                    <span className="text-emerald-600 font-semibold">Copied!</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3 text-slate-400" />
                                    <span>Copy quote</span>
                                  </>
                                )}
                              </button>
                            </div>

                            <button
                              type="button"
                              onClick={() => onSelectCitation(cit)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white hover:bg-emerald-100/70 text-emerald-800 font-semibold border border-emerald-200 transition-colors shrink-0"
                            >
                              <span>Open in document</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

                {/* Unverified Group (Collapsed by default, distinct failure reasons) */}
                {!isUser && unverified.length > 0 && (
                  <div className="w-full mt-2 rounded-xl border border-amber-200 bg-amber-50/50 p-2 text-xs">
                    <details className="group">
                      <summary className="cursor-pointer text-[10px] font-semibold text-amber-900 flex items-center justify-between select-none">
                        <span className="flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                          <span>Failed to Verify ({unverified.length})</span>
                          <span className="text-[9px] font-normal text-amber-700 italic">
                            — candidate quotes excluded from proof
                          </span>
                        </span>
                        <ChevronDown className="w-3 h-3 text-amber-600 group-open:rotate-180 transition-transform" />
                      </summary>

                      <div className="mt-2 space-y-2 border-t border-amber-200/60 pt-2">
                        <p className="text-[10px] text-amber-800 italic">
                          These candidate quotes could not be verified against the canonical contract text:
                        </p>
                        {unverified.map((uCit, uIdx) => (
                          <div
                            key={`ucit_${uIdx}`}
                            className="p-2.5 rounded-lg bg-white/80 border border-amber-200 text-[10px] text-slate-700 space-y-1.5"
                          >
                            <div className="flex items-center justify-between text-[9px] gap-2">
                              {uCit.documentName && uCit.documentName !== 'Unknown Document' ? (
                                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium border shrink-0 ${
                                  uCit.documentName.toLowerCase().includes('v1') || uCit.documentName.toLowerCase().includes('doc_1')
                                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                                    : uCit.documentName.toLowerCase().includes('v2') || uCit.documentName.toLowerCase().includes('doc_2')
                                    ? 'bg-purple-50 text-purple-700 border-purple-200'
                                    : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                                }`}>
                                  <FileText className="w-2.5 h-2.5" />
                                  <span className="truncate max-w-[130px]">{uCit.documentName}</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium bg-rose-50 text-rose-700 border border-rose-200 shrink-0">
                                  Unknown Document
                                </span>
                              )}
                              <span className="text-amber-900 font-semibold truncate text-right">
                                {uCit.reason === 'unknown document'
                                  ? 'Unknown document'
                                  : uCit.reason === 'placeholder'
                                  ? 'Placeholder'
                                  : uCit.reason === 'not found in text'
                                  ? 'Not found in text'
                                  : uCit.reason
                                  ? uCit.reason
                                  : 'Not found in text'}
                              </span>
                            </div>
                            <p className="font-serif italic text-slate-600 line-clamp-2">
                              "{uCit.quote}"
                            </p>
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* Live Streaming Indicator */}
        {isStreaming && (
          <div className="p-3 rounded-xl bg-blue-50/80 border border-blue-200 text-xs text-blue-900 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-blue-600 shrink-0" />
              <span className="text-[11px] font-medium">
                {streamingStatus || 'Generating response...'}
              </span>
            </div>
            {currentTimeline.length > 0 && (
              <span className="text-[10px] font-mono text-blue-600 bg-white px-2 py-0.5 rounded-full border border-blue-200">
                Step {currentTimeline.length}
              </span>
            )}
          </div>
        )}

        {/* Network or Provider Error */}
        {networkError && (
          <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold mb-0.5">Response Error</p>
                <p className="text-[11px] text-rose-700 leading-snug">{networkError}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setNetworkError(null);
                const lastUser = [...messages].reverse().find((m) => m.role === 'user');
                if (lastUser) handleSubmit(undefined, lastUser.content);
              }}
              className="text-[11px] font-semibold text-rose-700 hover:text-rose-900 underline shrink-0 mt-0.5"
            >
              Retry
            </button>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Floating Scroll to Bottom Button */}
      {userScrolledUp && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-16 right-4 p-2 rounded-full bg-slate-900 text-white shadow-lg hover:bg-slate-800 transition-all z-20 flex items-center justify-center text-xs"
          title="Scroll to latest"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}

      {/* Input Form with Stop Button */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-slate-200 bg-white shrink-0">
        <div className="relative flex items-end">
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={
              !canChat
                ? 'Type or paste question (select contract to analyze)...'
                : isMultiDoc
                ? `Ask across ${readyDocs.length} selected contracts (Shift+Enter for newline)...`
                : 'Ask a question or paste a contract clause...'
            }
            value={inputQuestion}
            onChange={(e) => {
              setInputQuestion(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(120, Math.max(38, e.target.scrollHeight))}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            onPaste={(e) => {
              // Ensure paste always works cleanly without being blocked
              const text = e.clipboardData?.getData('text');
              if (text && !inputQuestion) {
                setTimeout(() => {
                  if (textareaRef.current) {
                    textareaRef.current.style.height = 'auto';
                    textareaRef.current.style.height = `${Math.min(120, Math.max(38, textareaRef.current.scrollHeight))}px`;
                  }
                }, 0);
              }
            }}
            disabled={isStreaming}
            className="w-full text-xs pl-3 pr-20 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white text-slate-800 placeholder-slate-400 resize-none overflow-y-auto leading-relaxed max-h-32 transition-colors disabled:opacity-50 no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            style={{ height: '38px' }}
          />

          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1">
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStopGenerating}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-semibold transition-all shadow-xs"
                title="Stop streaming"
              >
                <Square className="w-3 h-3 fill-white" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputQuestion.trim()}
                className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:hover:bg-blue-600 text-white transition-colors"
                title="Send Question (Enter to send, Shift+Enter for newline)"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </form>

      {/* History Drawer */}
      {isHistoryDrawerOpen && (
        <div className="absolute inset-0 z-30 bg-slate-900/40 backdrop-blur-xs flex justify-end">
          <div className="w-80 bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-blue-600" />
                <h3 className="font-bold text-xs text-slate-900">Chat History</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsHistoryDrawerOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 border-b border-slate-100 flex items-center gap-2">
              <button
                type="button"
                onClick={handleStartNewChat}
                className="flex-1 py-2 px-3 rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Conversation</span>
              </button>

              {pastConversations.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAllHistory}
                  className="py-2 px-2.5 rounded-xl bg-slate-100 text-slate-600 hover:bg-rose-50 hover:text-rose-600 font-medium text-xs flex items-center justify-center gap-1 transition-colors shrink-0"
                  title="Delete all conversation history"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear All</span>
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {isLoadingPastConversations ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin mx-auto mb-2 text-blue-500" />
                  Loading history...
                </div>
              ) : pastConversations.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  No previous conversations found.
                </div>
              ) : (
                pastConversations.map((conv) => (
                  <div
                    key={conv.id}
                    onClick={() => handleReopenConversation(conv.id)}
                    className={`group w-full text-left p-2.5 rounded-xl border transition-all text-xs cursor-pointer flex items-center justify-between gap-2 ${
                      conv.id === conversationId
                        ? 'bg-blue-50 border-blue-300 text-blue-900 shadow-2xs'
                        : 'bg-white hover:bg-slate-50 border-slate-100 text-slate-700 hover:border-slate-200'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{conv.title || 'Untitled Chat'}</p>
                      <div className="flex items-center gap-2 text-[10px] text-slate-400 mt-1">
                        <span>{conv.messageCount} msg{conv.messageCount === 1 ? '' : 's'}</span>
                        <span>•</span>
                        <span>
                          {new Date(conv.updatedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => handleDeleteConversation(conv.id, e)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all shrink-0"
                      title="Delete this conversation"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
