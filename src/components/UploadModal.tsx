'use client';

import React, { useState, useRef } from 'react';
import {
  X,
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileCheck,
} from 'lucide-react';
import { DocumentMetadata } from '@/lib/types';

interface UploadModalProps {
  onClose: () => void;
  onSuccess: (newDoc: DocumentMetadata) => void;
}

type Stage = 'idle' | 'uploading' | 'extracting' | 'indexing' | 'ready' | 'failed';

export const UploadModal: React.FC<UploadModalProps> = ({ onClose, onSuccess }) => {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultDoc, setResultDoc] = useState<DocumentMetadata | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setErrorMessage('Unsupported file type. Please upload a PDF or DOCX contract.');
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

  const handleStartUpload = async () => {
    if (!selectedFile) return;

    setStage('uploading');
    setErrorMessage(null);

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      // Stage transition simulation for visual feedback
      setTimeout(() => {
        if (stage !== 'failed') setStage('extracting');
      }, 700);

      setTimeout(() => {
        if (stage !== 'failed') setStage('indexing');
      }, 1500);

      const res = await fetch('/api/documents', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setStage('failed');
        setErrorMessage(data.error || 'Unable to process this document.');
        return;
      }

      const doc: DocumentMetadata = data.document;

      if (doc.status === 'FAILED') {
        setStage('failed');
        setErrorMessage(
          doc.statusMessage ||
            'This PDF appears to be scanned or contains no readable text. Please upload a text-based PDF or DOCX.'
        );
        return;
      }

      setStage('ready');
      setResultDoc(doc);
      onSuccess(doc);
    } catch (err: unknown) {
      setStage('failed');
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to process this document.'
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-bold text-sm text-slate-900">Upload Contract Document</h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {stage === 'idle' && (
            <>
              {/* Drop Zone */}
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
                  className="px-5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-xl shadow-sm transition-colors"
                >
                  Start Processing
                </button>
              </div>
            </>
          )}

          {/* Processing Stages */}
          {(stage === 'uploading' || stage === 'extracting' || stage === 'indexing') && (
            <div className="py-6 space-y-4">
              <div className="text-center mb-6">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-2" />
                <h3 className="text-xs font-bold text-slate-800">Processing Contract Pipeline</h3>
                <p className="text-[11px] text-slate-400">{selectedFile?.name}</p>
              </div>

              <div className="space-y-3 max-w-xs mx-auto text-xs">
                {/* Step 1 */}
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span className="text-slate-800 font-medium">File uploaded</span>
                </div>

                {/* Step 2 */}
                <div className="flex items-center gap-3">
                  {stage === 'uploading' ? (
                    <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  )}
                  <span className={stage === 'uploading' ? 'text-blue-600 font-medium' : 'text-slate-800 font-medium'}>
                    Extracting text & page maps
                  </span>
                </div>

                {/* Step 3 */}
                <div className="flex items-center gap-3">
                  {stage === 'indexing' ? (
                    <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-slate-300 inline-block" />
                  )}
                  <span className={stage === 'indexing' ? 'text-blue-600 font-medium' : 'text-slate-400'}>
                    Building searchable legal index
                  </span>
                </div>

                {/* Step 4 */}
                <div className="flex items-center gap-3">
                  <span className="w-4 h-4 rounded-full border border-slate-300 inline-block" />
                  <span className="text-slate-400">Finalizing</span>
                </div>
              </div>
            </div>
          )}

          {/* Ready Stage */}
          {stage === 'ready' && resultDoc && (
            <div className="py-6 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-2">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Contract Ready for Analysis</h3>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs inline-block text-slate-700">
                <p className="font-semibold text-slate-900 mb-1">{resultDoc.originalFilename}</p>
                <p className="text-slate-500">
                  ✓ Ready &nbsp;·&nbsp; {resultDoc.pageCount} pages &nbsp;·&nbsp; {resultDoc.chunksCount || 'multiple'} searchable passages
                </p>
              </div>

              <div>
                <button
                  onClick={onClose}
                  className="px-6 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm"
                >
                  Open in Analyzer
                </button>
              </div>
            </div>
          )}

          {/* Failed Stage (Scanned PDF or format error) */}
          {stage === 'failed' && (
            <div className="py-6 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-2">
                <AlertCircle className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Processing Failed</h3>
              <p className="text-xs text-rose-700 bg-rose-50 p-3 rounded-xl border border-rose-200 leading-relaxed max-w-sm mx-auto">
                {errorMessage || 'Unable to process this document.'}
              </p>

              <div className="flex justify-center gap-2 pt-2">
                <button
                  onClick={() => {
                    setStage('idle');
                    setSelectedFile(null);
                    setErrorMessage(null);
                  }}
                  className="px-4 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 rounded-xl"
                >
                  Try Another File
                </button>
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-xl"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
