# Production Deployment Checklist & Guide

This document details the configuration, environment variables, build lifecycle, and verification steps for deploying the Legal Contract Analyzer to production on **Vercel** with a hosted PostgreSQL database (such as **Neon** or **Supabase**).

---

## 1. Required Environment Variables

Configure the following variables in the **Vercel Project Settings ➔ Environment Variables** (for Production, Preview, and Development environments):

| Variable Name | Required | Default / Example Value | Description |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **Yes** | `postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30` | Hosted PostgreSQL connection string (Neon or Supabase). Must NOT use local SQLite. |
| `AI_API_KEY` | **Yes** | `AIzaSy...` or OpenAI/Groq API Key | Primary API key for LLM inference (Google Gemini, OpenAI, or Groq). |
| `AI_BASE_URL` | **Yes** | `https://generativelanguage.googleapis.com/v1beta/openai` or `https://api.openai.com/v1` | OpenAI-compatible endpoint URL for LLM chat and streaming completions. |
| `AI_MODEL` | **Yes** | `gemini-2.5-flash` or `gemini-1.5-flash` or `gpt-4o-mini` | Target primary AI model name. |
| `STORAGE_DRIVER` | No | `database` (default) | Set to `database` (default on serverless) or `local` (filesystem storage only when local disk persistence is desired). |
| `MAX_FILE_SIZE_MB`| No | `50` | Maximum upload size threshold in megabytes. |
| `GEMINI_API_KEY` | No | Fallback Gemini API key | Secondary fallback provider key for cascade failover. |
| `GROQ_API_KEY` | No | Fallback Groq API key | Tertiary fallback provider key for cascade failover. |

> [!IMPORTANT]
> **Security Check:** None of the production API keys or database credentials are committed to the Git repository. The file `.env` is explicitly declared in `.gitignore`. Only `.env.example` is committed as a reference template.

---

## 2. Build and Database Initialization

### Build Lifecycle in `package.json`
- `"postinstall": "prisma generate"`: Automatically generates the Prisma client binaries for the target Linux serverless runtime upon `npm install`.
- `"build": "next build"`: Compiles the Next.js App Router application with standalone output file tracing.

### First-Time Database Provisioning
Before opening the production app to traffic, apply the Prisma schema to the remote database:
```bash
npx prisma db push
```
This ensures the `Document`, `DocumentChunk`, `Conversation`, `Message`, and `Comparison` tables, including the `fileData`, `renderedPdfData`, and `errorDetail` columns, exist with all required foreign key cascade constraints and indexes.

---

## 3. Serverless Optimizations Verified

1. **PDF.js Fake Worker Tracing**:
   - `src/lib/documents/pdf-extractor.ts` dynamically imports `pdfjs-dist/legacy/build/pdf.worker.js` and initializes `globalThis.pdfjsWorker` before importing `pdf.js`.
   - `next.config.mjs` configures `outputFileTracingIncludes` for `/api/**/*` to include `./node_modules/pdfjs-dist/legacy/build/pdf.worker.js` in the serverless bundle.

2. **Serverless Timeouts & Background Processing**:
   - Routes `/api/documents`, `/api/documents/[id]/process`, `/api/documents/[id]/file`, `/api/chat/stream`, and `/api/compare` specify `export const maxDuration = 60;`, `export const runtime = 'nodejs';`, and `export const dynamic = 'force-dynamic';`.
   - `POST /api/documents` uploads file bytes to the database and immediately returns HTTP 202 (`{ id, status: 'PROCESSING' }`).
   - The client invokes `POST /api/documents/[id]/process` to run extraction, clause chunking, vector embedding, and PDF rendering within a fresh 60-second serverless execution window.
   - The UI polls `GET /api/documents/[id]/status` every 1 second, showing a visual 5-stage stepper (`Uploading` → `Extracting text` → `Splitting into sections` → `Indexing` → `Ready`).
   - Library load automatically marks documents stuck in `PROCESSING` for > 10 minutes as `FAILED`.

3. **Storage Persistence**:
   - Default `DatabaseStorageProvider` stores both raw original file bytes (`fileData`) and rendered PDF bytes (`renderedPdfData`) directly in PostgreSQL.
   - Deleting a document removes its stored binary data automatically.
   - File retrieval via `/api/documents/[id]/file` streams binary bytes directly from the database with byte-for-byte fidelity.

4. **Friendly Error Shielding**:
   - `src/lib/documents/error-mapper.ts` translates internal Vercel/Node.js stack traces, worker failures, or module errors into friendly user guidance: `"We couldn't read this file. Try uploading it again, or use a different PDF."`
   - Scanned PDFs without text layers display: `"This PDF has no readable text (it looks scanned). OCR is not supported yet."`
   - Raw technical stack traces are persisted in `Document.errorDetail` and logged on the server with the document ID, but never rendered in the UI.
   - Failed documents display their friendly message, a **Retry** button (re-invoking `/process`), and a **Delete** button. Failed documents cannot be opened for chat.

---

## 4. Local Production Build Testing

To test the production build locally before pushing:

```bash
# 1. Clean build
npm run build

# 2. Run production server
npm run start
```

### Verification Checklist Performed:
- [x] Tested `npm test`: All 61 Vitest tests passed across all 4 test suites.
- [x] Tested `npx tsc --noEmit`: 0 TypeScript compilation errors.
- [x] Tested `next build`: Successfully compiled and generated static and dynamic routes.
- [x] Tested 150-page document processing (`large-contract-v1-150pages.pdf`): Completed in 17.91s–23.09s (well within the 60-second limit).
- [x] Tested fake worker loading in serverless simulation without external `globalThis.pdfjsWorker`.
- [x] Tested database byte round-trip: Uploaded bytes and retrieved bytes are identical.
- [x] Tested scanned/empty rejection: Accurately caught without raw stack traces.
- [x] Tested citation verification and exact document viewer passage highlighting.

---

## 5. Verification Still Required on Vercel

Once deployed to Vercel:
1. Verify that `DATABASE_URL` is set with SSL enabled (`sslmode=require`).
2. Verify that `AI_API_KEY` is active and has sufficient model quota.
3. Upload `large-contract-v1-150pages.pdf` in the production deployment to confirm the 60-second execution window and live polling stepper work seamlessly on Vercel's edge network.
4. Verify that the production custom domain is linked to the `main` branch deployment.
