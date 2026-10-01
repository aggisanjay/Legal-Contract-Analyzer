import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs/promises';
import path from 'path';

export const RUNNING_HEADER = 'Master Services Agreement - Falcon Technologies LLC / Al Noor Trading FZE';
export const CROSS_PAGE_QUOTE = 'deliverables shall be deemed accepted upon expiry of the review period';
export const CONFIDENTIALITY_QUOTE = 'The parties shall maintain confidentiality of all proprietary technical data and commercial disclosures.';

export async function generateBenchmark150PageContract(
  filename: string,
  options: {
    liabilityCap: string; // e.g. "AED 100,000" or "AED 1,000,000"
    noticeDays: string;   // e.g. "thirty (30)" or "sixty (60)"
  }
): Promise<string> {
  const fixturesDir = path.join(process.cwd(), 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
  const outputPath = path.join(fixturesDir, filename);

  console.log(`Generating 150-page benchmark fixture: ${filename}...`);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const TOTAL_PAGES = 150;

  for (let pageNum = 1; pageNum <= TOTAL_PAGES; pageNum++) {
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 dimensions
    let y = 800;

    // Running Header (Pages 2-150)
    if (pageNum > 1) {
      page.drawText(RUNNING_HEADER, {
        x: 50,
        y: 810,
        size: 9,
        font: boldFont,
        color: rgb(0.35, 0.35, 0.35),
      });
    }

    // Running Footer (All pages)
    page.drawText(`Page ${pageNum} of ${TOTAL_PAGES}`, {
      x: 250,
      y: 30,
      size: 9,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });

    if (pageNum === 1) {
      page.drawText('MASTER SERVICES AGREEMENT', {
        x: 50,
        y,
        size: 16,
        font: boldFont,
        color: rgb(0.1, 0.2, 0.4),
      });
      y -= 30;
      page.drawText('Between Falcon Technologies LLC and Al Noor Trading FZE', {
        x: 50,
        y,
        size: 11,
        font: boldFont,
      });
      y -= 30;
      page.drawText('This Master Services Agreement sets forth terms governing long-term technology deployment.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else if (pageNum === 9) {
      // Page 9: First occurrence of confidentiality
      page.drawText('ARTICLE 9. CONFIDENTIALITY AND SECURITY', {
        x: 50,
        y,
        size: 12,
        font: boldFont,
      });
      y -= 25;
      page.drawText(CONFIDENTIALITY_QUOTE, {
        x: 50,
        y,
        size: 10,
        font,
      });
      y -= 20;
      page.drawText('All disclosures marked confidential shall remain protected under strict security controls.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else if (pageNum === 21) {
      // Page 21: Deliverables acceptance breaking mid-sentence across page break
      page.drawText('ARTICLE 21. ACCEPTANCE PROCEDURE AND TESTING', {
        x: 50,
        y,
        size: 12,
        font: boldFont,
      });
      y -= 25;
      page.drawText('Section 21.1 Inspection. Upon delivery of each milestone release, customer shall conduct tests.', {
        x: 50,
        y,
        size: 10,
        font,
      });
      y -= 20;
      page.drawText('All submitted deliverables shall be deemed', {
        x: 50,
        y: 60, // Near bottom of page 21
        size: 10,
        font,
      });
    } else if (pageNum === 22) {
      // Page 22: Continuing acceptance sentence from page 21
      page.drawText('accepted upon expiry of the review period unless written notice of defect is provided.', {
        x: 50,
        y: 770, // Near top of page 22 below running header
        size: 10,
        font,
      });
      y = 740;
      page.drawText('Section 21.2 Remedies for Defect. Provider shall cure non-conforming items within 10 days.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else if (pageNum === 38) {
      // Page 38: Article 38 Termination for Convenience
      page.drawText('ARTICLE 38. TERMINATION FOR CONVENIENCE', {
        x: 50,
        y,
        size: 12,
        font: boldFont,
      });
      y -= 25;
      page.drawText(`Either party may terminate this Agreement for convenience by providing ${options.noticeDays} days' written notice.`, {
        x: 50,
        y,
        size: 10,
        font,
      });
      y -= 20;
      page.drawText('Upon termination, provider shall promptly cease all operations and return materials.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else if (pageNum === 112) {
      // Page 112: Article 55 containing Limitation of Liability
      page.drawText('ARTICLE 55. LIMITATION OF LIABILITY AND REMEDIES', {
        x: 50,
        y,
        size: 12,
        font: boldFont,
        color: rgb(0.1, 0.2, 0.4),
      });
      y -= 25;
      page.drawText(`The aggregate liability of either party shall not exceed ${options.liabilityCap}.`, {
        x: 50,
        y,
        size: 10,
        font,
      });
      y -= 20;
      page.drawText('Neither party shall be liable for indirect, incidental, punitive, or consequential damages.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else if (pageNum === 116) {
      // Page 116: Article 116 Governing Law
      page.drawText('ARTICLE 116. GOVERNING LAW AND JURISDICTION', {
        x: 50,
        y,
        size: 12,
        font: boldFont,
      });
      y -= 25;
      page.drawText('This Agreement shall be governed by the laws of the Emirate of Dubai.', {
        x: 50,
        y,
        size: 10,
        font,
      });
      y -= 20;
      page.drawText('The courts of Dubai shall have exclusive jurisdiction over any dispute arising under this Agreement.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else if (pageNum === 150) {
      // Page 150: Duplicate occurrence of confidentiality sentence
      page.drawText('ARTICLE 75. GENERAL PROVISIONS AND CLOSING COVENANTS', {
        x: 50,
        y,
        size: 12,
        font: boldFont,
      });
      y -= 25;
      page.drawText(CONFIDENTIALITY_QUOTE, {
        x: 50,
        y,
        size: 10,
        font,
      });
      y -= 20;
      page.drawText('This Agreement constitutes the entire understanding between the parties.', {
        x: 50,
        y,
        size: 10,
        font,
      });
    } else {
      // Standard realistic clauses
      page.drawText(`ARTICLE ${pageNum}. OPERATIONAL SPECIFICATIONS AND COMPLIANCE`, {
        x: 50,
        y,
        size: 11,
        font: boldFont,
      });
      y -= 20;
      page.drawText(
        `The provider agrees to maintain all infrastructure, servers, and networks in accordance with standard good industry practice during contract cycle ${pageNum}.`,
        { x: 50, y, size: 9, font }
      );
      y -= 20;
      page.drawText(
        `All technical personnel assigned to this facility must follow strict data protection and operational health protocols throughout operations.`,
        { x: 50, y, size: 9, font }
      );
    }
  }

  const pdfBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, pdfBytes);
  console.log(`✓ Created ${outputPath} (${pdfBytes.length} bytes, 150 pages)`);
  return outputPath;
}

async function main() {
  await generateBenchmark150PageContract('large-contract-v1-150pages.pdf', {
    liabilityCap: 'AED 100,000',
    noticeDays: 'thirty (30)',
  });
  await generateBenchmark150PageContract('large-contract-v2-150pages.pdf', {
    liabilityCap: 'AED 1,000,000',
    noticeDays: 'sixty (60)',
  });
}

if (process.argv[1]?.includes('create-benchmark-fixtures')) {
  main().catch(console.error);
}
