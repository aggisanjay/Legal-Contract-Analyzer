'use client';

import React, { useState, useEffect } from 'react';
import { Navbar } from '@/components/Navbar';
import { DocumentLibrary } from '@/components/DocumentLibrary';
import { DocumentViewer } from '@/components/DocumentViewer';
import { ChatPanel } from '@/components/ChatPanel';
import { UploadModal } from '@/components/UploadModal';
import { ComparisonModal } from '@/components/ComparisonModal';
import { DocumentMetadata, VerifiedCitation } from '@/lib/types';
import { Layers, FileText, MessageSquare, PanelLeft, PanelRight } from 'lucide-react';

export default function Home() {
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState<boolean>(true);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [activeCitation, setActiveCitation] = useState<VerifiedCitation | null>(null);

  // Responsive mobile/tablet active tab (< 1024px)
  const [mobileTab, setMobileTab] = useState<'library' | 'viewer' | 'chat'>('viewer');

  // Desktop panel visibility toggles (default both open)
  const [isLibraryOpen, setIsLibraryOpen] = useState<boolean>(true);
  const [isChatOpen, setIsChatOpen] = useState<boolean>(true);

  // Agentic Research (Part C) Mode Toggle
  const [useAgent, setUseAgent] = useState<boolean>(true);

  // Modals
  const [isUploadModalOpen, setIsUploadModalOpen] = useState<boolean>(false);
  const [isCompareModalOpen, setIsCompareModalOpen] = useState<boolean>(false);

  // Load documents on mount
  const fetchDocuments = async () => {
    try {
      setIsLoadingDocs(true);
      const res = await fetch('/api/documents');
      if (!res.ok) return;
      const data = await res.json();
      const docs: DocumentMetadata[] = data.documents || [];
      setDocuments(docs);

      // Auto-select first ready document if none selected
      if (!activeDocumentId && docs.length > 0) {
        const firstReady = docs.find((d) => d.status === 'READY') || docs[0];
        setActiveDocumentId(firstReady.id);
        setSelectedDocumentIds([firstReady.id]);
      }
    } catch (err) {
      console.error('Failed to fetch documents:', err);
    } finally {
      setIsLoadingDocs(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, []);

  // Auto-poll and resume processing for any documents in PROCESSING or UPLOADING state
  useEffect(() => {
    const processingDocs = documents.filter(
      (d) => d.status === 'PROCESSING' || d.status === 'UPLOADING'
    );
    if (processingDocs.length === 0) return;

    // Trigger /process for each processing doc in case background serverless execution was interrupted
    processingDocs.forEach((d) => {
      fetch(`/api/documents/${d.id}/process`, { method: 'POST', keepalive: true }).catch(() => {});
    });

    const pollTimer = setInterval(async () => {
      let anyChanged = false;
      const updatedDocs = await Promise.all(
        documents.map(async (doc) => {
          if (doc.status !== 'PROCESSING' && doc.status !== 'UPLOADING') return doc;
          try {
            const res = await fetch(`/api/documents/${doc.id}/status`);
            if (!res.ok) return doc;
            const data = await res.json();
            if (data.status !== doc.status || data.stage !== doc.processingStage) {
              anyChanged = true;
              return {
                ...doc,
                status: data.status,
                processingStage: data.stage,
                statusMessage: data.message,
                pageCount: data.pageCount ?? doc.pageCount,
              };
            }
          } catch {}
          return doc;
        })
      );

      if (anyChanged) {
        setDocuments(updatedDocs);
        if (!updatedDocs.some((d) => d.status === 'PROCESSING' || d.status === 'UPLOADING')) {
          fetchDocuments();
        }
      }
    }, 1500);

    return () => clearInterval(pollTimer);
  }, [documents]);

  const activeDocument = documents.find((d) => d.id === activeDocumentId) || null;
  const selectedDocuments = documents.filter((d) => selectedDocumentIds.includes(d.id));

  // Handlers
  const handleSelectActiveDocument = (doc: DocumentMetadata) => {
    if (doc.status === 'FAILED') return; // A failed document must never be openable for chat or analysis
    setActiveDocumentId(doc.id);
    setActiveCitation(null);
    if (!selectedDocumentIds.includes(doc.id)) {
      setSelectedDocumentIds([doc.id]);
    }
    setMobileTab('viewer');
  };

  const handleToggleDocumentSelection = (docId: string) => {
    setSelectedDocumentIds((prev) => {
      if (prev.includes(docId)) {
        return prev.filter((id) => id !== docId);
      } else {
        return [...prev, docId];
      }
    });
  };

  const handleDeleteDocument = async (docId: string) => {
    const res = await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');

    setDocuments((prev) => prev.filter((d) => d.id !== docId));
    setSelectedDocumentIds((prev) => prev.filter((id) => id !== docId));

    if (activeDocumentId === docId) {
      const remaining = documents.filter((d) => d.id !== docId && d.status === 'READY');
      setActiveDocumentId(remaining[0]?.id || null);
    }
  };

  const handleRetryDocument = async (docId: string) => {
    try {
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                status: 'PROCESSING',
                processingStage: 'Extracting text',
                statusMessage: 'Retrying document processing...',
              }
            : d
        )
      );

      // Trigger dedicated 60-second processing route
      fetch(`/api/documents/${docId}/process`, { method: 'POST' }).catch((err) => {
        console.warn('Retry trigger error:', err);
      });

      // Poll status every second until completion
      const pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/documents/${docId}/status`);
          if (res.ok) {
            const data = await res.json();
            setDocuments((prev) =>
              prev.map((d) =>
                d.id === docId
                  ? {
                      ...d,
                      status: data.status,
                      processingStage: data.stage,
                      statusMessage: data.message,
                      pageCount: data.pageCount ?? d.pageCount,
                    }
                  : d
              )
            );

            if (data.status === 'READY' || data.status === 'FAILED') {
              clearInterval(pollTimer);
              fetchDocuments();
            }
          }
        } catch {
          // Keep polling
        }
      }, 1000);
    } catch (err) {
      console.error('Failed to retry document:', err);
    }
  };

  const handleUploadSuccess = (newDoc: DocumentMetadata) => {
    setDocuments((prev) => [newDoc, ...prev]);
    setActiveDocumentId(newDoc.id);
    setSelectedDocumentIds((prev) => Array.from(new Set([...prev, newDoc.id])));
    setMobileTab('viewer');
  };

  const handleSelectCitation = (citation: VerifiedCitation) => {
    // If citation belongs to a different document than active, switch active document in viewer
    if (citation.documentId && citation.documentId !== activeDocumentId) {
      setActiveDocumentId(citation.documentId);
    }
    setActiveCitation(citation);
    setMobileTab('viewer');
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-50 text-slate-900">
      {/* Top Navbar */}
      <Navbar
        onOpenUpload={() => setIsUploadModalOpen(true)}
        onOpenCompare={() => setIsCompareModalOpen(true)}
        selectedCount={selectedDocumentIds.length}
        useAgent={useAgent}
        onToggleAgent={setUseAgent}
        isLibraryOpen={isLibraryOpen}
        onToggleLibrary={() => setIsLibraryOpen((prev) => !prev)}
        isChatOpen={isChatOpen}
        onToggleChat={() => setIsChatOpen((prev) => !prev)}
      />

      {/* Mobile/Tablet Sub-Navigation (< 1024px) */}
      <div className="lg:hidden flex items-center justify-around bg-slate-100 border-b border-slate-200 py-1.5 px-3 shrink-0">
        <button
          type="button"
          onClick={() => setMobileTab('library')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
            mobileTab === 'library'
              ? 'bg-white text-blue-600 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Library ({documents.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setMobileTab('viewer')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
            mobileTab === 'viewer'
              ? 'bg-white text-blue-600 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Viewer</span>
        </button>

        <button
          type="button"
          onClick={() => setMobileTab('chat')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
            mobileTab === 'chat'
              ? 'bg-white text-blue-600 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          <span>Assistant</span>
        </button>
      </div>

      {/* Main 3-Column Workspace: Left (Library) | Middle (Viewer) | Right (Assistant) */}
      <main className="flex-1 min-h-0 flex w-full overflow-hidden relative">
        {/* Left Column: Contract Document Library */}
        <div
          className={`h-full shrink-0 ${
            mobileTab === 'library' ? 'flex w-full' : 'hidden'
          } ${isLibraryOpen ? 'lg:flex lg:w-64 xl:w-72' : 'lg:hidden'}`}
        >
          <DocumentLibrary
            documents={documents}
            activeDocumentId={activeDocumentId}
            selectedDocumentIds={selectedDocumentIds}
            onSelectActiveDocument={handleSelectActiveDocument}
            onToggleDocumentSelection={handleToggleDocumentSelection}
            onDeleteDocument={handleDeleteDocument}
            onRetryDocument={handleRetryDocument}
            onOpenUpload={() => setIsUploadModalOpen(true)}
            isLoading={isLoadingDocs}
          />
        </div>

        {/* Middle Column: Document Viewer (PDF.js + Exact Highlighting + Multi-doc Tabs) */}
        <div
          className={`h-full flex-1 min-w-0 flex flex-col overflow-hidden relative ${
            mobileTab === 'viewer' ? 'flex' : 'hidden'
          } lg:flex`}
        >
          {/* Quick Floating Re-expand Buttons when panels are collapsed on desktop */}
          {!isLibraryOpen && (
            <button
              type="button"
              onClick={() => setIsLibraryOpen(true)}
              className="hidden lg:flex absolute top-3 left-3 z-30 px-2.5 py-1.5 rounded-lg bg-white/95 hover:bg-white text-slate-700 hover:text-blue-600 border border-slate-300 shadow-md backdrop-blur transition-all items-center gap-1.5 text-xs font-semibold"
              title="Expand Contract Library (Left Panel)"
            >
              <PanelLeft className="w-3.5 h-3.5 text-blue-600" />
              <span>Library</span>
            </button>
          )}

          {!isChatOpen && (
            <button
              type="button"
              onClick={() => setIsChatOpen(true)}
              className="hidden lg:flex absolute top-3 right-3 z-30 px-2.5 py-1.5 rounded-lg bg-white/95 hover:bg-white text-slate-700 hover:text-blue-600 border border-slate-300 shadow-md backdrop-blur transition-all items-center gap-1.5 text-xs font-semibold"
              title="Expand AI Assistant (Right Panel)"
            >
              <PanelRight className="w-3.5 h-3.5 text-blue-600" />
              <span>Assistant</span>
            </button>
          )}

          <DocumentViewer
            document={activeDocument}
            activeCitation={activeCitation}
            onClearActiveCitation={() => setActiveCitation(null)}
            selectedDocuments={selectedDocuments}
            onSelectDocument={handleSelectActiveDocument}
          />
        </div>

        {/* Right Column: AI Assistant Chat & Citations */}
        <div
          className={`h-full shrink-0 ${
            mobileTab === 'chat' ? 'flex w-full' : 'hidden'
          } ${isChatOpen ? 'lg:flex lg:w-[350px] xl:w-[390px]' : 'lg:hidden'}`}
        >
          <ChatPanel
            activeDocument={activeDocument}
            selectedDocuments={selectedDocuments}
            useAgent={useAgent}
            onSelectCitation={handleSelectCitation}
          />
        </div>
      </main>

      {/* Upload Modal */}
      {isUploadModalOpen && (
        <UploadModal
          onClose={() => setIsUploadModalOpen(false)}
          onSuccess={handleUploadSuccess}
        />
      )}

      {/* Contract Version Comparison Modal */}
      {isCompareModalOpen && (
        <ComparisonModal
          documents={documents}
          onClose={() => setIsCompareModalOpen(false)}
        />
      )}
    </div>
  );
}
