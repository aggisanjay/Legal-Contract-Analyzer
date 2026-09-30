import mammoth from 'mammoth';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ExtractedDocument, ExtractedPage } from '../types';
import { detectSections } from './pdf-extractor';

const execAsync = promisify(exec);

/**
 * Extracts canonical text from a DOCX buffer and converts it to a rendered PDF.
 */
export async function extractDocxTextAndRenderPdf(
  docxBuffer: Buffer,
  documentId: string,
  storageRenderedDir: string
): Promise<ExtractedDocument & { renderedPdfPath: string; isScannedOrEmpty: boolean }> {
  // Extract raw text with paragraph preservation
  const { value: rawText } = await mammoth.extractRawText({ buffer: docxBuffer });
  const trimmed = rawText.trim();

  const isScannedOrEmpty = trimmed.replace(/\s+/g, '').length < 15;

  // Split into rough page estimates (~3000 chars per page if single docx)
  const pageSizeChars = 2500;
  const pages: ExtractedPage[] = [];
  const lines = trimmed.split('\n');

  let currentPageNumber = 1;
  let currentAccumulated = '';
  let overallOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (currentAccumulated.length + line.length > pageSizeChars && currentAccumulated.length > 500) {
      const pageStart = overallOffset;
      const pageEnd = overallOffset + currentAccumulated.length;
      pages.push({
        pageNumber: currentPageNumber++,
        text: currentAccumulated.trim(),
        startOffset: pageStart,
        endOffset: pageEnd,
      });
      overallOffset = pageEnd + 2; // account for \n\n
      currentAccumulated = line + '\n';
    } else {
      currentAccumulated += line + '\n';
    }
  }

  if (currentAccumulated.trim().length > 0) {
    const pageStart = overallOffset;
    const pageEnd = overallOffset + currentAccumulated.length;
    pages.push({
      pageNumber: currentPageNumber,
      text: currentAccumulated.trim(),
      startOffset: pageStart,
      endOffset: pageEnd,
    });
  }

  if (pages.length === 0) {
    pages.push({
      pageNumber: 1,
      text: trimmed,
      startOffset: 0,
      endOffset: trimmed.length,
    });
  }

  // Ensure rendered storage directory exists
  await fs.mkdir(storageRenderedDir, { recursive: true });
  const renderedPdfFilename = `${documentId}.pdf`;
  const renderedPdfPath = path.join(storageRenderedDir, renderedPdfFilename);

  // Render to PDF: Check if LibreOffice is available, else render clean PDF with pdf-lib
  let renderedWithLibreOffice = false;
  try {
    const tempDocxPath = path.join(storageRenderedDir, `${documentId}_temp.docx`);
    await fs.writeFile(tempDocxPath, docxBuffer);
    await execAsync(`soffice --headless --convert-to pdf "${tempDocxPath}" --outdir "${storageRenderedDir}"`, { timeout: 10000 });
    const convertedPath = path.join(storageRenderedDir, `${documentId}_temp.pdf`);
    await fs.rename(convertedPath, renderedPdfPath);
    await fs.unlink(tempDocxPath).catch(() => {});
    renderedWithLibreOffice = true;
  } catch {
    renderedWithLibreOffice = false;
  }

  if (!renderedWithLibreOffice) {
    // Generate high fidelity PDF using pdf-lib with text layers
    await renderTextToPdf(pages, renderedPdfPath);
  }

  const sections = detectSections(trimmed, pages);

  return {
    text: trimmed,
    pageCount: pages.length,
    pages,
    sections,
    renderedPdfPath,
    isScannedOrEmpty,
  };
}

/**
 * Creates a formatted PDF with text layer from extracted pages using pdf-lib.
 */
async function renderTextToPdf(pages: ExtractedPage[], outputPath: string): Promise<void> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4 points
  const pageHeight = 841.89;
  const margin = 50;
  const lineHeight = 16;
  const fontSize = 10;
  const maxLineWidth = pageWidth - margin * 2;

  for (const pageInfo of pages) {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    // Header
    page.drawText(`Page ${pageInfo.pageNumber}`, {
      x: pageWidth - margin - 50,
      y: pageHeight - margin + 20,
      size: 9,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });

    const lines = pageInfo.text.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        y -= lineHeight * 0.75;
        if (y < margin) break;
        continue;
      }

      // Check if line looks like a legal heading
      const isHeader = /^(?:SECTION|Section|CLAUSE|Clause|ARTICLE|Article|[0-9]{1,2}\.)/.test(line);
      const activeFont = isHeader ? boldFont : font;
      const activeSize = isHeader ? fontSize + 1 : fontSize;

      // Simple word wrapping
      const words = line.split(' ');
      let currentLine = '';

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testWidth = activeFont.widthOfTextAtSize(testLine, activeSize);

        if (testWidth > maxLineWidth && currentLine.length > 0) {
          page.drawText(currentLine, {
            x: margin,
            y,
            size: activeSize,
            font: activeFont,
            color: isHeader ? rgb(0.1, 0.15, 0.3) : rgb(0.15, 0.15, 0.15),
          });
          y -= lineHeight;
          currentLine = word;
          if (y < margin) break;
        } else {
          currentLine = testLine;
        }
      }

      if (currentLine.length > 0 && y >= margin) {
        page.drawText(currentLine, {
          x: margin,
          y,
          size: activeSize,
          font: activeFont,
          color: isHeader ? rgb(0.1, 0.15, 0.3) : rgb(0.15, 0.15, 0.15),
        });
        y -= lineHeight;
      }

      if (y < margin) {
        break;
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, pdfBytes);
}
