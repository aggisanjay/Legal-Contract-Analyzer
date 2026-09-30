# Video Demonstration Checklist: Legal Contract Analyzer

This checklist outlines the sequential steps to record for the comprehensive evaluation video demo.

---

## 1. Document Upload & Processing Pipeline
- [ ] Open the web application at `http://localhost:3000`.
- [ ] Click **Upload Contract** in the top navbar.
- [ ] **Step 1: Scanned PDF Rejection**:
  - Drag and drop `fixtures/scanned-empty.pdf`.
  - Click **Start Processing**.
  - Show the processing pipeline fail with a clear red card:
    *"This PDF appears to be scanned or contains no readable text. Please upload a text-based PDF or DOCX."*
  - Click **Delete & Reset**.
- [ ] **Step 2: Valid Contract Upload**:
  - Upload `fixtures/test-contract.pdf` (Version 1).
  - Show the live stage stepper: `Uploading` → `Extracting text` → `Splitting into sections` → `Indexing` → `Ready`.
  - Click **Open in Analyzer**.
- [ ] **Step 3: Second Contract & DOCX Upload**:
  - Upload `fixtures/test-contract-v2.pdf` (Version 2).
  - Upload `fixtures/sample-contract.docx`.
  - Confirm all ready contracts appear in the left **Contract Library** with page counts and format badges.

---

## 2. Interactive QA, Real Token Streaming & Stop Button
- [ ] Select `test-contract.pdf` in the library.
- [ ] In the chat input, ask: *"What is the limitation of liability cap and what are the termination provisions?"*
- [ ] Notice the immediate first event: the conversation ID is bound.
- [ ] Observe genuine token-by-token streaming of the response prose into the message bubble.
- [ ] Test the **Stop** button:
  - While streaming, click the dark **Stop** button (which replaced Send).
  - Verify streaming ceases immediately.
  - Verify the message retains the partial text generated so far and displays the **Stopped** badge.
  - Confirm the input re-enables immediately without page freeze.
- [ ] Ask a follow-up: *"What is the governing law of this contract?"*
- [ ] Allow completion: observe inline numbered chips `[[1]]` rendered in the prose.

---

## 3. Server-Verified Citations & Highlighting in Viewer
- [ ] Inspect the verified citation card under the answer:
  - Green **Verified** badge.
  - Page label (`p. 1` or `pp. 12–13`).
  - Two-line quote preview with **Expand quote** / **Show less**.
- [ ] Click the inline chip `[1]` or **Open in document**:
  - Center viewer navigates directly to the target page.
  - Observe exact multi-line amber highlight boxes with 2-second pulse animation.
  - Highlight persists on screen.
- [ ] Test a cross-page citation:
  - Ask: *"Quote the exact termination clause crossing pages."*
  - Click citation: verify highlights render across both page 12 and page 13.
- [ ] Test duplicate occurrence handling:
  - If a quote appears multiple times, show the occurrence indicator ("Occurrence 1 of 3") and cycle through using Next/Prev buttons.

---

## 4. Unverified / Hallucinated Quote Handling
- [ ] Ask a question designed to test hallucination rejection or unverified claims.
- [ ] Point out the amber **Unverified Quotes (removed from evidence)** group (collapsed by default).
- [ ] Expand the unverified group:
  - Show candidate quote and rejection reason (e.g. *"Quote could not be located in the document"* or *"too short to be meaningful evidence"*).
  - Confirm unverified quotes have **no "Open in document" button** and cannot be clicked.
- [ ] Point out the server notice banner if zero verified quotes are found:
  *"This answer has no verified quotes. Treat it as unsupported."*

---

## 5. Large Document (150-Page) Handling & Coverage Honesty
- [ ] Upload `fixtures/large-150-page-contract.pdf`.
- [ ] Ask about the buried clause: *"What is the emergency data escrow procedure?"*
- [ ] Show the answer finding and verifying the buried clause at **page 112**.
- [ ] Click the citation: viewer jumps directly to **page 112** and highlights the exact clause.
- [ ] Ask about the deliberately absent clause: *"Does this contract contain an early termination penalty fee?"*
- [ ] Show the exhaustive Map-Reduce progress: `"Reading section 3 of 14..."`.
- [ ] Point out the green coverage bar: `"Read 150 of 150 pages (100% complete)"`.
- [ ] Confirm the answer states: *"not present in the contract (searched all 150 pages)"*.
- [ ] Note coverage honesty: if coverage is less than 100%, the application never asserts absence.

---

## 6. Multi-Document Cross-Contract Analysis
- [ ] In the Contract Library, check the boxes for both `test-contract.pdf` and `test-contract-v2.pdf`.
- [ ] Observe the header pill: *"Analyzing 2 docs: test-contract.pdf, test-contract-v2.pdf"*.
- [ ] Ask: *"Compare the limitation of liability and notice periods between these contracts."*
- [ ] Show comparative answer with document labels on each quote.
- [ ] Click a quote from `test-contract-v2.pdf`:
  - Viewer switches tab to `test-contract-v2.pdf` and highlights the passage.
- [ ] Click a quote from `test-contract.pdf`:
  - Viewer switches tab back to `test-contract.pdf` and highlights the passage.

---

## 7. Semantic Contract Comparison (AED 100,000 → AED 1,000,000)
- [ ] Click **Compare Versions** in the top navbar.
- [ ] Select:
  - **Contract A (Base Version)**: `test-contract.pdf`.
  - **Contract B (Revised Version)**: `test-contract-v2.pdf`.
- [ ] Click **Compare Contracts**:
  - Show progress: *"Extracting clauses & aligning contract sections..."*.
- [ ] Inspect the **Summary Card**:
  - Overall assessment statement.
  - High, Medium, and Low significance counts.
- [ ] Show the **Limitation of Liability** change:
  - **HIGH SIGNIFICANCE** badge.
  - Numeric change pill: `"AED 100,000 → AED 1,000,000"`.
  - Plain-language legal impact statement.
  - Expand **View clause text & inline word diff**:
    - Red strike-through for deleted text (`AED 100,000`).
    - Green highlight for inserted text (`AED 1,000,000`).
- [ ] Show the **Termination Notice Period** change:
  - Notice period change `"30 days → 60 days"`.
- [ ] Demonstrate filtering by significance (**High**, **Medium**, **Low**) and sorting by **Significance First**.
- [ ] Show the collapsed **Reworded-Only Clauses** section at the bottom.

---

## 8. Part C: Option 2 Agentic Document Research
- [ ] Ensure the **Part C: Agentic Research** toggle is **Active** in the navbar.
- [ ] Ask a complex multi-clause question:
  *"Can either party terminate without cause, what is the required notice, and what liabilities survive termination?"*
- [ ] Show the **live step timeline**:
  - `→ Searching for termination and survival provisions...`
  - `→ Found 4 passages across sections 12 and 14...`
  - `→ Reading section 14.2 for convenience terms...`
  - `→ Verifying quotes against canonical text...`
- [ ] Show the completed answer with verified citations and the collapsed research timeline.

---

## 9. Chat History Drawer
- [ ] Click the **History** icon in the chat header.
- [ ] Point out previous conversations listed by timestamp with message counts.
- [ ] Click a past conversation: confirm it reopens with citations still interactive and clickable.
- [ ] Click **+ New Conversation** to start a fresh chat.
