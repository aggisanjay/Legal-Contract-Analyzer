# Legal Contract Analyzer

Production-grade Legal Contract Analysis web application engineered for autonomous contract review, server-verified citation grounding, clause-level version comparison, and multi-step agentic document research.

Built with **Next.js 14 (App Router)**, **TypeScript**, **Tailwind CSS**, **Prisma ORM**, **PostgreSQL (Neon / Supabase)**, and **PDF.js**.

---

## Overview

Legal contracts demand zero-tolerance for hallucinations. The Legal Contract Analyzer strictly decouples candidate answer generation from citation authority: the AI may stream plain-text answers and propose candidate quotes, but the server independently verifies every quote against the canonical extracted document text before anything is marked as verified.

Users can:
1. **Upload PDF and DOCX agreements** with real-time background processing status.
2. **Interact with an AI assistant** via true token-by-token provider streaming with an instant **Stop** button that preserves partial answers.
3. **Inspect live agent research activity** (Part C: Option 2) with a real-time step timeline.
4. **Click verified citations and inline `[[n]]` chips** to jump directly to highlighted passages in the PDF or DOCX viewer (supporting multi-line, cross-page, and duplicate occurrence navigation).
5. **Analyze 150-page enterprise contracts** with honest coverage reporting and map-reduce clause extraction.
6. **Compare contract versions** at the clause level with significance ratings (**HIGH**, **MEDIUM**, **LOW**), plain-language summaries, extracted numeric/date changes (e.g. `AED 100,000 → AED 1,000,000`), and inline word-level red/green diffs.
7. **Perform multi-document cross-analysis** across several selected contracts simultaneously.

---

## Screenshot Placeholders

```
+----------------------------------------------------------------------------------------------------+
| [Screenshot Placeholder: Upload Pipeline & Processing Stepper]                                     |
| Uploading → Extracting text → Splitting into sections → Indexing → Ready                           |
+----------------------------------------------------------------------------------------------------+

+----------------------------------------------------------------------------------------------------+
| [Screenshot Placeholder: Chat with Inline Chips [[1]], Verified Quotes & Coverage Bar]            |
| "Read 150 of 150 pages (100% complete)" · Clickable citation chips · Collapsed unverified group  |
+----------------------------------------------------------------------------------------------------+

+----------------------------------------------------------------------------------------------------+
| [Screenshot Placeholder: Document Viewer with Citation Highlighting]                              |
| Multi-line bounding rectangles · Page-accurate highlighting · Occurrence 1 of N controls           |
+----------------------------------------------------------------------------------------------------+

+----------------------------------------------------------------------------------------------------+
| [Screenshot Placeholder: Semantic Version Comparison with Inline Word Diff]                       |
| "AED 100,000 → AED 1,000,000" · HIGH Significance badge · Old vs New side-by-side · Word changes  |
+----------------------------------------------------------------------------------------------------+
```

---

## Core System Architecture

```
Browser (Next.js 14 Client Components)
  ↓ SSE / REST
Next.js Route Handlers (App Router)
  ├─ /api/documents (Upload, background processing pipeline, DB storage)
  ├─ /api/chat/stream (Real provider SSE, "---QUOTES---" buffering, server verification)
  ├─ /api/chat/history (Reopen past chats, multi-doc chat persistence)
  └─ /api/compare (Semantic clause extraction, LCS word diffs, significance rating)
  ↓
Document Processing & Storage (src/lib/documents/)
  ├─ Database Storage Interface (PostgreSQL Bytea: persists across serverless restarts)
  ├─ PDF Extraction (Per-page character offsets, pagesJson, scanned check)
  ├─ DOCX Extraction (Mammoth text extraction + HTML viewer rendering)
  ├─ Clause Chunking & Indexing (Legal section boundaries, no overlapping chunk pollution)
  └─ Real Status Polling: Uploading → Extracting → Splitting → Indexing → Ready
  ↓
AI Provider Cascade & Agentic Engine (src/lib/ai/)
  ├─ Primary Provider: AI_API_KEY, AI_BASE_URL, AI_MODEL
  ├─ Optional Cascade: Google Gemini → Groq Cloud → Hugging Face → OpenAI
  ├─ No Fake AI: Typed AIUnavailableError if providers are unavailable or rate-limited
  └─ Part C Agent: MAX_AGENT_ROUNDS cap, live step timeline, tool validation
  ↓
Quote Verifier (src/lib/quotes/quote-verifier.ts)
  ├─ Unicode NFKC Normalization & 1:1 Character Mapping (origIndexMap.length === normalized.length)
  ├─ Soft Hyphens & Line-Break Hyphenation ("terminat-\ned" matches "terminated")
  ├─ Minimum Quote Length Enforcement (rejected if < 25 chars and < 5 words)
  ├─ Verified vs Unverified Flagging (unverified quotes excluded from evidence)
  └─ Page Derivation from Real Document pagesJson Offsets
```

---

## Environment Variables

Configure your environment variables in `.env`:

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string (Neon, Supabase, local Postgres) | `postgresql://user:pass@ep-xyz.neon.tech/neondb?sslmode=require` |
| `AI_API_KEY` | **Yes** | API key for primary AI provider | `AIzaSy...` or `gsk_...` |
| `AI_BASE_URL` | **Yes** | OpenAI-compatible endpoint URL | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `AI_MODEL` | **Yes** | Model identifier | `gemini-2.0-flash` or `llama-3.3-70b-versatile` |
| `AI_PROVIDER_CASCADE` | No | Optional comma-separated failover order | `gemini,groq,huggingface` |
| `GEMINI_API_KEY` | No | Secondary provider key for Google Gemini | `AIzaSy...` |
| `GROQ_API_KEY` | No | Secondary provider key for Groq Cloud | `gsk_...` |
| `HUGGINGFACE_API_KEY` | No | Secondary provider key for Hugging Face | `hf_...` |

