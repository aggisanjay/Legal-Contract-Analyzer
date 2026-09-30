'use client';

import React, { useState, useEffect } from 'react';
import { Navbar } from '@/components/Navbar';
import { DocumentLibrary } from '@/components/DocumentLibrary';
import { DocumentViewer } from '@/components/DocumentViewer';
import { ChatPanel } from '@/components/ChatPanel';
import { UploadModal } from '@/components/UploadModal';
import { ComparisonModal } from '@/components/ComparisonModal';
import { DocumentMetadata, VerifiedCitation } from '@/lib/types';

export default function Home() {
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState<boolean>(true);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [activeCitation, setActiveCitation] = useState<VerifiedCitation | null>(null);

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

  const activeDocument = documents.find((d) => d.id === activeDocumentId) || null;
  const selectedDocuments = documents.filter((d) => selectedDocumentIds.includes(d.id));

  // Handlers
  const handleSelectActiveDocument = (doc: DocumentMetadata) => {
    setActiveDocumentId(doc.id);
    setActiveCitation(null);
    if (!selectedDocumentIds.includes(doc.id)) {
      setSelectedDocumentIds([doc.id]);
    }
  };

  const handleToggleDocumentSelection = (docId: string) => {
    setSelectedDocumentIds((prev) => {
      if (prev.includes(docId)) {
        const next = prev.filter((id) => id !== docId);
        return next.length > 0 ? next : prev; // Keep at least one selected
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
      const remaining = documents.filter((d) => d.id !== docId);
      setActiveDocumentId(remaining[0]?.id || null);
    }
  };

  const handleUploadSuccess = (newDoc: DocumentMetadata) => {
    setDocuments((prev) => [newDoc, ...prev]);
    setActiveDocumentId(newDoc.id);
    setSelectedDocumentIds([newDoc.id]);
  };

  const handleSelectCitation = (citation: VerifiedCitation) => {
    // If citation belongs to a different document than active, switch active document
    if (citation.documentId !== activeDocumentId) {
      setActiveDocumentId(citation.documentId);
    }
    setActiveCitation(citation);
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
      />

      {/* Main 3-Column Workspace */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left: Document Library */}
        <DocumentLibrary
          documents={documents}
          activeDocumentId={activeDocumentId}
          selectedDocumentIds={selectedDocumentIds}
          onSelectActiveDocument={handleSelectActiveDocument}
          onToggleDocumentSelection={handleToggleDocumentSelection}
          onDeleteDocument={handleDeleteDocument}
          onOpenUpload={() => setIsUploadModalOpen(true)}
          isLoading={isLoadingDocs}
        />

        {/* Center: Document Viewer (PDF.js + Highlighting) */}
        <DocumentViewer
          document={activeDocument}
          activeCitation={activeCitation}
          onClearActiveCitation={() => setActiveCitation(null)}
        />

        {/* Right: AI Assistant Chat */}
        <ChatPanel
          activeDocument={activeDocument}
          selectedDocuments={selectedDocuments}
          useAgent={useAgent}
          onSelectCitation={handleSelectCitation}
        />
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
