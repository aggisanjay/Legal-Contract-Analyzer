import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs/promises';
import path from 'path';

async function main() {
  const fixturesDir = path.join(process.cwd(), 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });

  console.log('Generating fixtures in:', fixturesDir);

  // 1. Generate fixtures/test-contract.pdf (Version 1)
  const doc1 = await PDFDocument.create();
  const font = await doc1.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc1.embedFont(StandardFonts.HelveticaBold);

  // Page 1
  const page1 = doc1.addPage([595.28, 841.89]);
  let y = 800;

  page1.drawText('MASTER SERVICES AGREEMENT (V1)', { x: 50, y, size: 16, font: boldFont, color: rgb(0.1, 0.2, 0.4) });
  y -= 40;

  page1.drawText('1. DEFINITIONS', { x: 50, y, size: 12, font: boldFont });
  y -= 20;
  page1.drawText('"Agreement" means this Master Services Agreement including all schedules.', { x: 50, y, size: 10, font });
  y -= 35;

  page1.drawText('12. LIMITATION OF LIABILITY', { x: 50, y, size: 12, font: boldFont });
  y -= 20;
  page1.drawText('The aggregate liability of either party shall not exceed AED 100,000.', { x: 50, y, size: 10, font });
  y -= 15;
  page1.drawText('Neither party shall be liable for indirect, incidental, or consequential damages.', { x: 50, y, size: 10, font });
  y -= 35;

  page1.drawText('14. TERMINATION', { x: 50, y, size: 12, font: boldFont });
  y -= 20;
  page1.drawText('Either party may terminate this Agreement for convenience by providing thirty (30) days\' written notice.', { x: 50, y, size: 10, font });
  y -= 35;

  // Page 2
  const page2 = doc1.addPage([595.28, 841.89]);
  y = 800;

  page2.drawText('18. GOVERNING LAW', { x: 50, y, size: 12, font: boldFont });
  y -= 20;
  page2.drawText('This Agreement shall be governed by the laws of England and Wales.', { x: 50, y, size: 10, font });
  y -= 35;

  page2.drawText('20. CONFIDENTIALITY', { x: 50, y, size: 12, font: boldFont });
  y -= 20;
  page2.drawText('The parties shall maintain confidentiality of all proprietary technical data and commercial disclosures.', { x: 50, y, size: 10, font });
  y -= 15;
  page2.drawText('This confidentiality obligation shall continue for five (5) years following termination of this Agreement.', { x: 50, y, size: 10, font });

  const bytes1 = await doc1.save();
  await fs.writeFile(path.join(fixturesDir, 'test-contract.pdf'), bytes1);
  console.log('✓ Created fixtures/test-contract.pdf');

  // 2. Generate fixtures/test-contract-v2.pdf (Revised Version for Comparison)
  const doc2 = await PDFDocument.create();
  const font2 = await doc2.embedFont(StandardFonts.Helvetica);
  const boldFont2 = await doc2.embedFont(StandardFonts.HelveticaBold);

  const p1_v2 = doc2.addPage([595.28, 841.89]);
  y = 800;

  p1_v2.drawText('MASTER SERVICES AGREEMENT (V2 - REVISED)', { x: 50, y, size: 16, font: boldFont2, color: rgb(0.1, 0.2, 0.4) });
  y -= 40;

  p1_v2.drawText('1. DEFINITIONS', { x: 50, y, size: 12, font: boldFont2 });
  y -= 20;
  p1_v2.drawText('"Agreement" means this Master Services Agreement including all schedules.', { x: 50, y, size: 10, font: font2 });
  y -= 35;

  p1_v2.drawText('12. LIMITATION OF LIABILITY', { x: 50, y, size: 12, font: boldFont2 });
  y -= 20;
  p1_v2.drawText('The aggregate liability of either party shall not exceed AED 1,000,000.', { x: 50, y, size: 10, font: font2 });
  y -= 15;
  p1_v2.drawText('Neither party shall be liable for indirect, incidental, or consequential damages.', { x: 50, y, size: 10, font: font2 });
  y -= 35;

  p1_v2.drawText('14. TERMINATION', { x: 50, y, size: 12, font: boldFont2 });
  y -= 20;
  p1_v2.drawText('Either party may terminate this Agreement for convenience by providing sixty (60) days\' written notice.', { x: 50, y, size: 10, font: font2 });
  y -= 35;

  const p2_v2 = doc2.addPage([595.28, 841.89]);
  y = 800;

  p2_v2.drawText('18. GOVERNING LAW', { x: 50, y, size: 12, font: boldFont2 });
  y -= 20;
  p2_v2.drawText('This Agreement shall be governed by the laws of England and Wales.', { x: 50, y, size: 10, font: font2 });

  const bytes2 = await doc2.save();
  await fs.writeFile(path.join(fixturesDir, 'test-contract-v2.pdf'), bytes2);
  console.log('✓ Created fixtures/test-contract-v2.pdf');

  // 3. Generate fixtures/sample-contract.docx
  const { Document: DocxDoc, Paragraph, TextRun, HeadingLevel, Packer } = await import('docx');
  const docxFile = new DocxDoc({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: 'STANDARD CONSULTING AGREEMENT',
            heading: HeadingLevel.TITLE,
          }),
          new Paragraph({
            text: '1. SCOPE OF SERVICES',
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun('The Consultant shall deliver professional legal advisory and analysis services in accordance with agreed statement of work.'),
            ],
          }),
          new Paragraph({
            text: '12. LIMITATION OF LIABILITY',
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun('The aggregate liability of either party shall not exceed AED 250,000 for any and all claims arising under this Agreement.'),
            ],
          }),
          new Paragraph({
            text: '14. TERMINATION',
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun('Either party may terminate this Agreement by giving thirty (30) days written notice to the other party.'),
            ],
          }),
        ],
      },
    ],
  });
  const docxBuffer = await Packer.toBuffer(docxFile);
  await fs.writeFile(path.join(fixturesDir, 'sample-contract.docx'), docxBuffer);
  console.log('✓ Created fixtures/sample-contract.docx');

  // 4. Generate fixtures/scanned-empty.pdf (Blank scanned PDF with 0 readable text)
  const docEmpty = await PDFDocument.create();
  docEmpty.addPage([595.28, 841.89]); // Pure blank image / scanned page without text stream
  const emptyBytes = await docEmpty.save();
  await fs.writeFile(path.join(fixturesDir, 'scanned-empty.pdf'), emptyBytes);
  console.log('✓ Created fixtures/scanned-empty.pdf');
}

main().catch((err) => {
  console.error('Fixture generation failed:', err);
  process.exit(1);
});
