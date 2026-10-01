'use client';

import React, { useState } from 'react';
import {
  FileText,
  Trash2,
  CheckSquare,
  Square,
  AlertCircle,
  Loader2,
  CheckCircle2,
  FileCheck,
  Calendar,
  Layers,
  Search,
  RotateCcw,
} from 'lucide-react';
import { DocumentMetadata } from '@/lib/types';

interface DocumentLibraryProps {
  documents: DocumentMetadata[];
  activeDocumentId: string | null;
  selectedDocumentIds: string[];
  onSelectActiveDocument: (doc: DocumentMetadata) => void;
  onToggleDocumentSelection: (docId: string) => void;
  onDeleteDocument: (docId: string) => Promise<void>;
  onRetryDocument?: (docId: string) => Promise<void>;
  onOpenUpload: () => void;
  isLoading: boolean;
}

export const DocumentLibrary: React.FC<DocumentLibraryProps> = ({
  documents,
  activeDocumentId,
  selectedDocumentIds,
  onSelectActiveDocument,
  onToggleDocumentSelection,
  onDeleteDocument,
  onRetryDocument,
  onOpenUpload,
  isLoading,
}) => {
  const [searchFilter, setSearchFilter] = useState('');
  const [docToDelete, setDocToDelete] = useState<DocumentMetadata | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const filteredDocs = documents.filter((doc) =>
    doc.originalFilename.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const handleDeleteConfirm = async () => {
    if (!docToDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteDocument(docToDelete.id);
      setDocToDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const getStatusBadge = (doc: DocumentMetadata) => {
    switch (doc.status) {
      case 'READY':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
            Ready
          </span>
        );
      case 'PROCESSING':
      case 'UPLOADING':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
            <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
            {doc.processingStage || 'Processing'}
          </span>
        );
      case 'FAILED':
        return (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200"
            title={doc.statusMessage || 'Processing failed'}
          >
            <AlertCircle className="w-3 h-3 text-rose-600" />
            Failed
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <aside className="w-full border-r border-slate-200 bg-white flex flex-col h-full shrink-0">
      {/* Sidebar Header */}
      <div className="p-4 border-b border-slate-100 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-600" />
            <h2 className="font-semibold text-slate-900 text-sm">Contract Library</h2>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">
            {documents.length}
          </span>
        </div>

        {/* Filter Input (shown when >8 documents or when user is searching) */}
        {(documents.length > 8 || searchFilter.length > 0) && (
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Filter contracts..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="w-full text-xs pl-8 pr-3 py-2 rounded-lg bg-slate-50 border border-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:bg-white text-slate-800 placeholder-slate-400"
            />
          </div>
        )}
      </div>

      {/* Document List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {isLoading && documents.length === 0 ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3].map((n) => (
              <div key={n} className="p-3 rounded-xl border border-slate-100 bg-slate-50/50 animate-pulse space-y-2">
                <div className="h-3 bg-slate-200 rounded w-3/4" />
                <div className="h-2 bg-slate-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="p-6 text-center text-slate-400">
            <FileText className="w-8 h-8 mx-auto mb-2 text-slate-300 stroke-[1.5]" />
            <p className="text-xs font-medium text-slate-600 mb-1">
              {searchFilter ? 'No matching contracts' : 'No contracts uploaded yet'}
            </p>
            <p className="text-[11px] text-slate-400 mb-4">
              Upload a contract to start analysing it.
            </p>
            <button
              type="button"
              onClick={onOpenUpload}
              className="text-xs font-semibold px-3 py-1.5 rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
            >
              + Upload Contract
            </button>
          </div>
        ) : (
          filteredDocs.map((doc) => {
            const isActive = doc.id === activeDocumentId;
            const isSelected = selectedDocumentIds.includes(doc.id);
            const isDocx = doc.originalFilename.toLowerCase().endsWith('.docx');
            const isReady = doc.status === 'READY';
            const isFailed = doc.status === 'FAILED';

            return (
              <div
                key={doc.id}
                onClick={() => {
                  if (!isFailed) {
                    onSelectActiveDocument(doc);
                  }
                }}
                className={`group relative p-3 rounded-xl border transition-all ${
                  isFailed
                    ? 'bg-rose-50/30 border-rose-200 cursor-not-allowed'
                    : isActive
                    ? 'bg-blue-50/70 border-blue-300 shadow-xs cursor-pointer'
                    : 'bg-white hover:bg-slate-50 border-slate-100 hover:border-slate-200 cursor-pointer'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-start gap-2 min-w-0">
                    {/* Multi-select Checkbox (Only for READY docs) */}
                    {isReady ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleDocumentSelection(doc.id);
                        }}
                        className="mt-0.5 text-slate-400 hover:text-blue-600 transition-colors shrink-0"
                        title={isSelected ? 'Deselect from cross-analysis' : 'Select for cross-analysis'}
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-blue-600 fill-blue-50" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>
                    ) : (
                      <div className="w-4 h-4 mt-0.5 shrink-0" />
                    )}

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.2 rounded uppercase ${
                            isDocx
                              ? 'bg-indigo-100 text-indigo-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {isDocx ? 'DOCX' : 'PDF'}
                        </span>
                        <h3
                          className="font-medium text-xs text-slate-800 truncate"
                          title={doc.originalFilename}
                        >
                          {doc.originalFilename}
                        </h3>
                      </div>
                    </div>
                  </div>

                  {/* Delete Button */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDocToDelete(doc);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded"
                    title="Delete document"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Status & Metadata */}
                <div className="flex items-center justify-between text-[11px] text-slate-400 pl-6">
                  <div className="flex items-center gap-2">
                    {getStatusBadge(doc)}
                    {doc.pageCount > 0 && (
                      <span>{doc.pageCount} page{doc.pageCount === 1 ? '' : 's'}</span>
                    )}
                  </div>

                  <span className="text-[10px] text-slate-400">
                    {new Date(doc.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>

                {/* Error message preview if failed */}
                {isFailed && (
                  <div className="mt-2 text-[11px] text-rose-700 bg-rose-50/80 p-2 rounded-lg border border-rose-200">
                    <p className="line-clamp-2 leading-snug">{doc.statusMessage || 'Processing failed'}</p>
                    <div className="mt-1.5 flex items-center justify-end gap-3">
                      {onRetryDocument && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRetryDocument(doc.id);
                          }}
                          className="text-[10px] font-semibold text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1"
                          title="Re-run document processing"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Retry
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDocToDelete(doc);
                        }}
                        className="text-[10px] font-semibold text-rose-600 hover:underline flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete document
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {docToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-slate-100">
            <div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mb-4">
              <AlertCircle className="w-5 h-5" />
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Delete Contract?</h3>
            <p className="text-xs text-slate-500 mb-4 leading-relaxed">
              Delete this document and its conversation history? This will permanently remove{' '}
              <strong className="text-slate-800">{docToDelete.originalFilename}</strong>, extracted
              passages, and any stored chat messages.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDocToDelete(null)}
                disabled={isDeleting}
                className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-sm transition-colors"
              >
                {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