---

## Local Setup

### Prerequisites
- Node.js 18.x or 20.x
- PostgreSQL database (or free Neon PostgreSQL instance)

### Installation Steps

1. **Clone the repository and install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` to `.env` and configure your `DATABASE_URL` and `AI_API_KEY`:
   ```bash
   cp .env.example .env
   ```
   > **Note on PostgreSQL**: The project uses PostgreSQL exclusively (not SQLite) to support byte storage and cloud serverless deployments. For local development, you can use a free [Neon](https://neon.tech) or [Supabase](https://supabase.com) serverless PostgreSQL database URL (e.g. `postgresql://user:pass@ep-xyz.neon.tech/neondb?sslmode=require`) or a local PostgreSQL instance (`postgresql://postgres:password@localhost:5432/legal_contract_analyzer`).


3. **Initialize Database Schema**:
   Push the Prisma schema to your PostgreSQL database:
   ```bash
   npx prisma db push
   ```

4. **Generate Test Contract Fixtures (including 150-page PDF)**:
   ```bash
   npm run create-fixtures
   ```

5. **Run the Automated Test Suite**:
   ```bash
   npm test
   ```

6. **Start the Development Server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Deployment Steps (Vercel / Render)

1. **Database**:
   Use Neon or Supabase PostgreSQL with connection pooling enabled.

2. **Storage Persistence**:
   Files and rendered PDFs are stored directly in the database (`fileData`, `renderedPdfData` in `Document` table via `DatabaseDocumentStorage`), ensuring persistence in serverless and stateless container environments (Vercel, Render, AWS Lambda).

3. **Vercel Deployment**:
   - Push repository to GitHub.
   - Import project in Vercel.
   - Add environment variables (`DATABASE_URL`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`).
   - Deploy.

---

## What is Finished / Not Finished

| Feature / Requirement | Status | Verification & Notes |
| :--- | :---: | :--- |
| **Defect 1: Real Coverage in Agent Mode** | **Finished** | Union of pages actually returned by tools (`search_document`, `get_section`, `list_clauses`). Absence claims strictly prohibited on partial coverage. Exhaustive/absence queries automatically routed to map-reduce across all 150 pages. |
| **Defect 2: Cross-Page Quotes & Running Headers/Footers** | **Finished** | Noise spans dynamically detected (frequency >= 30% or regex) and skipped during normalization without offset distortion. Verifies cross-page deliverable quote spanning pages 21–22. Automatic single-shot verbatim quote repair step. |
| **Defect 3: Duplicate Quotes & Multi-Occurrences** | **Finished** | Verifier returns all occurrences across document (e.g., confidentiality on pp. 9 & 150). Merged into single card: `"Occurs 2× — pp. 9, 150"` with interactive Prev/Next occurrence navigation in viewer. |
| **Defect 4: Evidence Support & Process Sanitization** | **Finished** | Absence answers display quotes as neutral `Related passage (does not answer question)` (no green badge). Irrelevant quotes flagged `Verified text, but may not support this claim`. Self-referential process statements stripped. |
| **Defect 5: Section Delimitation & Agent Efficiency** | **Finished** | `get_section` delimits by next top-level Article/Section heading and extracts all segments (p. 112 liability cap surfaced under Article 55). Direct section shortcut bypasses agent loop. Research round notice moved to subtle footer note. |
| **Defect 6: Real Agent Streaming & Delimiter Sanitization** | **Finished** | Token-by-token streaming via `aiClient.streamChatCompletion`. Machine delimiter `<<<QUOTES>>>` cleanly strips JSON and conversational preambles from visible prose. Interrupted streams persisted with `interrupted: true`. |
| **Defect 7: Multi-Document Comparison & Document Scoping** | **Finished** | Comparative queries require both documents selected; refuses when only 1 is selected. Quotes require `documentId` and verify strictly against own document. Structured per-topic comparison with AED 100,000 (v1) and AED 1,000,000 (v2). |
| **Frontend Polish & Citations** | **Finished** | Clickable `[1]` and `[[1]]` chips, markdown rendering, amber badge with "Search the whole document" map-reduce re-run button, zero-quote answers collapsed behind warning banner with "Show anyway". |
| **OCR for Scanned PDFs** | **Not Finished** | Out of scope for this assignment. Scanned PDFs are accurately detected and rejected with a clear user-facing error message. |

---

## Known Limitations

1. **Optical Character Recognition (OCR)**: Scanned image-only PDFs without a text layer are intentionally rejected with clear guidance (`"This PDF appears to be scanned or contains no readable text"`). Real OCR (e.g. Tesseract or Cloud Document AI) is not included.
2. **Complex Embedded Tables**: While tabular text is extracted, multi-column tables with complex merged cells may have irregular reading orders depending on the underlying PDF layout stream.
3. **Provider Rate Limits**: When using free-tier providers without billing, rapid consecutive queries may trigger 429 rate limits, which are handled gracefully by the multi-provider cascade.
