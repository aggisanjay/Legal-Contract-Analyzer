'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { DocumentMetadata } from '@/lib/types';

interface UploadModalProps {
  onClose: () => void;
  onSuccess: (newDoc: DocumentMetadata) => void;
}

const STAGES = [
  'Uploading',
  'Extracting text',
  'Splitting into sections',
  'Indexing',
  'Ready',
];

export const UploadModal: React.FC<UploadModalProps> = ({ onClose, onSuccess }) => {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadedDocId, setUploadedDocId] = useState<string | null>(null);
  const [currentStage, setCurrentStage] = useState<string>('Uploading');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isFailed, setIsFailed] = useState<boolean>(false);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [readyDoc, setReadyDoc] = useState<DocumentMetadata | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelected(e.target.files[0]);
    }
  };

  const handleFileSelected = (file: File) => {
    setErrorMessage(null);
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf' && ext !== 'docx') {
      setErrorMessage('Unsupported file type. Please upload a PDF or DOCX.');
      setSelectedFile(null);
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setErrorMessage('File size exceeds the 50 MB limit.');
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
  };

  const startPollingStatus = (docId: string) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    pollTimerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/documents/${docId}/status`);
        if (!res.ok) return;

        const data = await res.json();
        setCurrentStage(data.stage || 'Extracting text');
        setProgressPercent(data.progress ?? 30);

        if (data.status === 'READY') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setIsProcessing(false);
          setCurrentStage('Ready');
          setProgressPercent(100);

          // Fetch full document metadata
          const docRes = await fetch('/api/documents');
          if (docRes.ok) {
            const listData = await docRes.json();
            const found = (listData.documents || []).find((d: DocumentMetadata) => d.id === docId);
            if (found) {
              setReadyDoc(found);
              onSuccess(found);
            }
          }
        } else if (data.status === 'FAILED') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setIsProcessing(false);
          setIsFailed(true);
          setFailureReason(data.message || 'Processing was interrupted. Please upload again.');
        }
      } catch (err) {
        console.warn('Status poll failed:', err);
      }
    }, 1000);
  };

  const handleStartUpload = async () => {
    if (!selectedFile) return;

    setIsProcessing(true);
    setIsFailed(false);
    setErrorMessage(null);
    setCurrentStage('Uploading');
    setProgressPercent(15);

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const res = await fetch('/api/documents', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setIsProcessing(false);
        setIsFailed(true);
        setFailureReason(data.error || 'Upload failed. Please upload a valid PDF or DOCX.');
        return;
      }

      const docId = data.id || data.document?.id;
      setUploadedDocId(docId);
      setCurrentStage('Extracting text');
      setProgressPercent(30);

      // Start polling status
      startPollingStatus(docId);
    } catch (err: unknown) {
      setIsProcessing(false);
      setIsFailed(true);
      setFailureReason(err instanceof Error ? err.message : 'Unable to upload file.');
    }
  };

  const handleDeleteFailed = async () => {
    if (uploadedDocId) {
      try {
        await fetch(`/api/documents/${uploadedDocId}`, { method: 'DELETE' });
      } catch {
        // Ignore
      }
    }
    handleReset();
  };

  const handleReset = () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    setSelectedFile(null);
    setUploadedDocId(null);
    setIsProcessing(false);
    setIsFailed(false);
    setFailureReason(null);
    setReadyDoc(null);
    setProgressPercent(0);
    setCurrentStage('Uploading');
  };

  const getStageIndex = (stageName: string) => {
    return STAGES.indexOf(stageName);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-bold text-sm text-slate-900">Upload Contract Document</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* 1. File Selection State */}
          {!isProcessing && !isFailed && !readyDoc && (
            <>
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
                  dragActive
                    ? 'border-blue-500 bg-blue-50/60'
                    : 'border-slate-200 hover:border-blue-400 hover:bg-slate-50'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleFileChange}
                  className="hidden"
                />

                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-3">
                  <UploadCloud className="w-6 h-6" />
                </div>

                <p className="text-xs font-semibold text-slate-800 mb-1">
                  Click to select or drag and drop contract
                </p>
                <p className="text-[11px] text-slate-400 mb-3">
                  Supported formats: <strong>PDF</strong> and <strong>DOCX</strong> (Max 50 MB)
                </p>

                {selectedFile && (
                  <div className="inline-flex items-center gap-2 p-2 rounded-xl bg-blue-50 text-blue-700 text-xs font-medium border border-blue-200">
                    <FileText className="w-4 h-4" />
                    <span>{selectedFile.name}</span>
                    <span className="text-[10px] text-blue-500">
                      ({(selectedFile.size / (1024 * 1024)).toFixed(2)} MB)
                    </span>
                  </div>
                )}
              </div>

              {errorMessage && (
                <div className="mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleStartUpload}
                  disabled={!selectedFile}
                  className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-xl shadow-xs transition-colors"
                >
                  Start Processing
                </button>
              </div>
            </>
          )}

          {/* 2. Live Polling Processing Card with Stepper */}
          {isProcessing && (
            <div className="py-4 space-y-5">
              <div className="text-center">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-2" />
                <h3 className="text-xs font-bold text-slate-800">Processing Contract</h3>
                <p className="text-[11px] text-slate-400 truncate max-w-xs mx-auto">
                  {selectedFile?.name}
                </p>
              </div>

              {/* Progress bar */}
              <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden border border-slate-200">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              {/* Stepper */}
              <div className="space-y-2.5 max-w-xs mx-auto text-xs">
                {STAGES.slice(0, 4).map((stageName, idx) => {
                  const currentIdx = getStageIndex(currentStage);
                  const isDone = currentIdx > idx;
                  const isCurrent = currentIdx === idx;

                  return (
                    <div key={stageName} className="flex items-center gap-3">
                      {isDone ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      ) : isCurrent ? (
                        <Loader2 className="w-4 h-4 animate-spin text-blue-600 shrink-0" />
                      ) : (
                        <span className="w-4 h-4 rounded-full border border-slate-300 inline-block shrink-0" />
                      )}
                      <span
                        className={`font-medium ${
                          isDone
                            ? 'text-slate-800'
                            : isCurrent
                            ? 'text-blue-600 font-semibold'
                            : 'text-slate-400'
                        }`}
                      >
                        {stageName}
                      </span>
                    </div>
                  );
                })}
              </div>

              <p className="text-[10px] text-center text-slate-400">
                Extracting canonical text, indexing clauses, and verifying readability...
              </p>
            </div>
          )}

          {/* 3. Ready Stage */}
          {readyDoc && !isFailed && (
            <div className="py-4 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-2">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Contract Ready for Analysis</h3>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs inline-block text-slate-700 max-w-xs">
                <p className="font-semibold text-slate-900 mb-1 truncate">{readyDoc.originalFilename}</p>
                <p className="text-slate-500 text-[11px]">
                  {readyDoc.pageCount} page{readyDoc.pageCount === 1 ? '' : 's'} · Verified canonical text
                </p>
              </div>

              <div>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-6 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-xs"
                >
                  Open in Analyzer
                </button>
              </div>
            </div>
          )}

          {/* 4. Failed Stage (Scanned PDF or format error) */}
          {isFailed && (
            <div className="py-4 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-2">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Processing Failed</h3>
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 leading-relaxed max-w-sm mx-auto text-left">
                <p className="font-semibold mb-1">Unable to extract readable text:</p>
                <p className="text-[11px] text-rose-700">{failureReason}</p>
              </div>

              <div className="flex justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleDeleteFailed}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-xl"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete & Reset</span>
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Upload Another</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
