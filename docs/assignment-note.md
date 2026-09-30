# Engineering Assignment Note: Legal Contract Analyzer

## 1. How Verification Works and Where It Can Fail

The core architectural invariant of this application is that **the AI model is never trusted for citations or text coordinates**.

### The Verification Pipeline
1. **Canonical Normalization with 1:1 Mapping**:
   Text extracted from PDFs and DOCX files is normalized character-by-character using Unicode NFKC. Because NFKC can expand single characters (e.g. ligatures `ﬁ`, `ﬂ`, `ﬀ` expand to `fi`, `fl`, `ff`; fractions `½` expand to `1/2`), our verifier pushes an entry to `origIndexMap` for **every output character of the expansion** (`origIndexMap.length === normalized.length`).
2. **Special Character & Hyphenation Handling**:
   Soft hyphens (`\u00AD`) are stripped, and words hyphenated across line breaks (e.g. `terminat-\ned` matching `terminated`) are joined while mapping back to the exact original characters in the canonical text slice. Curly quotes (`“`, `”`, `‘`, `’`) are mapped to ASCII equivalents.
3. **Minimum Length Guard**:
   Quotes under 25 characters or fewer than 5 words are rejected as "too short to be meaningful evidence", preventing single-word generic matches (like `"Party"` or `"Agreement"`) from being passed as citations.
4. **Disambiguation of Duplicates**:
   When identical phrases appear in multiple sections, the verifier prioritizes the occurrence closest to the candidate evidence chunk and calculates page boundaries using the real `pagesJson` offsets stored at extraction time.
5. **Separation of Verified vs Unverified Evidence**:
   Every quote is assigned `verified: true` or `false`. Unverified quotes are grouped separately in a collapsed warning UI and are non-clickable. If an answer contains zero verified quotes, a server-generated warning notice is attached: *"This answer has no verified quotes. Treat it as unsupported."*

### Where Verification Can Fail (Known Edge Cases)
- **Non-Standard Reading Orders**: In multi-column contracts, PDF text extraction tools can interleave text between columns, altering the sequential character stream.
- **Embedded Complex Tables**: Cell content may be extracted row-by-row or column-by-column, disrupting the linear phrasing expected by the model.
- **Font Encoding Anomalies (ToUnicode CMap Mismatches)**: Some PDFs use custom glyph IDs without valid ToUnicode mapping, producing garbled characters during extraction.
- **Near-Verbatim Paraphrasing**: If an LLM changes even a single word (e.g. *"either party can cancel"* instead of *"either party may terminate"*), the quote verifier strictly rejects the candidate quote.
- **Scanned Image Documents**: Image-only scans lack digital text layers and are detected and rejected at upload time.

---

## 2. Handling Large (150-Page) Documents & Coverage Honesty

Processing a 150-page enterprise agreement (~75,000 words) requires distinct strategies depending on the question:

1. **Targeted Questions**:
   - Hybrid retrieval combines dense semantic representations with BM25 keyword boosting.
   - Scaled top-$K$ retrieves relevant clauses plus adjacent neighbor chunks ($\pm 1$) to preserve immediate contractual context.
2. **Exhaustive / Absence Questions ("Does the contract contain X?", "List all Y")**:
   - Instead of risky single-chunk lookups, the server executes a **Map-Reduce** pass over all document chunks in concurrent 12,000-character batches.
   - The map phase asks each batch to extract verbatim passages relevant to the query or return `NONE`. The reduce phase synthesizes the aggregated findings.
3. **Coverage Honesty Rules**:
   - The server records chunks and pages examined and returns a `coverage` event: `{ chunksExamined, chunksTotal, pagesExamined, pagesTotal, strategy, incomplete }`.
   - The application **never asserts absence unless 100% of pages were examined**. If rate limits or batch failures cause partial coverage, the system enforces honesty in code:
     *"I searched pages X–Y and found nothing, but pages Z were not read, so I cannot confirm the clause is absent."*

---

## 3. Why Part C: Option 2 (Agentic Document Research)?

### Why Option 2 Was Chosen
Legal questions frequently require multi-hop inquiry across disparate sections of an agreement. For example, answering *"What are our risks if we terminate early for convenience?"* requires:
1. Finding the termination for convenience clause.
2. Checking the notice period requirements.
3. Cross-referencing early termination penalties or unamortized fee clauses.
4. Verifying post-termination survival obligations and dispute provisions.

A single-pass RAG retrieval cannot reliably assemble this multi-clause evidence chain. Option 2 equips the model with an autonomous tool loop (`search_document`, `get_section`, `list_clauses`) to iteratively gather and verify evidence.

### How Far It Went
- Hard round cap (`MAX_AGENT_ROUNDS = 5`) with budget guards.
- Malformed tool calls return structured schema errors, allowing autonomous recovery.
- Genuine token-by-token streaming of the final synthesized answer.
- Live step timeline emitted to the frontend (`Searching "termination"…` → `Found 4 passages` → `Reading section 14.2` → `Verifying quotes`).
- Multi-document support by passing `documentId` into tool calls.

### The Hardest Part of the Implementation
The most challenging engineering hurdle was **synchronizing genuine token streaming with server-side quote verification**. Because streaming outputs tokens immediately to the user while quote verification must happen against the full completed candidate quotes, we introduced the delimiter streaming protocol:
- The LLM streams prose tokens with inline markers `[[1]]` in real time.
- When the delimiter `---QUOTES---` is encountered, token forwarding pauses.
- The server buffers and parses the quote JSON, executes deterministic verification against canonical text, and emits individual `citation` and `unverified` SSE events.
- On abort/stop, the upstream stream is canceled and partial progress is saved immediately with `interrupted: true`.

### What's Next
1. **Direct OCR Integration**: Integrate native Tesseract or cloud OCR for image-scanned contract addenda.
2. **Table Reconstruction**: LayoutLM-based table boundary detection to preserve tabular structure in financial exhibits.
3. **Tracked Changes Redline Export**: Export clause comparisons directly to Microsoft Word `.docx` with native revision markup (`w:ins` and `w:del`).
