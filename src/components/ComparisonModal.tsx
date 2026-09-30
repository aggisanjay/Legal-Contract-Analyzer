'use client';

import React, { useState } from 'react';
import {
  X,
  FileDiff,
  AlertOctagon,
  AlertTriangle,
  Info,
  ArrowRight,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { ContractComparisonResult, DocumentMetadata, SignificanceLevel } from '@/lib/types';

interface ComparisonModalProps {
  documents: DocumentMetadata[];
  onClose: () => void;
}

export const ComparisonModal: React.FC<ComparisonModalProps> = ({
  documents,
  onClose,
}) => {
  const readyDocs = documents.filter((d) => d.status === 'READY');

  const [docAId, setDocAId] = useState<string>(readyDocs[0]?.id || '');
  const [docBId, setDocBId] = useState<string>(readyDocs[1]?.id || readyDocs[0]?.id || '');
  const [isComparing, setIsComparing] = useState(false);
  const [comparisonResult, setComparisonResult] = useState<ContractComparisonResult | null>(null);
  const [filterSig, setFilterSig] = useState<SignificanceLevel | 'ALL'>('ALL');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleRunComparison = async () => {
    if (!docAId || !docBId) return;
    if (docAId === docBId) {
      setErrorMsg('Please select two different contracts or versions to compare.');
      return;
    }

    setIsComparing(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentAId: docAId, documentBId: docBId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Comparison failed');
      }

      const data = await res.json();
      setComparisonResult(data.comparison);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Comparison failed');
    } finally {
      setIsComparing(false);
    }
  };

  const filteredDiffs = comparisonResult?.differences.filter((d) => {
    if (filterSig === 'ALL') return true;
    return d.significance === filterSig;
  }) || [];

  const getSigBadge = (sig: SignificanceLevel) => {
    switch (sig) {
      case 'HIGH':
        return (
          <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-700 border border-rose-200">
            <AlertOctagon className="w-3.5 h-3.5 text-rose-600" />
            HIGH SIGNIFICANCE
          </span>
        );
      case 'MEDIUM':
        return (
          <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-700 border border-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            MEDIUM SIGNIFICANCE
          </span>
        );
      case 'LOW':
        return (
          <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
            <Info className="w-3.5 h-3.5 text-slate-500" />
            LOW SIGNIFICANCE
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl max-w-4xl w-full h-[90vh] shadow-2xl flex flex-col overflow-hidden border border-slate-200">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0 bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
              <FileDiff className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Contract Version Comparison</h2>
              <p className="text-xs text-slate-500">
                Substantive clause-level semantic comparison with legal significance ratings
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Contract Selector Controls */}
        <div className="p-5 border-b border-slate-200 bg-white grid grid-cols-1 md:grid-cols-3 gap-4 items-end shrink-0">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Contract A (Base Version)
            </label>
            <select
              value={docAId}
              onChange={(e) => setDocAId(e.target.value)}
              className="w-full text-xs p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {readyDocs.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.originalFilename}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Contract B (Revised Version)
            </label>
            <select
              value={docBId}
              onChange={(e) => setDocBId(e.target.value)}
              className="w-full text-xs p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {readyDocs.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.originalFilename}
                </option>
              ))}
            </select>
          </div>

          <div>
            <button
              onClick={handleRunComparison}
              disabled={isComparing || readyDocs.length < 2}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors shadow-sm"
            >
              {isComparing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Comparing Clauses...</span>
                </>
              ) : (
                <>
                  <FileDiff className="w-4 h-4" />
                  <span>Compare Contracts</span>
                </>
              )}
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="mx-5 mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
            {errorMsg}
          </div>
        )}

        {/* Comparison Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!comparisonResult ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-400">
              <FileDiff className="w-12 h-12 text-slate-300 stroke-[1.5] mb-3" />
              <h4 className="text-sm font-semibold text-slate-700 mb-1">
                Select two contract versions to compare
              </h4>
              <p className="text-xs text-slate-400 max-w-sm">
                The comparison engine analyzes clauses semantically to detect substantive changes in liabilities, notice periods, and material terms.
              </p>
            </div>
          ) : (
            <>
              {/* Summary Bar */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold text-slate-800">
                    {comparisonResult.summary.generalAssessment}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {comparisonResult.documentAName} <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" /> {comparisonResult.documentBName}
                  </p>
                </div>

                {/* Significance Filter Tabs */}
                <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-lg text-xs font-semibold">
                  <button
                    onClick={() => setFilterSig('ALL')}
                    className={`px-3 py-1 rounded-md transition-colors ${
                      filterSig === 'ALL'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All ({comparisonResult.summary.totalCount})
                  </button>
                  <button
                    onClick={() => setFilterSig('HIGH')}
                    className={`px-3 py-1 rounded-md transition-colors ${
                      filterSig === 'HIGH'
                        ? 'bg-rose-600 text-white shadow-xs'
                        : 'text-rose-700 hover:bg-rose-50'
                    }`}
                  >
                    High ({comparisonResult.summary.highCount})
                  </button>
                  <button
                    onClick={() => setFilterSig('MEDIUM')}
                    className={`px-3 py-1 rounded-md transition-colors ${
                      filterSig === 'MEDIUM'
                        ? 'bg-amber-600 text-white shadow-xs'
                        : 'text-amber-700 hover:bg-amber-50'
                    }`}
                  >
                    Medium ({comparisonResult.summary.mediumCount})
                  </button>
                  <button
                    onClick={() => setFilterSig('LOW')}
                    className={`px-3 py-1 rounded-md transition-colors ${
                      filterSig === 'LOW'
                        ? 'bg-slate-700 text-white shadow-xs'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    Low ({comparisonResult.summary.lowCount})
                  </button>
                </div>
              </div>

              {/* Differences Cards */}
              <div className="space-y-4">
                {filteredDiffs.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-400 bg-slate-50 rounded-xl">
                    No differences match the selected filter.
                  </div>
                ) : (
                  filteredDiffs.map((diff) => (
                    <div
                      key={diff.id}
                      className="p-5 rounded-2xl border border-slate-200 bg-white shadow-xs hover:shadow-md transition-shadow"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          {diff.sectionNumber && (
                            <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                              {diff.sectionNumber}
                            </span>
                          )}
                          <h3 className="font-bold text-sm text-slate-900">{diff.title}</h3>
                        </div>
                        {getSigBadge(diff.significance)}
                      </div>

                      {/* Substantive summary and plain-language impact */}
                      <div className="mb-4 p-3 rounded-xl bg-blue-50/60 border border-blue-100 text-xs">
                        <p className="font-semibold text-blue-900 mb-1">
                          Substantive Change: <span className="font-normal text-slate-800">{diff.substantiveChange}</span>
                        </p>
                        <p className="font-semibold text-blue-900">
                          Plain-Language Impact: <span className="font-normal text-slate-800">{diff.plainLanguageImpact}</span>
                        </p>
                      </div>

                      {/* Side-by-side or stacked Old vs New Text */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                        <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                          <span className="font-bold text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                            OLD (Base Version)
                          </span>
                          <p className="text-slate-700 font-serif leading-relaxed italic">
                            "{diff.originalText}"
                          </p>
                        </div>
                        <div className="p-3 rounded-xl bg-emerald-50/40 border border-emerald-200">
                          <span className="font-bold text-[10px] text-emerald-700 uppercase tracking-wider block mb-1">
                            NEW (Revised Version)
                          </span>
                          <p className="text-slate-900 font-serif leading-relaxed italic font-medium">
                            "{diff.revisedText}"
                          </p>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
