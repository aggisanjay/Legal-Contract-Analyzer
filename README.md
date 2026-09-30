# Contract Analyzer

Production-grade Legal Contract Analysis web application engineered for autonomous contract review, verified citation grounding, clause-level version comparison, and multi-step agentic document research.

Built with **Next.js (App Router)**, **TypeScript**, **Tailwind CSS**, **Prisma ORM**, **PostgreSQL (Neon / Supabase compatible)**, and **PDF.js**.

---

## Overview

Legal contracts demand zero-tolerance for hallucinations. The Contract Analyzer strictly decouples candidate generation from citation authority: the LLM may propose answers and candidate quotations, but the backend independently verifies every quote against the canonical extracted document text before anything is marked as verified.

Users can upload PDF and DOCX agreements, interact with an AI assistant via token-by-token streaming, inspect live agent research activity, click verified citations to jump directly to highlighted passages in the PDF viewer, compare contract versions at the clause level, and run multi-document comparative analysis.

---

## Features

- **Format Support**: Upload PDF and DOCX contracts up to 50 MB.
- **Scanned PDF Detection**: Automatically detects and rejects scanned PDFs lacking readable text layers, providing actionable guidance.
- **Verified Citations (Zero Hallucination)**: Deterministic character-level mapping from normalized text back to original document coordinates. Unverified quotes are rejected.
- **Interactive PDF Viewer & Multi-Line Highlighting**: PDF.js canvas with text-layer coordinates rendering amber highlight boxes across multiple lines and across page boundaries.
- **Part C: Agentic Document Research**: Autonomous multi-turn research loop utilizing `search_document`, `get_section`, and `list_clauses` tools with live progress events.
- **Real-Time Token Streaming with Stop Generation**: Server-Sent Events (SSE) streaming with AbortController support; partial responses are preserved in chat history.
- **Cross-Contract Multi-Document Analysis**: Select multiple contracts simultaneously to analyze substantive differences and compare terms.
- **Semantic Contract Version Comparison**: Clause-by-clause diffing categorizing changes as **HIGH**, **MEDIUM**, or **LOW** significance with plain-language impact statements.
- **Persistent Chat History**: Previous conversations and verified citations are stored per contract and reload seamlessly.

---

## Architecture

```
Browser (Next.js 14 Client Components)
  ↓ SSE / REST
Next.js Route Handlers (App Router)
  ↓
Document Processing Pipeline
  ├─ PDF Extraction (Page text, character offsets, scanned check)
  ├─ DOCX Extraction (Mammoth text extraction + PDF rendering)
  ├─ Clause-Aware Chunking (Legal section & paragraph boundaries)
  └─ Dense Vector Embeddings (Semantic representations)
  ↓
PostgreSQL Database (Prisma ORM / Neon / Supabase)
  ├─ Document, DocumentChunk, Conversation, Message, Comparison
  ↓
Retrieval & Agentic Research Engine
  ├─ Hybrid Semantic + BM25 Retrieval
  ├─ Tool Loop (search_document, get_section, list_clauses)
  └─ MAX_AGENT_ROUNDS = 5 Limit with Self-Correction
  ↓
QUOTE VERIFIER (server/quotes/quote-verifier.ts)
  ├─ Unicode NFKC Normalization & Whitespace Compression
  ├─ Exact 1:1 Character Index Map (normalized -> original)
  ├─ Disambiguation of Duplicate Quotes
  └─ Page Range Calculation
  ↓
PDF Viewer Highlighting (PDF.js Text Layer)
  └─ Multi-line & Cross-Page Bounding Rectangles
```

---

## Tech Stack

- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, Lucide React
- **PDF & Document Engine**: `pdfjs-dist` (canvas + textLayer rendering), `pdf-lib` (PDF manipulation and DOCX rendering), `mammoth` (DOCX extraction)
- **Database & ORM**: PostgreSQL (Neon / Supabase), Prisma ORM
- **AI & LLM Integration**: OpenAI-compatible client (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`) with built-in streaming parser and offline evaluation fallback
- **Validation & Testing**: Zod (tool and argument validation), Vitest (automated test suite)

---

## Document Processing

1. **Validation**: Enforces strict extension and MIME-type checks (`.pdf`, `.docx`). Rejects executables, images, and arbitrary binaries.
2. **Safe Storage**: Uploaded files are assigned cryptographically safe unique filenames in `storage/uploads/`.
3. **Extraction**:
   - **PDF**: Extracted page by page preserving character start and end offsets.
   - **DOCX**: Extracted to raw text and rendered to a companion PDF in `storage/rendered/` to support visual navigation and highlighting.
4. **Scanned PDF Guard**: Checks character density and printable text volume. If readable text is absent, the document is immediately marked as `FAILED` with the message:
   `"This PDF appears to be scanned or contains no readable text. Please upload a text-based PDF or DOCX."`
5. **Clause Chunking**: Respects contract sections (e.g. `12. LIMITATION OF LIABILITY`, `Section 14. Termination`) and sub-clauses, creating chunks of 600–1400 characters with 150-character overlap.
6. **Indexing**: Chunks are embedded and persisted to PostgreSQL with section titles, page bounds, and character offsets.

---

## Quote Verification

The core guarantee of the application is that the LLM is never trusted as the source of truth for citations.
Located in [`server/quotes/quote-verifier.ts`](file:///c:/Users/aggis/Desktop/Legal%20Contract%20Analyzer/server/quotes/quote-verifier.ts) and [`src/lib/quotes/quote-verifier.ts`](file:///c:/Users/aggis/Desktop/Legal%20Contract%20Analyzer/src/lib/quotes/quote-verifier.ts):

1. **NFKC Normalization**: Strips typographer variations (curly quotes, em dashes, non-breaking spaces).
2. **Whitespace Compression**: Converts line breaks, tabs, and spaces to a single space.
3. **Character Index Mapping**: Builds an exact array `origIndexMap[normIdx] = origIdx`.
4. **Matching**: Searches for normalized candidate quote. If found, maps matched boundaries back to original character indices `canonicalText.slice(startOffset, endOffset)`.
5. **Duplicate Disambiguation**: When identical phrases appear on multiple pages, the verifier prioritizes the occurrence closest to the retrieved evidence chunk.
6. **Page Derivation**: Page start and end are calculated strictly from the server page map—never from LLM suggestions.
7. **Unverified Handling**: If a quote cannot be verified verbatim in the contract, it is rejected and excluded from verified citations.

---

## Citation Highlighting

When a user clicks **[Open in document]** on any verified citation card:
1. The viewer receives `{ documentId, pageStart, pageEnd, quote, startOffset, endOffset }`.
2. The viewer navigates to `pageStart` and scrolls into view.
3. The PDF.js text layer extracts item text bounds.
4. Words spanning multiple lines generate separate highlight boxes (`citation-highlight-box`), preventing awkward page-wide blocks.
5. Cross-page quotes render highlights on both `pageStart` and `pageEnd`.

## Multi-Provider AI Cascading Failover (Gemini, Groq, Hugging Face, OpenAI)

The application features an automated, resilience-engineered **Multi-Provider Cascading Failover** architecture. If any model provider encounters a rate limit (HTTP `429 Too Many Requests`), quota exhaustion, or temporary service downtime (`5xx`), the client automatically and seamlessly routes the prompt to the next available configured provider without failing the user request or interrupting agentic research.

### Supported Out-of-the-Box Providers:

1. **Google Gemini** (via Google AI Studio's OpenAI-compatible endpoint):
   - Fast, high context capacity, inexpensive.
   - Endpoint: `https://generativelanguage.googleapis.com/v1beta/openai`
   - Default Model: `gemini-2.0-flash` or `gemini-1.5-flash`
2. **Groq Cloud**:
   - Ultra-fast token inference with generous free-tier limits.
   - Endpoint: `https://api.groq.com/openai/v1`
   - Default Model: `llama-3.3-70b-versatile` or `llama-3.1-8b-instant`
3. **Hugging Face Inference API / Router**:
   - Access to open-source foundation models.
   - Endpoint: `https://router.huggingface.co/hf-inference/v1`
   - Default Model: `Qwen/Qwen2.5-72B-Instruct` or `meta-llama/Llama-3.2-3B-Instruct`
4. **Standard OpenAI / OpenRouter / Local Ollama**:
   - Endpoint: `https://api.openai.com/v1` or custom
   - Default Model: `gpt-4o-mini`

### Failover Order Configuration
Define the priority order in `.env` via `AI_PROVIDER_CASCADE`:
```env
AI_PROVIDER_CASCADE="gemini,groq,huggingface,openai"
```
When `gemini` returns a `429`, the engine automatically logs a failover event and immediately retries the current turn or agent tool execution using `groq`. If `groq` is rate-limited, it falls over to `huggingface`, then `openai`, and finally the offline legal synthesizer.

---

- Select multiple contracts in the left sidebar.
- Ask comparative questions such as *"How do the liability caps differ?"* or *"Compare governing law clauses"*.
- The backend retrieves relevant chunks from each document independently.
- The LLM synthesizes substantive legal differences.
- Citations are tagged with their specific `documentId` and verified exclusively against their respective contract.

---

## Contract Comparison

- Select two contracts (Base Version A vs Revised Version B) via the **Compare Versions** modal.
- The engine matches clauses across versions, detects substantive changes in liabilities, notice periods, and material obligations.
- Categorizes each modification:
  - **HIGH**: Liability caps, indemnities, termination convenience, governing law, warranties.
  - **MEDIUM**: Notice periods, operational deadlines, procedural adjustments.
  - **LOW**: Stylistic phrasing, typographical adjustments.
- Displays side-by-side OLD vs NEW clause text with plain-language impact analysis.

---

## Part C: Agentic Document Research

The application implements **Option 2 — Agentic Document Research**:
- **Tools**:
  - `search_document(query: string, topK?: number)`
  - `get_section(sectionNumber: string)`
  - `list_clauses()`
- **Guardrails**:
  - Hard limit of `MAX_AGENT_ROUNDS = 5`.
  - Zod validation on tool arguments. Invalid arguments or unknown tool calls return structured errors into the conversation history, allowing the agent to self-correct.
- **Live Progress Activity**: Emits real-time SSE progress events displayed in the UI:
  - *"Searching for termination provisions..."*
  - *"Found relevant clauses..."*
  - *"Checking section 14.2..."*
  - *"Verifying citations against canonical text..."*
  - *"Preparing answer..."*

---

## Large Document Strategy

- Tested for large commercial contracts (up to 150+ pages).
- Full documents are never passed into LLM prompt contexts.
- Hybrid retrieval (semantic cosine similarity + BM25 keyword matching + section title boosts) fetches only relevant evidence chunks.
- Inquiries regarding absent provisions trigger broader clause indexing rather than assumptions. If evidence is insufficient, the system safely responds:
  *"I couldn't find sufficient evidence in the uploaded contract to answer this reliably."*

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Configure your parameters:

```env
# Database Configuration (PostgreSQL - Neon / Supabase / Local)
DATABASE_URL="postgresql://user:password@ep-sample-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require"

# 1. Google Gemini (Google AI Studio)
GEMINI_API_KEY="your-gemini-api-key"
GEMINI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai"
GEMINI_MODEL="gemini-2.0-flash"

# 2. Groq (Ultra-fast Inference)
GROQ_API_KEY="your-groq-api-key"
GROQ_BASE_URL="https://api.groq.com/openai/v1"
GROQ_MODEL="llama-3.3-70b-versatile"

# 3. Hugging Face Inference API / Router
HUGGINGFACE_API_KEY="your-hf-token"
HUGGINGFACE_BASE_URL="https://router.huggingface.co/hf-inference/v1"
HUGGINGFACE_MODEL="Qwen/Qwen2.5-72B-Instruct"

# 4. Standard OpenAI / OpenRouter / Custom
AI_API_KEY="your-openai-api-key"
AI_BASE_URL="https://api.openai.com/v1"
AI_MODEL="gpt-4o-mini"

# Priority Order for Automatic Rate Limit Failover:
AI_PROVIDER_CASCADE="gemini,groq,huggingface,openai"

# Application Limits
MAX_FILE_SIZE_MB=50
MAX_AGENT_ROUNDS=5

# Storage
STORAGE_DIR="./storage"
```

---

## Database Setup (Neon / Supabase)

1. Create a project in [Neon](https://neon.tech) or [Supabase](https://supabase.com).
2. Copy your pooled or direct PostgreSQL connection string into `DATABASE_URL` in `.env`.
3. Push the Prisma schema:
   ```bash
   npx prisma db push
   ```
4. Generate the Prisma client:
   ```bash
   npx prisma generate
   ```

---

## Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Generate test contract fixtures:
   ```bash
   npm run create-fixtures
   ```

3. Start the Next.js development server:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Testing

Run the automated Vitest test suite covering all 15 required core scenarios:

```bash
npm test
```

### Verified Scenarios:
1. `PDF upload accepted`
2. `DOCX upload accepted`
3. `Unsupported file rejected`
4. `Scanned/empty PDF rejected`
5. `Quote exact match verified`
6. `Quote with whitespace differences verified`
7. `Multi-line quote verified`
8. `Hallucinated quote rejected`
9. `Duplicate quote handled`
10. `Quote crossing pages handled`
11. `Multi-document quote verified against correct document`
12. `Agent stops after MAX_AGENT_ROUNDS`
13. `Unknown tool does not crash`
14. `Invalid tool arguments handled`
15. `Comparison detects liability amount change`

---

## Test Fixture Contracts

Located in [`fixtures/`](file:///c:/Users/aggis/Desktop/Legal%20Contract%20Analyzer/fixtures):
- `fixtures/test-contract.pdf`: Version 1 containing Limitation of Liability (AED 100,000), Termination (30 days notice), Governing Law (England and Wales), and Confidentiality.
- `fixtures/test-contract-v2.pdf`: Version 2 containing revised Limitation of Liability (AED 1,000,000) and Termination (60 days notice).
- `fixtures/sample-contract.docx`: DOCX contract for DOCX upload, text extraction, and PDF rendering validation.
- `fixtures/scanned-empty.pdf`: Scanned PDF fixture with 0 readable text to test empty/scanned PDF rejection.

---

## Completed Features

- [x] PDF upload & processing
- [x] DOCX upload & processing with PDF rendering
- [x] Unsupported file type rejection (error: "Unsupported file type. Please upload a PDF or DOCX contract.")
- [x] 50 MB file size limit enforcement
- [x] Scanned/empty PDF detection & graceful failure notification
- [x] Interactive Document Library with deletion confirmation
- [x] Single document grounded QA
- [x] Real-time SSE token streaming
- [x] Stop Generation with partial response preservation
- [x] Chat history persistence per document
- [x] Exact verified quote extraction with 1:1 character offset mapping
- [x] PDF.js interactive viewer with page navigation and zoom
- [x] Multi-line & cross-page citation highlighting
- [x] Multi-document cross-contract analysis
- [x] Clause-level contract comparison (Significance HIGH/MEDIUM/LOW)
- [x] Part C: Agentic Document Research with live activity indicators
- [x] Hard round limits & malformed tool recovery
- [x] Automated test suite passing 15/15 tests
- [x] Complete documentation & assignment note

---

## Known Limitations

- Optical Character Recognition (OCR) for rasterized image scans is deferred in this version; scanned PDFs are detected and safely rejected with guidance.
- Tool loop is scoped per document; cross-document agentic chaining across 5+ documents uses parallel chunk retrieval.

---

## Part C Summary

- **Option Selected**: Option 2 — Agentic Document Research.
- **Workflow**: Agent queries the document through multiple tool rounds (`search_document`, `get_section`, `list_clauses`), synthesizes findings, and submits quotes for independent backend verification before rendering.
- **Resilience**: Malformed arguments or unrecognized tool calls return structured errors without crashing the session.
