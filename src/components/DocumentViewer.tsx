'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
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
} from 'lucide-react';
import { DocumentMetadata, VerifiedCitation } from '@/lib/types';

interface DocumentViewerProps {
  document: DocumentMetadata | null;
  activeCitation: VerifiedCitation | null;
  onClearActiveCitation?: () => void;
}

interface HighlightRect {
  pageNumber: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
  document,
  activeCitation,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const textLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.2);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightRects, setHighlightRects] = useState<HighlightRect[]>([]);

  // Load PDF Document via PDF.js
  useEffect(() => {
    if (!document || document.status !== 'READY') {
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
        // Set worker source
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
  }, [document?.id, document?.status]);

  // Render individual page (Canvas + TextLayer)
  const renderPage = useCallback(
    async (pageNum: number) => {
      if (!pdfDoc) return;

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
    [pdfDoc, scale]
  );

  // Re-render visible pages when scale or pdfDoc changes
  useEffect(() => {
    if (!pdfDoc) return;
    // Render current and adjacent pages for smooth navigation
    const start = Math.max(1, currentPage - 1);
    const end = Math.min(totalPages, currentPage + 2);
    for (let p = start; p <= end; p++) {
      renderPage(p);
    }
  }, [pdfDoc, scale, currentPage, totalPages, renderPage]);

  // Citation Highlighting: Matches passage and computes multi-line bounding rectangles
  useEffect(() => {
    if (!activeCitation || !pdfDoc || !activeCitation.quote) {
      setHighlightRects([]);
      return;
    }

    let isMounted = true;

    async function computeCitationHighlights() {
      if (!activeCitation) return;
      const targetPageStart = activeCitation.pageStart || 1;
      const targetPageEnd = activeCitation.pageEnd || targetPageStart;

      // Navigate to citation start page
      setCurrentPage(targetPageStart);

      const rects: HighlightRect[] = [];
      const cleanQuote = activeCitation.quote.trim().toLowerCase().replace(/\s+/g, ' ');

      for (let pNum = targetPageStart; pNum <= targetPageEnd; pNum++) {
        if (pNum > totalPages) break;
        try {
          const page = await pdfDoc.getPage(pNum);
          const viewport = page.getViewport({ scale });
          const textContent = await page.getTextContent();

          // Gather text items with viewport coordinates
          const items = textContent.items.filter((item: any) => 'str' in item);
          let pageAccumulatedText = '';
          const itemCharRanges: Array<{ item: any; start: number; end: number }> = [];

          for (const item of items) {
            const str = item.str;
            const start = pageAccumulatedText.length;
            pageAccumulatedText += str + ' ';
            const end = pageAccumulatedText.length;
            itemCharRanges.push({ item, start, end });
          }

          const pageTextNorm = pageAccumulatedText.toLowerCase().replace(/\s+/g, ' ');

          // Find occurrence matching the quote
          // Find tokens of the quote to match multiple lines
          const quoteWords = cleanQuote.split(' ').filter((w: string) => w.length > 2);
          const firstWord = quoteWords[0] || cleanQuote;
          const lastWord = quoteWords[quoteWords.length - 1] || cleanQuote;

          let matchStartIndex = pageTextNorm.indexOf(firstWord);
          if (matchStartIndex === -1 && quoteWords.length > 1) {
            // Try matching with second word
            matchStartIndex = pageTextNorm.indexOf(quoteWords[1]);
          }

          if (matchStartIndex !== -1) {
            // Collect all items between first word and last word
            const matchingItems: any[] = [];
            for (const { item, start, end } of itemCharRanges) {
              if (end >= matchStartIndex) {
                matchingItems.push(item);
                const itemNorm = item.str.toLowerCase();
                if (itemNorm.includes(lastWord) && matchingItems.length >= quoteWords.length / 2) {
                  break;
                }
              }
            }

            // Group matching items into line bounding boxes
            for (const item of matchingItems) {
              const tx = item.transform; // [scaleX, skewY, skewX, scaleY, x, y]
              const itemX = tx[4];
              const itemY = tx[5];
              const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || item.height || 10;
              const width = item.width || 50;

              // Convert PDF point coordinates to viewport pixel coordinates
              const [vx, vy] = viewport.convertToViewportPoint(itemX, itemY);
              const vWidth = width * scale;
              const vHeight = fontHeight * scale;

              rects.push({
                pageNumber: pNum,
                top: vy - vHeight,
                left: vx,
                width: Math.max(vWidth, 20),
                height: Math.max(vHeight, 14),
              });
            }
          }
        } catch (err) {
          console.warn('Highlight calculation failed on page:', pNum, err);
        }
      }

      if (isMounted) {
        setHighlightRects(rects);

        // Smooth scroll to highlighted element
        setTimeout(() => {
          const el = typeof window !== 'undefined' ? window.document.getElementById(`page-wrapper-${targetPageStart}`) : null;
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 150);
      }
    }

    computeCitationHighlights();

    return () => {
      isMounted = false;
    };
  }, [activeCitation, pdfDoc, scale, totalPages]);

  // Page Navigation Handlers
  const handlePrevPage = () => {
    if (currentPage > 1) {
      const prev = currentPage - 1;
      setCurrentPage(prev);
      const el = window.document.getElementById(`page-wrapper-${prev}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      const next = currentPage + 1;
      setCurrentPage(next);
      const el = window.document.getElementById(`page-wrapper-${next}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (!document) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-100/60 p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center text-slate-400 mb-4">
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
          {document.statusMessage || 'Extracting canonical text, chunking legal clauses, and generating embeddings...'}
        </p>
        <span className="text-[11px] font-mono text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-200">
          Status: {document.status}
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
          {document.statusMessage || 'This PDF appears to be scanned or contains no readable text. Please upload a text-based PDF or DOCX.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-200/70 overflow-hidden relative">
      {/* Top Toolbar */}
      <div className="h-12 border-b border-slate-300 bg-white/95 backdrop-blur px-4 flex items-center justify-between shrink-0 shadow-xs z-20">
        {/* Document Info */}
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-blue-600 shrink-0" />
          <span className="font-semibold text-xs text-slate-800 truncate" title={document.originalFilename}>
            {document.originalFilename}
          </span>
          <span className="text-[11px] text-slate-400 shrink-0">
            ({totalPages} page{totalPages === 1 ? '' : 's'})
          </span>
        </div>

        {/* Page Navigation & Zoom Controls */}
        <div className="flex items-center gap-2">
          {/* Page Selector */}
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5 border border-slate-200 text-xs">
            <button
              onClick={handlePrevPage}
              disabled={currentPage <= 1}
              className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30 disabled:hover:text-slate-600 transition-colors"
              title="Previous Page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-2 font-mono text-[11px] text-slate-700">
              {currentPage} / {totalPages || 1}
            </span>
            <button
              onClick={handleNextPage}
              disabled={currentPage >= totalPages}
              className="p-1 text-slate-600 hover:text-slate-900 disabled:opacity-30 disabled:hover:text-slate-600 transition-colors"
              title="Next Page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Zoom Buttons */}
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5 border border-slate-200 text-xs">
            <button
              onClick={() => setScale((s) => Math.max(0.7, s - 0.15))}
              className="p-1 text-slate-600 hover:text-slate-900 transition-colors"
              title="Zoom Out"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="px-1.5 font-mono text-[11px] text-slate-700">
              {Math.round(scale * 100)}%
            </span>
            <button
              onClick={() => setScale((s) => Math.min(2.5, s + 0.15))}
              className="p-1 text-slate-600 hover:text-slate-900 transition-colors"
              title="Zoom In"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={() => setScale(1.2)}
              className="p-1 text-slate-600 hover:text-slate-900 transition-colors border-l border-slate-200 ml-0.5"
              title="Reset Zoom"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

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

      {/* Main Document Canvas Scroll Area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-6 flex flex-col items-center gap-6"
      >
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-slate-500 py-8">
            <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
            Rendering PDF document...
          </div>
        )}

        {loadError && (
          <div className="bg-rose-50 text-rose-700 text-xs p-4 rounded-xl border border-rose-200 max-w-md text-center">
            {loadError}
          </div>
        )}

        {/* Rendered Pages */}
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
          <div
            key={pageNum}
            id={`page-wrapper-${pageNum}`}
            className="relative bg-white shadow-xl rounded-md overflow-hidden transition-shadow hover:shadow-2xl"
          >
            {/* Page number watermark on the side */}
            <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-slate-800/60 text-white text-[10px] font-mono select-none z-10">
              Page {pageNum}
            </div>

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
              .map((r, rIdx) => (
                <div
                  key={`hl-${pageNum}-${rIdx}`}
                  className="citation-highlight-box"
                  style={{
                    top: `${r.top}px`,
                    left: `${r.left}px`,
                    width: `${r.width}px`,
                    height: `${r.height}px`,
                  }}
                  title="Verified Quote in Document"
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
};
