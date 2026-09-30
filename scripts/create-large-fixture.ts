import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs/promises';
import path from 'path';

export const BURIED_PAGE_NUMBER = 112;
export const BURIED_CLAUSE_TEXT =
  'The supplier shall provide a full replacement solar generator within twenty-four (24) hours of any power failure.';
export const ABSENT_CLAUSE_TOPIC = 'cryptocurrency settlement option or bitcoin payment';

export async function generateLargeFixture(): Promise<string> {
  const fixturesDir = path.join(process.cwd(), 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
  const outputPath = path.join(fixturesDir, 'large-150-page-contract.pdf');

  console.log('Generating 150-page contract PDF fixture at:', outputPath);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const TOTAL_PAGES = 150;

  for (let pageNum = 1; pageNum <= TOTAL_PAGES; pageNum++) {
    const page = pdfDoc.addPage([595.28, 841.89]);
    let y = 800;

    // Header
    page.drawText(`GLOBAL MASTER INFRASTRUCTURE AGREEMENT — PAGE ${pageNum} OF ${TOTAL_PAGES}`, {
      x: 50,
      y,
      size: 10,
      font: boldFont,
      color: rgb(0.3, 0.3, 0.3),
    });
    y -= 40;

    if (pageNum === 1) {
      page.drawText('PREAMBLE AND GENERAL SPECIFICATIONS', {
        x: 50,
        y,
        size: 14,
        font: boldFont,
        color: rgb(0.1, 0.2, 0.4),
      });
      y -= 30;
      page.drawText('This Agreement constitutes the entire long-term infrastructure service terms.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else if (pageNum === BURIED_PAGE_NUMBER) {
      // Buried known clause at page 112
      page.drawText(`SECTION 112. EMERGENCY AUXILIARY POWER PROVISIONS`, {
        x: 50,
        y,
        size: 12,
        font: boldFont,
        color: rgb(0.1, 0.2, 0.4),
      });
      y -= 25;
      page.drawText(BURIED_CLAUSE_TEXT, {
        x: 50,
        y,
        size: 10,
        font,
      });
      y -= 20;
      page.drawText('Failure to deploy the replacement within 24 hours triggers immediate liquidated damages.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else {
      // Standard realistic boilerplate contract clauses
      page.drawText(`CLAUSE ${pageNum}. OPERATIONAL STANDARDS AND COVENANTS`, {
        x: 50,
        y,
        size: 11,
        font: boldFont,
      });
      y -= 20;
      page.drawText(
        `The service provider agrees to perform all scheduled infrastructure maintenance in accordance with standard good industry practice and manufacturer guidelines during page cycle ${pageNum}.`,
        { x: 50, y, size: 9, font }
      );
      y -= 20;
      page.drawText(
        `All technical personnel assigned to this facility must hold valid commercial safety certifications and follow strict occupational health protocols throughout operations.`,
        { x: 50, y, size: 9, font }
      );
    }
  }

  const pdfBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, pdfBytes);
  console.log(`✓ Successfully generated 150-page fixture (${pdfBytes.length} bytes)`);
  return outputPath;
}

if (process.argv[1]?.includes('create-large-fixture')) {
  generateLargeFixture().catch(console.error);
}
