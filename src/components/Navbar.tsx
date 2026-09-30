'use client';

import React from 'react';
import { Scale, FileDiff, Sparkles, Upload, FileText, CheckCircle2, PanelLeft, PanelRight } from 'lucide-react';

interface NavbarProps {
  onOpenUpload: () => void;
  onOpenCompare: () => void;
  selectedCount: number;
  useAgent: boolean;
  onToggleAgent: (val: boolean) => void;
  isLibraryOpen?: boolean;
  onToggleLibrary?: () => void;
  isChatOpen?: boolean;
  onToggleChat?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  onOpenUpload,
  onOpenCompare,
  selectedCount,
  useAgent,
  onToggleAgent,
  isLibraryOpen = true,
  onToggleLibrary,
  isChatOpen = true,
  onToggleChat,
}) => {
  return (
    <header className="h-16 border-b border-slate-200 bg-white px-5 flex items-center justify-between shrink-0 z-30 shadow-sm">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-700 via-indigo-600 to-sky-500 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
          <Scale className="w-5 h-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-bold text-slate-900 text-lg leading-tight tracking-tight">
              Contract<span className="text-blue-600">Analyzer</span>
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide bg-blue-50 text-blue-700 border border-blue-200/60 uppercase">
              Production Verified
            </span>
          </div>
          <p className="text-xs text-slate-500">Autonomous Legal RAG & Verified Grounding</p>
        </div>
      </div>

      {/* Middle Controls: Mode & Multi-selection Status */}
      <div className="hidden md:flex items-center gap-4">
        {/* Agentic Research Toggle (Part C) */}
        <button
          type="button"
          onClick={() => onToggleAgent(!useAgent)}
          aria-label={useAgent ? "Disable Agentic Research mode" : "Enable Agentic Research mode"}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            useAgent
              ? 'bg-amber-500 text-white shadow-sm shadow-amber-500/30'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
          title="Part C: Agentic Document Research allows the AI to autonomously invoke search_document, get_section, and list_clauses before answering"
        >
          <Sparkles className={`w-3.5 h-3.5 ${useAgent ? 'animate-spin' : ''}`} />
          <span>Part C: Agentic Research</span>
          <span
            className={`px-1.5 py-0.2 rounded text-[10px] uppercase font-bold ${
              useAgent ? 'bg-amber-600 text-white' : 'bg-slate-200 text-slate-600'
            }`}
          >
            {useAgent ? 'Active' : 'Off'}
          </span>
        </button>

        {/* Multi-selection summary */}
        {selectedCount > 1 && (
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 border border-blue-200 text-xs text-blue-700 font-medium">
            <FileText className="w-3.5 h-3.5 text-blue-600" />
            <span>{selectedCount} contracts selected for cross-analysis</span>
          </div>
        )}
      </div>

      {/* Right Action Buttons & Panel Toggles */}
      <div className="flex items-center gap-2.5">
        {/* Panel Toggles for Desktop */}
        <div className="hidden lg:flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
          {onToggleLibrary && (
            <button
              type="button"
              onClick={onToggleLibrary}
              aria-label={isLibraryOpen ? "Hide contract library" : "Show contract library"}
              className={`p-1.5 rounded-md text-xs transition-all flex items-center gap-1.5 ${
                isLibraryOpen
                  ? 'bg-white text-blue-600 shadow-2xs font-semibold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title={isLibraryOpen ? "Hide Left Panel (Library)" : "Show Left Panel (Library)"}
            >
              <PanelLeft className="w-3.5 h-3.5" />
              <span className="text-[11px] hidden xl:inline">Library</span>
            </button>
          )}

          {onToggleChat && (
            <button
              type="button"
              onClick={onToggleChat}
              aria-label={isChatOpen ? "Hide AI assistant" : "Show AI assistant"}
              className={`p-1.5 rounded-md text-xs transition-all flex items-center gap-1.5 ${
                isChatOpen
                  ? 'bg-white text-blue-600 shadow-2xs font-semibold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title={isChatOpen ? "Hide Right Panel (Assistant)" : "Show Right Panel (Assistant)"}
            >
              <PanelRight className="w-3.5 h-3.5" />
              <span className="text-[11px] hidden xl:inline">Assistant</span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenCompare}
          aria-label="Open Contract Version Comparison Dialog"
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition-colors"
        >
          <FileDiff className="w-4 h-4 text-slate-600" />
          <span>Compare Versions</span>
        </button>

        <button
          type="button"
          onClick={onOpenUpload}
          aria-label="Upload New Legal Contract Document"
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-600/30 transition-all hover:shadow-md"
        >
          <Upload className="w-4 h-4" />
          <span>Upload Contract</span>
        </button>
      </div>
    </header>
  );
};
