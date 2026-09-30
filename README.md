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
| **Quote Verifier Offset Bug Fix** | **Finished** | Ligature expansion 1:1 map, soft hyphens, hyphenated line breaks, min length guard, real `pagesJson` offsets. Verified by Vitest. |
| **True Provider Streaming + Stop** | **Finished** | Provider SSE with `---QUOTES---` delimiter. Server-side abort signal persists partial answer with `interrupted: true`. First event is `meta`. |
| **Zero Fake AI Fallbacks** | **Finished** | Simulated engines completely removed. Typed `AIUnavailableError` thrown when unavailable. Primary generic `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` supported. |
| **Unverified Citation Handling** | **Finished** | Candidate quotes verified server-side; unverified grouped separately in collapsed warning section, non-clickable. Zero verified quotes notice rendered. Multi-doc verifies only against own document. |
| **150-Page Support & Coverage Honesty** | **Finished** | Strategy A (Targeted hybrid) and Strategy B (Map-reduce over chunks). Enforced coverage honesty: never claims absence if coverage < 100%. Tested with 150-page fixture. |
| **Upload Pipeline with Real Status** | **Finished** | Immediate 202/PROCESSING return, background stage progression, magic byte validation, scanned PDF rejection, database storage interface. |
| **Part C: Agentic Research Hardening** | **Finished** | Hard round cap, structured tool error recovery, character budget guard, multi-doc tool execution, live step timeline. |
| **Semantic Comparison Quality** | **Finished** | Section/paragraph alignment, Jaccard similarity for renumbered clauses, deterministic significance guard (currency/dates/modals never LOW), inline word LCS diff. |
| **Chat History Drawer** | **Finished** | List conversations per document (including multi-doc), reopen past conversations with interactive citations intact. |
| **Citation Highlighting in Viewer** | **Finished** | Text-layer search matching verifier normalization, multi-line line rects, duplicate occurrence navigation ("Occurrence 1 of N"), DOCX HTML viewer, fallback toast. |
| **OCR for Scanned PDFs** | **Not Finished** | Out of scope for this assignment. Scanned PDFs are accurately detected and rejected with a clear user-facing error message. |

---

## Known Limitations

1. **Optical Character Recognition (OCR)**: Scanned image-only PDFs without a text layer are intentionally rejected with clear guidance (`"This PDF appears to be scanned or contains no readable text"`). Real OCR (e.g. Tesseract or Cloud Document AI) is not included.
2. **Complex Embedded Tables**: While tabular text is extracted, multi-column tables with complex merged cells may have irregular reading orders depending on the underlying PDF layout stream.
3. **Provider Rate Limits**: When using free-tier providers without billing, rapid consecutive queries may trigger 429 rate limits, which are handled gracefully by the multi-provider cascade.
