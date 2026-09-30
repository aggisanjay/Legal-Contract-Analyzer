# Engineering Assignment Note: Legal Contract Analyzer

## 1. Quote Verification

### Normalization
The quote verification system employs a deterministic normalization pipeline based on Unicode NFKC normalization. Legal contract documents often contain typographic variations that defeat naive string comparison:
- Smart quotes (`“`, `”`, `«`, `»`, `„` are normalized to standard ASCII `"`).
- Curly apostrophes and backticks (`‘`, `’`, `` ` `` are normalized to `'`).
- Dashes and hyphens (em dash `—`, en dash `–`, minus `−` are normalized to `-`).
- Non-breaking spaces (`\u00A0`, `\u200B`, `\u202F`, `\uFEFF` are normalized to `' '`).

### Whitespace Handling
Text extracted from PDFs and DOCX files frequently exhibits irregular whitespace: hard line breaks mid-sentence, tabular padding, and repeated carriage returns. The verifier collapses consecutive whitespace sequences into a single standard space while tracking the character mapping.

### Original Offset Mapping
Simple `document.includes(quote)` is strictly prohibited because knowing that normalized text matches is insufficient to locate and highlight the physical passage on the PDF page canvas.
Our custom normalizer builds an exact `origIndexMap` array alongside the normalized string:
```
origIndexMap[normalizedIndex] = originalCanonicalIndex
```
When a normalized quote match is discovered at `[normStart, normEnd]`:
```ts
startOffset = origIndexMap[normStart];
endOffset = origIndexMap[normEnd] + 1;
```
This guarantees an exact 1:1 slice into the unmodified canonical document text, preserving the precise original characters, spaces, and line breaks for coordinate rendering.

### Duplicate Handling
In commercial contracts, standard phrases (e.g., "The parties shall maintain confidentiality") frequently recur across multiple articles.
When candidate quotes appear more than once in a document:
1. All match candidates are extracted.
2. If the retriever provided a candidate chunk ID or offset range, the verifier computes the midpoint distance:
   ```ts
   distance = Math.abs(matchMidpoint - chunkMidpoint)
   ```
3. The match situated within or closest to the retrieved evidence chunk is selected.
4. If no chunk ID was provided, the first confirmed occurrence is selected. Locations are never fabricated or guessed.

### Why AI Positions Are Not Trusted
LLMs hallucinate page numbers, character offsets, and bounding coordinates with high frequency. In our architecture:
- The LLM is treated as an untrusted proposal engine that may only return candidate text.
- The backend quote verifier is the sole authority on whether a quote exists and where it resides.
- Page numbers, canonical character offsets, and rendered PDF coordinates are calculated entirely by the server and client rendering engine from verified text layers.

### Where Verification Could Fail
- Scanned documents or rasterized image PDFs without OCR layers (which are explicitly caught and rejected at upload time).
- Heavy optical distortion where character recognition drops words entirely.
- Paraphrased claims that alter substantive terminology (these are correctly flagged as unverified and excluded from the verified citation payload).

---

## 2. Large Documents

### Chunking Strategy
Contracts are chunked using a legal-structure-aware chunker:
- Respects section headers (e.g., `12. LIMITATION OF LIABILITY`, `Section 14. Termination`), numbered sub-clauses, and paragraph boundaries.
- Avoids splitting mid-clause whenever possible.
- Standard chunk size targets 600–1400 characters with 150-character contextual overlap.
- Retains section number and section title metadata for structured indexing.

### Embeddings and Retrieval
- Chunks are vectorized using dense vector representations (OpenAI-compatible embeddings or fast local deterministic subword vectorization).
- Semantic cosine similarity is combined with keyword and section-title boosting to retrieve the top 4–6 most relevant clauses.
- Absense queries (e.g., "Does this contract contain an early termination penalty?") trigger broader retrieval passes and clause indexing rather than single-chunk lookups.

### Why the Full Document Isn't Sent to the LLM
- A 150-page enterprise agreement contains over 75,000 words.
- Sending entire contracts inflates latency, triggers context window degradation (lost-in-the-middle phenomena), increases cost, and increases hallucination risks.
- Targeted retrieval delivers bounded, high-relevance evidence blocks with known chunk boundaries.

---

## 3. Part C Choice

> **"I chose Option 2 — Agentic Document Research."**

### Why Option 2 Was Selected
Complex contract analysis requires multi-hop inquiry. For example, answering "What happens if the customer terminates early?" requires inspecting termination clauses, cross-referencing notice periods, checking early termination fees, and reviewing survival clauses. A single-shot retrieval prompt cannot guarantee that all interrelated sections are fetched.

### Tool Architecture
The agent is equipped with three tools:
1. `search_document(query: string, topK?: number)`: Semantic and keyword search across all indexed chunks.
2. `get_section(sectionNumber: string)`: Direct lookup of an entire clause by section number (e.g. `14.2`, `12`).
3. `list_clauses()`: Retrieval of the contract's structural index and clause headers.

### Round Limit & Recovery
- Hard ceiling: `MAX_AGENT_ROUNDS = 5`.
- Infinite tool loops are strictly prevented.
- Malformed tool arguments or unknown tool names are validated via Zod schemas and returned as structured errors into the conversation history, allowing the agent to self-correct in the next round.

### Live Progress Events
Rather than a generic spinner, the agent emits real-time Server-Sent Events (SSE) reflecting its active state:
- `"Searching for termination provisions..."`
- `"Found relevant clauses..."`
- `"Checking section 14.2..."`
- `"Verifying citations against canonical text..."`
- `"Preparing answer..."`

### Current Limitations
- Tool execution is currently scoped per document; cross-document agentic chaining across 5+ documents simultaneously is executed via parallel multi-document retrieval rather than arbitrary multi-agent swarms.

---

## 4. What I Would Build Next

1. **Table Extraction & OCR for Scanned Addenda**: Integrate Tesseract or AWS Textract/Google Cloud Document AI for scanned execution signature pages.
2. **Clause Redlining & Export**: Export comparison redlines directly to DOCX with tracked changes (`w:ins` and `w:del`).
3. **Playbook-Based Risk Scoring**: Allow legal teams to define organizational playbooks (e.g., "Flag any liability cap > 1x contract value or governing law outside Delaware").
4. **Vector Database Scaling**: Transition from serialized Prisma storage to `pgvector` with HNSW indexing for multi-tenant repositories containing thousands of contracts.
