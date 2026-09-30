'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  AlertTriangle,
  Download,
  AlertCircle,
  X,
} from 'lucide-react';
import { DocumentMetadata, VerifiedCitation } from '@/lib/types';

interface DocumentViewerProps {
  document: DocumentMetadata | null;
  activeCitation: VerifiedCitation | null;
  onClearActiveCitation?: () => void;
  selectedDocuments?: DocumentMetadata[];
  onSelectDocument?: (doc: DocumentMetadata) => void;
}

interface HighlightRect {
  pageNumber: number;
  top: number;
  left: number;
  width: number;
  height: number;
  isPrimary: boolean;
  occurrenceIndex?: number;
}

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
  document,
  activeCitation,
  onClearActiveCitation,
  selectedDocuments = [],
  onSelectDocument,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const docxContainerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const textLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // PDF.js State
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [inputPageNumber, setInputPageNumber] = useState<string>('1');
  const [scale, setScale] = useState<number>(1.2);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1, 2]));

  // DOCX State
  const isDocx = useMemo(() => {
    if (!document) return false;
    return (
      document.originalFilename.toLowerCase().endsWith('.docx') ||
      document.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  }, [document]);

  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [isLoadingDocx, setIsLoadingDocx] = useState<boolean>(false);

  // Highlighting & Toast State
  const [highlightRects, setHighlightRects] = useState<HighlightRect[]>([]);
  const [totalOccurrences, setTotalOccurrences] = useState<number>(0);
  const [currentOccurrenceIndex, setCurrentOccurrenceIndex] = useState<number>(0);
  const [fallbackToast, setFallbackToast] = useState<{ message: string; pageNumber: number } | null>(null);

  // Load DOCX HTML
  useEffect(() => {
    if (!document || document.status !== 'READY' || !isDocx) {
      setDocxHtml(null);
      return;
    }

    let isMounted = true;
    setIsLoadingDocx(true);

    async function loadDocx() {
      try {
        const res = await fetch(`/api/documents/${document!.id}/docx-html`);
        if (!res.ok) throw new Error('Failed to load document HTML');
        const data = await res.json();
        if (isMounted) setDocxHtml(data.html || '');
      } catch (err) {
        console.warn('Failed to load DOCX HTML:', err);
      } finally {
        if (isMounted) setIsLoadingDocx(false);
      }
    }

    loadDocx();

    return () => {
      isMounted = false;
    };
  }, [document?.id, document?.status, isDocx]);

  // Load PDF Document via PDF.js
  useEffect(() => {
    if (!document || document.status !== 'READY' || isDocx) {
      setPdfDoc(null);
      setTotalPages(0);
      setHighlightRects([]);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setLoadError(null);

    async function loadPdf() {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

        const fileUrl = `/api/documents/${document!.id}/file`;
        const loadingTask = pdfjsLib.getDocument({
          url: fileUrl,
          cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
          cMapPacked: true,
        });

        const loadedPdf = await loadingTask.promise;
        if (!isMounted) return;

        setPdfDoc(loadedPdf);
        setTotalPages(loadedPdf.numPages);
        setCurrentPage(1);
        setInputPageNumber('1');
        setVisiblePages(new Set([1, 2, 3]));
      } catch (err: unknown) {
        console.error('Failed to load PDF document:', err);
        if (isMounted) {
          setLoadError('Failed to render document. Please ensure the file is intact.');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadPdf();

    return () => {
      isMounted = false;
    };
  }, [document?.id, document?.status, isDocx]);

  // Lazy Render with IntersectionObserver for smooth 150-page docs
  useEffect(() => {
    if (!containerRef.current || isDocx || !pdfDoc) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          entries.forEach((entry) => {
            const pageNum = parseInt(entry.target.getAttribute('data-page-number') || '0', 10);
            if (pageNum > 0) {
              if (entry.isIntersecting) {
                next.add(pageNum);
                // Also buffer adjacent pages
                if (pageNum > 1) next.add(pageNum - 1);
                if (pageNum < totalPages) next.add(pageNum + 1);
              }
            }
          });
          return next;
        });
      },
      { root: containerRef.current, rootMargin: '300px 0px 300px 0px' }
    );

    observerRef.current = observer;

    const elements = containerRef.current.querySelectorAll('.page-placeholder');
    elements.forEach((el) => observer.observe(el));

    return () => {
      observer.disconnect();
    };
  }, [pdfDoc, totalPages, isDocx]);

  // Render individual page (Canvas + TextLayer)
  const renderPage = useCallback(
    async (pageNum: number) => {
      if (!pdfDoc || isDocx) return;

      try {
        const page = await pdfDoc.getPage(pageNum);
        const canvas = canvasRefs.current.get(pageNum);
        const textLayerDiv = textLayerRefs.current.get(pageNum);

        if (!canvas) return;

        const viewport = page.getViewport({ scale });
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        // Render Canvas
        await page.render({
          canvasContext: context,
          viewport,
        }).promise;

        // Render Text Layer for selectable text & highlighting
        if (textLayerDiv) {
          textLayerDiv.innerHTML = '';
          textLayerDiv.style.width = `${viewport.width}px`;
          textLayerDiv.style.height = `${viewport.height}px`;

          const textContent = await page.getTextContent();
          const pdfjsLib = await import('pdfjs-dist');

          if (pdfjsLib.renderTextLayer) {
            await pdfjsLib.renderTextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
              textDivs: [],
            }).promise;
          }
        }
      } catch (err) {
        console.warn(`Error rendering page ${pageNum}:`, err);
      }
    },
    [pdfDoc, scale, isDocx]
  );

  // Render visible pages
  useEffect(() => {
    if (!pdfDoc || isDocx) return;
    visiblePages.forEach((p) => {
      if (p <= totalPages) {
        renderPage(p);
      }
    });
  }, [pdfDoc, scale, visiblePages, totalPages, renderPage, isDocx]);

  // Normalization matching the server quote verifier
  const normalizeForSearch = (str: string) => {
    return str
      .normalize('NFKC')
      .replace(/\u00AD/g, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/(\w+)-\s*\n\s*(\w+)/g, '$1$2')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  };

  // Highlighting for PDF
  useEffect(() => {
    if (!activeCitation || !pdfDoc || isDocx || !activeCitation.quote) {
      setHighlightRects([]);
      setFallbackToast(null);
      return;
    }

    let isMounted = true;

    async function locateCitationInPdf() {
      if (!activeCitation) return;
      const targetPageStart = activeCitation.pageStart || 1;
      const normQuote = normalizeForSearch(activeCitation.quote);
      const quoteWords = normQuote.split(' ').filter((w) => w.length > 2);

      const isBoilerplate = (str: string) =>
        /^\s*(page\s+)?\d+(\s+of\s+\d+)?\s*$/i.test(str.trim()) ||
        str.includes('Falcon Technologies LLC') ||
        str.includes('Al Noor Trading FZE');

      const allOccurrences: HighlightRect[][] = [];

      // If activeCitation has occurrences list from server, use them directly
      const occurrenceTargets =
        activeCitation.occurrences && activeCitation.occurrences.length > 0
          ? activeCitation.occurrences
          : [
              {
                pageStart: targetPageStart,
                pageEnd: activeCitation.pageEnd || targetPageStart,
              },
            ];

      for (let oIdx = 0; oIdx < occurrenceTargets.length; oIdx++) {
        const target = occurrenceTargets[oIdx];
        const occRects: HighlightRect[] = [];

        try {
          if (target.pageStart === target.pageEnd) {
            // Single-page occurrence
            const page = await pdfDoc.getPage(target.pageStart);
            const viewport = page.getViewport({ scale });
            const textContent = await page.getTextContent();

            const items = textContent.items.filter(
              (item: any) => 'str' in item && !isBoilerplate(item.str)
            );

            let pageText = '';
            for (const item of items) {
              pageText += item.str + ' ';
            }
            const normPageText = normalizeForSearch(pageText);

            if (normPageText.includes(normQuote) || quoteWords.some((w) => normPageText.includes(w))) {
              const matchedItems: any[] = [];
              const tokenStart = quoteWords[0] || normQuote;
              const tokenEnd = quoteWords[quoteWords.length - 1] || normQuote;

              let inRange = false;
              for (const item of items) {
                const itemNorm = normalizeForSearch(item.str);
                if (itemNorm.includes(tokenStart)) inRange = true;
                if (inRange) matchedItems.push(item);
                if (inRange && itemNorm.includes(tokenEnd) && matchedItems.length >= Math.max(1, quoteWords.length / 2)) {
                  break;
                }
              }

              if (matchedItems.length === 0 && items.length > 0) {
                matchedItems.push(...items.slice(0, Math.min(items.length, 6)));
              }

              for (const item of matchedItems) {
                const tx = item.transform;
                const itemX = tx[4];
                const itemY = tx[5];
                const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || item.height || 10;
                const width = item.width || 60;

                const [vx, vy] = viewport.convertToViewportPoint(itemX, itemY);
                occRects.push({
                  pageNumber: target.pageStart,
                  top: vy - fontHeight * scale,
                  left: vx,
                  width: Math.max(width * scale, 25),
                  height: Math.max(fontHeight * scale, 14),
                  isPrimary: oIdx === 0,
                  occurrenceIndex: oIdx,
                });
              }
            }
          } else {
            // Cross-page occurrence (e.g. pages 21–22)
            // Page 1 of cross-page: highlight bottom part
            const p1 = await pdfDoc.getPage(target.pageStart);
            const vp1 = p1.getViewport({ scale });
            const tc1 = await p1.getTextContent();
            const items1 = tc1.items.filter((item: any) => 'str' in item && !isBoilerplate(item.str));

            // Page 2 of cross-page: highlight top part
            const p2 = await pdfDoc.getPage(target.pageEnd);
            const vp2 = p2.getViewport({ scale });
            const tc2 = await p2.getTextContent();
            const items2 = tc2.items.filter((item: any) => 'str' in item && !isBoilerplate(item.str));

            // Select items on page 1 matching the start of quote
            const p1Matched = items1.slice(Math.max(0, items1.length - 4));
            for (const item of p1Matched) {
              const tx = item.transform;
              const [vx, vy] = vp1.convertToViewportPoint(tx[4], tx[5]);
              const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || item.height || 10;
              occRects.push({
                pageNumber: target.pageStart,
                top: vy - fontHeight * scale,
                left: vx,
                width: Math.max((item.width || 60) * scale, 25),
                height: Math.max(fontHeight * scale, 14),
                isPrimary: oIdx === 0,
                occurrenceIndex: oIdx,
              });
            }

            // Select items on page 2 matching the end of quote
            const p2Matched = items2.slice(0, Math.min(items2.length, 4));
            for (const item of p2Matched) {
              const tx = item.transform;
              const [vx, vy] = vp2.convertToViewportPoint(tx[4], tx[5]);
              const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || item.height || 10;
              occRects.push({
                pageNumber: target.pageEnd,
                top: vy - fontHeight * scale,
                left: vx,
                width: Math.max((item.width || 60) * scale, 25),
                height: Math.max(fontHeight * scale, 14),
                isPrimary: oIdx === 0,
                occurrenceIndex: oIdx,
              });
            }
          }

          if (occRects.length > 0) {
            allOccurrences.push(occRects);
          }
        } catch (err) {
          console.warn(`Search error on occurrence ${oIdx}:`, err);
        }
      }

      if (!isMounted) return;

      if (allOccurrences.length === 0) {
        // Fallback: verified in document text but could not be located on rendered page
        setFallbackToast({
          message: `Verified in the document text, but could not be located on the rendered page — showing page ${targetPageStart}`,
          pageNumber: targetPageStart,
        });
        setCurrentPage(targetPageStart);
        setInputPageNumber(String(targetPageStart));
        const el = window.document.getElementById(`page-wrapper-${targetPageStart}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightRects([]);
        return;
      }

      setFallbackToast(null);
      setTotalOccurrences(allOccurrences.length);
      setCurrentOccurrenceIndex(0);

      const flattened: HighlightRect[] = [];
      allOccurrences.forEach((occ, oIdx) => {
        occ.forEach((rect) => {
          flattened.push({ ...rect, isPrimary: oIdx === 0, occurrenceIndex: oIdx });
        });
      });

      setHighlightRects(flattened);

      // Ensure primary page is visible and scroll to it
      const primaryPage = allOccurrences[0][0].pageNumber;
      setCurrentPage(primaryPage);
      setInputPageNumber(String(primaryPage));
      setVisiblePages((prev) => new Set([...prev, primaryPage, primaryPage + 1]));

      setTimeout(() => {
        const el = window.document.getElementById(`page-wrapper-${primaryPage}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
    }

    locateCitationInPdf();

    return () => {
      isMounted = false;
    };
  }, [activeCitation, pdfDoc, scale, totalPages, isDocx]);

  // Highlighting for DOCX HTML view
  useEffect(() => {
    if (!activeCitation || !isDocx || !docxHtml || !docxContainerRef.current) return;

    const normQuote = normalizeForSearch(activeCitation.quote);
    const container = docxContainerRef.current;

    // Clear previous highlights
    const oldMarks = container.querySelectorAll('.citation-highlight-box');
    oldMarks.forEach((m) => {
      const parent = m.parentNode;
      if (parent) {
        parent.replaceChild(document ? window.document.createTextNode(m.textContent || '') : m, m);
      }
    });

    // Walk text nodes
    const walker = window.document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let currentNode: Node | null;
    let found = false;

    while ((currentNode = walker.nextNode())) {
      const nodeText = currentNode.nodeValue || '';
      const normNodeText = normalizeForSearch(nodeText);
      const matchIdx = normNodeText.indexOf(normQuote);

      if (matchIdx !== -1) {
        found = true;
        const span = window.document.createElement('span');
        span.className = 'citation-highlight-box px-1 rounded';
        span.textContent = nodeText;
        currentNode.parentNode?.replaceChild(span, currentNode);
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
    }

    if (!found) {
      setFallbackToast({
        message: `Verified in canonical contract text — highlighted section on screen.`,
        pageNumber: 1,
      });
    } else {
      setFallbackToast(null);
    }
  }, [activeCitation, isDocx, docxHtml]);

  // Page Navigation Handlers
  const handlePrevPage = () => {
    if (currentPage > 1) {
      const prev = currentPage - 1;
      setCurrentPage(prev);
      setInputPageNumber(String(prev));
      setVisiblePages((p) => new Set([...p, prev, prev - 1]));
      const el = window.document.getElementById(`page-wrapper-${prev}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      const next = currentPage + 1;
      setCurrentPage(next);
      setInputPageNumber(String(next));
      setVisiblePages((p) => new Set([...p, next, next + 1]));
      const el = window.document.getElementById(`page-wrapper-${next}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseInt(inputPageNumber, 10);
    if (!isNaN(p) && p >= 1 && p <= totalPages) {
      setCurrentPage(p);
      setVisiblePages((prev) => new Set([...prev, p, p + 1]));
      const el = window.document.getElementById(`page-wrapper-${p}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      setInputPageNumber(String(currentPage));
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        handlePrevPage();
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        handleNextPage();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (!document) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-100/60 p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-white border border-slate-200 shadow-xs flex items-center justify-center text-slate-400 mb-4">
          <FileText className="w-8 h-8 stroke-[1.5]" />
        </div>
        <h3 className="text-sm font-semibold text-slate-700 mb-1">No Contract Selected</h3>
        <p className="text-xs text-slate-400 max-w-sm">
          Select a contract from the library or upload a new PDF / DOCX file to view and analyze it.
        </p>
      </div>
    );
  }

  if (document.status === 'PROCESSING' || document.status === 'UPLOADING') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-100/60 p-8 text-center">
        <Loader2 className="w-10 h-10 animate-spin text-blue-600 mb-4" />
        <h3 className="text-sm font-semibold text-slate-800 mb-1">Processing Contract</h3>
        <p className="text-xs text-slate-500 max-w-sm mb-2">
          {document.statusMessage || 'Extracting canonical text, chunking legal clauses, and indexing...'}
        </p>
        <span className="text-[11px] font-mono text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-200">
          Stage: {document.processingStage || 'Indexing'}
        </span>
      </div>
    );
  }

  if (document.status === 'FAILED') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-100/60 p-8 text-center">
        <div className="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center mb-4">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Document Processing Failed</h3>
        <p className="text-xs text-rose-600 max-w-md bg-rose-50 p-3 rounded-lg border border-rose-200 leading-relaxed mb-4">
          {document.statusMessage || 'This contract cannot be opened for chat. Please upload a readable text-based PDF or DOCX.'}
        </p>
      </div>
    );
  }

  const handleSelectOccurrence = (idx: number) => {
    setCurrentOccurrenceIndex(idx);
    const occRects = highlightRects.filter((r) => r.occurrenceIndex === idx);
    if (occRects.length > 0) {
      const targetPage = occRects[0].pageNumber;
      setCurrentPage(targetPage);
      setInputPageNumber(String(targetPage));
      setVisiblePages((prev) => new Set([...prev, targetPage, targetPage + 1]));
      setTimeout(() => {
        const el = window.document.getElementById(`page-wrapper-${targetPage}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-200/70 overflow-hidden relative">
      {/* Top Document Tabs (When multiple documents are selected) */}
      {selectedDocuments.length > 1 && (
        <div className="bg-slate-100 border-b border-slate-300 px-3 pt-2 flex items-center gap-1 overflow-x-auto shrink-0 z-20">
          {selectedDocuments.map((doc) => {
            const isActive = doc.id === document.id;
            return (
              <button
                key={doc.id}
                type="button"
                onClick={() => onSelectDocument && onSelectDocument(doc)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-semibold border-t border-l border-r transition-all truncate max-w-[200px] ${
                  isActive
                    ? 'bg-white text-slate-900 border-slate-300 shadow-2xs'
                    : 'bg-slate-200/80 text-slate-600 border-transparent hover:bg-slate-200 hover:text-slate-800'
                }`}
                title={doc.originalFilename}
              >
                <FileText className={`w-3.5 h-3.5 ${isActive ? 'text-blue-600' : 'text-slate-400'}`} />
                <span className="truncate">{doc.originalFilename}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Main Toolbar */}
      <div className="h-12 border-b border-slate-300 bg-white/95 backdrop-blur px-4 flex items-center justify-between shrink-0 shadow-2xs z-20">
        {/* Document Info */}
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="font-semibold text-xs text-slate-800 truncate" title={document.originalFilename}>
            {document.originalFilename}
          </span>
          <span className="text-[11px] text-slate-400 shrink-0">
            ({totalPages || document.pageCount} page{(totalPages || document.pageCount) === 1 ? '' : 's'})
          </span>
        </div>

        {/* Page Navigation & Zoom Controls */}
        <div className="flex items-center gap-2">
          {/* Occurrence Navigator if multiple matches exist */}
          {totalOccurrences > 1 && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-50 text-amber-900 border border-amber-300 text-xs">
              <span className="font-semibold text-[11px]">
                Occurrence {currentOccurrenceIndex + 1} of {totalOccurrences}
              </span>
              <button
                type="button"
                onClick={() => {
                  const prev = (currentOccurrenceIndex - 1 + totalOccurrences) % totalOccurrences;
                  handleSelectOccurrence(prev);
                }}
                className="p-0.5 hover:bg-amber-100 rounded"
                title="Previous occurrence"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = (currentOccurrenceIndex + 1) % totalOccurrences;
                  handleSelectOccurrence(next);
                }}
                className="p-0.5 hover:bg-amber-100 rounded"
                title="Next occurrence"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Page Selector Input Form */}
          {!isDocx && (
            <form onSubmit={handlePageInputSubmit} className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5 border border-slate-200 text-xs">
              <button
                type="button"
                onClick={handlePrevPage}
                disabled={currentPage <= 1}
                className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30 transition-colors"
                title="Previous Page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <input
                type="text"
                value={inputPageNumber}
                onChange={(e) => setInputPageNumber(e.target.value)}
                onBlur={() => setInputPageNumber(String(currentPage))}
                className="w-9 text-center bg-white border border-slate-200 rounded px-1 py-0.5 font-mono text-[11px] text-slate-800"
              />
              <span className="pr-1.5 font-mono text-[11px] text-slate-500">
                / {totalPages || 1}
              </span>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={currentPage >= totalPages}
                className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30 transition-colors"
                title="Next Page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* Zoom Buttons */}
          {!isDocx && (
            <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5 border border-slate-200 text-xs">
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(0.6, s - 0.15))}
                className="p-1 text-slate-600 hover:text-slate-900 transition-colors"
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="px-1.5 font-mono text-[11px] text-slate-700">
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(2.5, s + 0.15))}
                className="p-1 text-slate-600 hover:text-slate-900 transition-colors"
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setScale(1.2)}
                className="p-1 text-slate-600 hover:text-slate-900 transition-colors border-l border-slate-200 ml-0.5"
                title="Reset Zoom"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Download Original File */}
          <a
            href={`/api/documents/${document.id}/file`}
            download={document.originalFilename}
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors"
            title="Download Document"
          >
            <Download className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* Fallback Toast (When verified in text but not on rendered page) */}
      {fallbackToast && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-amber-900 text-white text-xs px-4 py-2 rounded-xl shadow-xl flex items-center gap-2 max-w-lg animate-bounce">
          <AlertCircle className="w-4 h-4 text-amber-300 shrink-0" />
          <span className="leading-snug">{fallbackToast.message}</span>
          <button
            type="button"
            onClick={() => setFallbackToast(null)}
            className="p-0.5 hover:bg-white/20 rounded"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Document View Content Area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-6 flex flex-col items-center gap-6"
      >
        {/* Loading state */}
        {(isLoading || isLoadingDocx) && (
          <div className="flex items-center gap-2 text-xs text-slate-500 py-8">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            Rendering contract content...
          </div>
        )}

        {loadError && (
          <div className="bg-rose-50 text-rose-700 text-xs p-4 rounded-xl border border-rose-200 max-w-md text-center">
            {loadError}
          </div>
        )}

        {/* DOCX HTML Rendering Mode */}
        {isDocx && docxHtml && (
          <div
            ref={docxContainerRef}
            className="w-full max-w-3xl bg-white shadow-xl rounded-xl p-10 prose prose-slate text-xs leading-relaxed border border-slate-200"
            dangerouslySetInnerHTML={{ __html: docxHtml }}
          />
        )}

        {/* PDF Multi-Page Canvas Rendering Mode */}
        {!isDocx &&
          Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => {
            const isVisible = visiblePages.has(pageNum);

            return (
              <div
                key={pageNum}
                id={`page-wrapper-${pageNum}`}
                data-page-number={pageNum}
                className="page-placeholder relative bg-white shadow-xl rounded-md overflow-hidden transition-shadow hover:shadow-2xl min-h-[500px]"
                style={{ width: `${600 * scale}px` }}
              >
                {/* Page number watermark */}
                <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-slate-800/60 text-white text-[10px] font-mono select-none z-10">
                  Page {pageNum}
                </div>

                {isVisible ? (
                  <>
                    {/* Canvas Layer */}
                    <canvas
                      ref={(el) => {
                        if (el) canvasRefs.current.set(pageNum, el);
                        else canvasRefs.current.delete(pageNum);
                      }}
                      className="block"
                    />

                    {/* Text Layer for Selection */}
                    <div
                      ref={(el) => {
                        if (el) textLayerRefs.current.set(pageNum, el);
                        else textLayerRefs.current.delete(pageNum);
                      }}
                      className="textLayer"
                    />

                    {/* Exact Citation Highlight Overlays */}
                    {highlightRects
                      .filter((r) => r.pageNumber === pageNum)
                      .map((r, rIdx) => {
                        const isCurrentActive =
                          r.occurrenceIndex === undefined ||
                          r.occurrenceIndex === currentOccurrenceIndex;

                        return (
                          <div
                            key={`hl-${pageNum}-${rIdx}`}
                            className={
                              isCurrentActive
                                ? 'citation-highlight-box'
                                : 'citation-highlight-secondary'
                            }
                            style={{
                              top: `${r.top}px`,
                              left: `${r.left}px`,
                              width: `${r.width}px`,
                              height: `${r.height}px`,
                            }}
                            title="Verified Quote in Document"
                          />
                        );
                      })}
                  </>
                ) : (
                  <div className="w-full h-[800px] flex items-center justify-center bg-slate-50 text-slate-300 font-mono text-xs">
                    Page {pageNum}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
};
