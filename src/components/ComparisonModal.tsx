'use client';

import React, { useState, useMemo } from 'react';
import {
  X,
  FileDiff,
  AlertOctagon,
  AlertTriangle,
  Info,
  ArrowRight,
  Loader2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Filter,
  ArrowUpDown,
  Layers,
} from 'lucide-react';
import {
  ContractComparisonResult,
  DocumentMetadata,
  SignificanceLevel,
  ClauseDifference,
} from '@/lib/types';

interface ComparisonModalProps {
  documents: DocumentMetadata[];
  onClose: () => void;
}

type ChangeTypeFilter = 'ALL' | 'added' | 'removed' | 'modified' | 'reworded';
type SortOrder = 'SIGNIFICANCE' | 'DOCUMENT_ORDER' | 'CHANGE_TYPE';

export const ComparisonModal: React.FC<ComparisonModalProps> = ({
  documents,
  onClose,
}) => {
  const readyDocs = documents.filter((d) => d.status === 'READY');

  const [docAId, setDocAId] = useState<string>(readyDocs[0]?.id || '');
  const [docBId, setDocBId] = useState<string>(readyDocs[1]?.id || readyDocs[0]?.id || '');
  const [isComparing, setIsComparing] = useState(false);
  const [comparisonProgress, setComparisonProgress] = useState<string | null>(null);
  const [comparisonResult, setComparisonResult] = useState<ContractComparisonResult | null>(null);
  const [filterSig, setFilterSig] = useState<SignificanceLevel | 'ALL'>('ALL');
  const [filterChangeType, setFilterChangeType] = useState<ChangeTypeFilter>('ALL');
  const [sortOrder, setSortOrder] = useState<SortOrder>('SIGNIFICANCE');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({});
  const [isRewordedCollapsed, setIsRewordedCollapsed] = useState(true);

  const handleRunComparison = async () => {
    if (!docAId || !docBId) return;
    if (docAId === docBId) {
      setErrorMsg('Please select two different contracts or versions to compare.');
      return;
    }

    setIsComparing(true);
    setErrorMsg(null);
    setComparisonProgress('Extracting clauses & aligning contract sections...');

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
      setComparisonProgress(null);
    }
  };

  const toggleDiffExpand = (diffId: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [diffId]: !prev[diffId] }));
  };

  // Split into standard changes and reworded-only changes
  const { standardDiffs, rewordedOnlyDiffs } = useMemo(() => {
    if (!comparisonResult) return { standardDiffs: [], rewordedOnlyDiffs: [] };

    const standard: ClauseDifference[] = [];
    const reworded: ClauseDifference[] = [];

    comparisonResult.differences.forEach((d) => {
      if (d.changeType === 'reworded' && d.significance === 'LOW') {
        reworded.push(d);
      } else {
        standard.push(d);
      }
    });

    return { standardDiffs: standard, rewordedOnlyDiffs: reworded };
  }, [comparisonResult]);

  // Filter & Sort Standard Differences
  const filteredStandardDiffs = useMemo(() => {
    let diffs = standardDiffs.filter((d) => {
      if (filterSig !== 'ALL' && d.significance !== filterSig) return false;
      if (filterChangeType !== 'ALL' && d.changeType !== filterChangeType) return false;
      return true;
    });

    // Sorting
    const sigRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    diffs.sort((a, b) => {
      if (sortOrder === 'SIGNIFICANCE') {
        return (sigRank[b.significance] || 0) - (sigRank[a.significance] || 0);
      }
      if (sortOrder === 'CHANGE_TYPE') {
        return (a.changeType || '').localeCompare(b.changeType || '');
      }
      return 0; // Document order default
    });

    return diffs;
  }, [standardDiffs, filterSig, filterChangeType, sortOrder]);

  const getSigBadge = (sig: SignificanceLevel) => {
    switch (sig) {
      case 'HIGH':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-700 border border-rose-200">
            <AlertOctagon className="w-3.5 h-3.5 text-rose-600" />
            HIGH SIGNIFICANCE
          </span>
        );
      case 'MEDIUM':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-700 border border-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            MEDIUM SIGNIFICANCE
          </span>
        );
      case 'LOW':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
            <Info className="w-3.5 h-3.5 text-slate-500" />
            LOW SIGNIFICANCE
          </span>
        );
    }
  };

  const getChangeTypeBadge = (changeType?: string) => {
    switch (changeType) {
      case 'added':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 uppercase">
            Added Clause
          </span>
        );
      case 'removed':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 uppercase">
            Removed Clause
          </span>
        );
      case 'modified':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 uppercase">
            Modified Clause
          </span>
        );
      case 'reworded':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 uppercase">
            Reworded
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
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
                Semantic clause-by-clause alignment, risk impact ratings, and inline diffs
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Contract Selector Controls */}
        <div className="p-4 border-b border-slate-200 bg-white grid grid-cols-1 md:grid-cols-3 gap-4 items-end shrink-0">
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
              type="button"
              onClick={handleRunComparison}
              disabled={isComparing || readyDocs.length < 2}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors shadow-xs"
            >
              {isComparing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{comparisonProgress || 'Comparing Clauses...'}</span>
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
                The comparison engine extracts clauses, detects added/removed terms, classifies substantive legal risks, and generates inline word-level diffs.
              </p>
            </div>
          ) : (
            <>
              {/* Summary Card */}
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-bold text-slate-900">Overall Assessment</h3>
                    <p className="text-xs text-slate-700 mt-0.5 leading-relaxed">
                      {comparisonResult.summary.generalAssessment}
                    </p>
                  </div>
                  <div className="text-[11px] text-slate-500 font-medium shrink-0">
                    <span>{comparisonResult.documentAName}</span>
                    <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" />
                    <span>{comparisonResult.documentBName}</span>
                  </div>
                </div>

                {/* Filter and Sort Toolbar */}
                <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  {/* Significance Tabs */}
                  <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-lg text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => setFilterSig('ALL')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        filterSig === 'ALL' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      All ({comparisonResult.summary.totalCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterSig('HIGH')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        filterSig === 'HIGH' ? 'bg-rose-600 text-white shadow-2xs' : 'text-rose-700 hover:bg-rose-50'
                      }`}
                    >
                      High ({comparisonResult.summary.highCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterSig('MEDIUM')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        filterSig === 'MEDIUM' ? 'bg-amber-600 text-white shadow-2xs' : 'text-amber-700 hover:bg-amber-50'
                      }`}
                    >
                      Medium ({comparisonResult.summary.mediumCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterSig('LOW')}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        filterSig === 'LOW' ? 'bg-slate-700 text-white shadow-2xs' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      Low ({comparisonResult.summary.lowCount})
                    </button>
                  </div>

                  {/* Change Type & Sorting Controls */}
                  <div className="flex items-center gap-2 text-xs">
                    <select
                      value={filterChangeType}
                      onChange={(e) => setFilterChangeType(e.target.value as ChangeTypeFilter)}
                      className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium"
                    >
                      <option value="ALL">All Changes</option>
                      <option value="modified">Modified Only</option>
                      <option value="added">Added Only</option>
                      <option value="removed">Removed Only</option>
                      <option value="reworded">Reworded Only</option>
                    </select>

                    <select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                      className="px-2.5 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 font-medium"
                    >
                      <option value="SIGNIFICANCE">Sort: High Significance First</option>
                      <option value="DOCUMENT_ORDER">Sort: Document Order</option>
                      <option value="CHANGE_TYPE">Sort: Change Type</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Differences List */}
              <div className="space-y-4">
                {filteredStandardDiffs.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-400 bg-slate-50 rounded-xl">
                    No substantive differences match the active filters.
                  </div>
                ) : (
                  filteredStandardDiffs.map((diff) => {
                    const isExpanded = expandedDiffs[diff.id] ?? false;

                    return (
                      <div
                        key={diff.id}
                        className="p-5 rounded-2xl border border-slate-200 bg-white shadow-2xs hover:shadow-xs transition-shadow space-y-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            {diff.sectionNumber && (
                              <span className="font-mono text-xs font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                                {diff.sectionNumber}
                              </span>
                            )}
                            <h3 className="font-bold text-sm text-slate-900">{diff.title}</h3>
                            {getChangeTypeBadge(diff.changeType)}
                          </div>
                          {getSigBadge(diff.significance)}
                        </div>

                        {/* Plain Language Substantive Summary */}
                        <div className="p-3 rounded-xl bg-blue-50/70 border border-blue-100 text-xs space-y-1">
                          <p className="font-semibold text-blue-900">
                            Substantive Summary:{' '}
                            <span className="font-normal text-slate-800">{diff.substantiveChange}</span>
                          </p>
                          {diff.plainLanguageImpact && (
                            <p className="font-semibold text-blue-900">
                              Legal Impact:{' '}
                              <span className="font-normal text-slate-800">{diff.plainLanguageImpact}</span>
                            </p>
                          )}
                          {diff.numericOrDateChanges && (
                            <p className="font-semibold text-emerald-800 bg-emerald-50 px-2 py-1 rounded border border-emerald-200 inline-block mt-1">
                              Numeric/Date Change: {diff.numericOrDateChanges}
                            </p>
                          )}
                        </div>

                        {/* Expandable Side-by-Side & Word Diff Toggle */}
                        <div className="flex items-center justify-between pt-1 text-xs">
                          <button
                            type="button"
                            onClick={() => toggleDiffExpand(diff.id)}
                            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 font-semibold"
                          >
                            <span>{isExpanded ? 'Hide clause text & word diff' : 'View clause text & inline word diff'}</span>
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </button>
                        </div>

                        {isExpanded && (
                          <div className="space-y-3 pt-2 border-t border-slate-100">
                            {/* Inline Word Diff Segments */}
                            {diff.diffSegments && diff.diffSegments.length > 0 && (
                              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs leading-relaxed font-serif">
                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5 font-sans">
                                  Inline Word-Level Changes
                                </span>
                                <div>
                                  {diff.diffSegments.map((seg, sIdx) => {
                                    if (seg.type === 'delete') {
                                      return (
                                        <span
                                          key={sIdx}
                                          className="bg-rose-100 text-rose-800 line-through mx-0.5 px-1 rounded"
                                        >
                                          {seg.text}
                                        </span>
                                      );
                                    }
                                    if (seg.type === 'insert') {
                                      return (
                                        <span
                                          key={sIdx}
                                          className="bg-emerald-100 text-emerald-800 font-semibold mx-0.5 px-1 rounded"
                                        >
                                          {seg.text}
                                        </span>
                                      );
                                    }
                                    return <span key={sIdx}>{seg.text}</span>;
                                  })}
                                </div>
                              </div>
                            )}

                            {/* Side-by-Side Old vs New */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                                <span className="font-bold text-[10px] text-slate-500 uppercase tracking-wider block mb-1">
                                  Base Version (Old)
                                </span>
                                <p className="text-slate-700 font-serif leading-relaxed italic">
                                  "{diff.originalText || '(Clause not present)'}"
                                </p>
                              </div>
                              <div className="p-3 rounded-xl bg-emerald-50/40 border border-emerald-200">
                                <span className="font-bold text-[10px] text-emerald-800 uppercase tracking-wider block mb-1">
                                  Revised Version (New)
                                </span>
                                <p className="text-slate-900 font-serif leading-relaxed italic font-medium">
                                  "{diff.revisedText || '(Clause removed)'}"
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}

                {/* Reworded-Only Group (Collapsed by default at the bottom) */}
                {rewordedOnlyDiffs.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div
                      onClick={() => setIsRewordedCollapsed((c) => !c)}
                      className="flex items-center justify-between cursor-pointer select-none"
                    >
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-slate-500" />
                        <h4 className="text-xs font-bold text-slate-800">
                          Reworded-Only Clauses ({rewordedOnlyDiffs.length})
                        </h4>
                        <span className="text-[10px] text-slate-500">
                          (Low substantive risk / stylistic edits)
                        </span>
                      </div>
                      {isRewordedCollapsed ? (
                        <ChevronDown className="w-4 h-4 text-slate-500" />
                      ) : (
                        <ChevronUp className="w-4 h-4 text-slate-500" />
                      )}
                    </div>

                    {!isRewordedCollapsed && (
                      <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
                        {rewordedOnlyDiffs.map((rDiff) => (
                          <div
                            key={rDiff.id}
                            className="p-3 bg-white rounded-xl border border-slate-200 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between font-semibold text-slate-800">
                              <span>{rDiff.title}</span>
                              <span className="text-[10px] text-purple-700 bg-purple-50 px-2 py-0.5 rounded font-mono">
                                Reworded
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-600">{rDiff.substantiveChange}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
