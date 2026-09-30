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
} from 'lucide-react';
import {
  ChatMessage,
  DocumentMetadata,
  VerifiedCitation,
  CoverageInfo,
  AgentTimelineStep,
} from '@/lib/types';
import { formatPageRanges, deduplicateVerifiedCitations } from '@/lib/utils/format';

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

  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isMultiDoc = selectedDocuments.length > 1;
  const readyDocs = selectedDocuments.filter((d) => d.status === 'READY');
  const canChat = readyDocs.length > 0;

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

  // Load active document chat history on mount/document change
  useEffect(() => {
    if (!activeDocument) {
      setMessages([]);
      setConversationId(null);
      return;
    }

    let isMounted = true;
    setIsLoadingHistory(true);

    async function loadLatestConversation() {
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
        console.warn('Failed to load chat history:', err);
      } finally {
        if (isMounted) setIsLoadingHistory(false);
      }
    }

    loadLatestConversation();

    return () => {
      isMounted = false;
    };
  }, [activeDocument?.id]);

  // Auto-scroll when new tokens/messages arrive unless user scrolled up
  useEffect(() => {
    if (!userScrolledUp) {
      scrollToBottom(false);
    }
  }, [messages, streamingStatus, currentTimeline]);

  // Load past conversations for the drawer
  const loadPastConversationsList = async () => {
    if (!activeDocument) return;
    setIsLoadingPastConversations(true);
    try {
      const res = await fetch(`/api/chat/history?documentId=${activeDocument.id}`);
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
    setIsHistoryDrawerOpen(false);
  };

  // Submit Question & Stream SSE Response
  const handleSubmit = async (
    e?: React.FormEvent,
    customQuestion?: string,
    options?: { forceMapReduce?: boolean }
  ) => {
    if (e) e.preventDefault();
    const q = (customQuestion || inputQuestion).trim();
    if (!q || isStreaming || !canChat) return;

    setInputQuestion('');
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

  // Render prose with inline clickable [[n]] chips
  const renderMessageContent = (content: string, citations: VerifiedCitation[] = []) => {
    if (!content) return null;

    // Pattern to match [[1]], [[2]], etc.
    const parts = content.split(/(\[\[\d+\]\])/g);

    return (
      <div className="whitespace-pre-wrap leading-relaxed text-xs">
        {parts.map((part, i) => {
          const match = part.match(/^\[\[(\d+)\]\]$/);
          if (match) {
            const citIndex = parseInt(match[1], 10);
            const citation =
              citations.find((c) => c.id === String(citIndex)) ||
              citations[citIndex - 1] ||
              citations[0];

            return (
              <button
                key={`chip_${i}`}
                type="button"
                onClick={() => citation && onSelectCitation(citation)}
                className="inline-flex items-center justify-center px-1.5 py-0.2 mx-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-300 transition-all cursor-pointer align-baseline shadow-2xs"
                title={citation ? `View verified quote from ${citation.documentName || 'contract'}` : `Citation [${citIndex}]`}
              >
                [{citIndex}]
              </button>
            );
          }
          return <span key={`text_${i}`}>{part}</span>;
        })}
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
    <section className="w-96 border-l border-slate-200 bg-white flex flex-col h-full shrink-0 relative">
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
          <span className="font-semibold shrink-0">Analyzing {readyDocs.length} docs:</span>
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
        className="flex-1 overflow-y-auto p-4 space-y-4"
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

            return (
              <div
                key={msg.id}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
              >
                {/* Message Bubble */}
                <div
                  className={`max-w-[95%] rounded-2xl p-3 text-xs leading-relaxed ${
                    isUser
                      ? 'bg-blue-600 text-white shadow-sm rounded-br-xs'
                      : 'bg-slate-100 text-slate-800 border border-slate-200/80 rounded-bl-xs w-full'
                  }`}
                >
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
                </div>

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
                        {msg.coverage.pagesExamined >= msg.coverage.pagesTotal &&
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
                          className="p-3 rounded-xl bg-emerald-50/60 hover:bg-emerald-50 border border-emerald-200 transition-all shadow-2xs"
                        >
                          <div className="flex items-center justify-between text-[11px] mb-1.5">
                            <div className="flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                Verified
                              </span>
                              {pageLabel && (
                                <span className="font-mono text-[10px] text-slate-600 font-medium">
                                  {pageLabel}
                                </span>
                              )}
                            </div>

                            {cit.documentName && (
                              <span className="text-[10px] text-slate-500 font-medium truncate max-w-[140px]">
                                {cit.documentName}
                              </span>
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

                          <div className="mt-2 pt-1 border-t border-emerald-100 flex items-center justify-between text-[10px]">
                            {cit.quote.length > 110 ? (
                              <button
                                type="button"
                                onClick={() => toggleQuoteExpand(cit.id || `c_${cIdx}`)}
                                className="text-slate-500 hover:text-slate-800 font-medium underline"
                              >
                                {isExpanded ? 'Show less' : 'Expand quote'}
                              </button>
                            ) : (
                              <span />
                            )}

                            <button
                              type="button"
                              onClick={() => onSelectCitation(cit)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white hover:bg-emerald-100/70 text-emerald-800 font-semibold border border-emerald-200 transition-colors"
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

                {/* Unverified Group (Collapsed by default, amber styling, not clickable) */}
                {!isUser && unverified.length > 0 && (
                  <div className="w-full mt-2 rounded-xl border border-amber-200 bg-amber-50/50 p-2 text-xs">
                    <details className="group">
                      <summary className="cursor-pointer text-[10px] font-semibold text-amber-900 flex items-center justify-between select-none">
                        <span className="flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                          <span>Unverified Quotes ({unverified.length})</span>
                          <span className="text-[9px] font-normal text-amber-700 italic">
                            — removed from evidence
                          </span>
                        </span>
                        <ChevronDown className="w-3 h-3 text-amber-600 group-open:rotate-180 transition-transform" />
                      </summary>

                      <div className="mt-2 space-y-2 border-t border-amber-200/60 pt-2">
                        <p className="text-[10px] text-amber-800 italic">
                          These candidate quotes could not be verified against the canonical contract text and have been excluded from proof.
                        </p>
                        {unverified.map((uCit, uIdx) => (
                          <div
                            key={`ucit_${uIdx}`}
                            className="p-2 rounded-lg bg-white/80 border border-amber-200 text-[10px] text-slate-700"
                          >
                            <p className="font-serif italic text-slate-600 line-clamp-2 mb-1">
                              "{uCit.quote}"
                            </p>
                            <div className="flex items-center justify-between text-[9px] text-amber-800 font-medium">
                              <span>Reason: {uCit.reason || 'Verification match failed'}</span>
                              <span className="text-slate-400">Not clickable</span>
                            </div>
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
        <div className="relative flex items-center">
          <input
            type="text"
            placeholder={
              !canChat
                ? 'Select a ready document to chat...'
                : isMultiDoc
                ? `Ask across ${readyDocs.length} selected contracts...`
                : 'Ask a question about this contract...'
            }
            value={inputQuestion}
            onChange={(e) => setInputQuestion(e.target.value)}
            disabled={!canChat || isStreaming}
            className="w-full text-xs pl-3 pr-20 py-2.5 rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white text-slate-800 placeholder-slate-400 disabled:opacity-50"
          />

          <div className="absolute right-1.5 flex items-center gap-1">
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
                disabled={!inputQuestion.trim() || !canChat}
                className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:hover:bg-blue-600 text-white transition-colors"
                title="Send Question"
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

            <div className="p-3 border-b border-slate-100">
              <button
                type="button"
                onClick={handleStartNewChat}
                className="w-full py-2 px-3 rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Conversation</span>
              </button>
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
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => handleReopenConversation(conv.id)}
                    className={`w-full text-left p-2.5 rounded-xl border transition-all text-xs block ${
                      conv.id === conversationId
                        ? 'bg-blue-50 border-blue-300 text-blue-900'
                        : 'bg-white hover:bg-slate-50 border-slate-100 text-slate-700'
                    }`}
                  >
                    <p className="font-medium truncate">{conv.title || 'Untitled Chat'}</p>
                    <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1">
                      <span>{conv.messageCount} message{conv.messageCount === 1 ? '' : 's'}</span>
                      <span>
                        {new Date(conv.updatedAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
