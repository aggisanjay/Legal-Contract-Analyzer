/**
 * Friendly Error Mapping for Serverless Document Processing.
 * Never exposes raw stack traces or Node.js internal errors (e.g. "Require stack") to the user interface.
 */

export interface MappedDocumentError {
  userMessage: string;
  errorDetail: string;
}

export function mapDocumentError(
  err: unknown,
  isScanned = false,
  mimeType = 'application/pdf'
): MappedDocumentError {
  const isError = err instanceof Error;
  const detail = isError ? `${err.name}: ${err.message}\n${err.stack || ''}` : String(err);
  const rawMsg = isError ? err.message : String(err);

  // 1. Scanned or empty PDF / DOCX
  if (isScanned) {
    return {
      userMessage:
        mimeType.includes('pdf') || mimeType === 'application/pdf'
          ? 'This PDF has no readable text (it looks scanned). OCR is not supported yet.'
          : 'This DOCX document contains no readable text. Please upload a document with readable text.',
      errorDetail: detail,
    };
  }

  // 2. Interrupted processing
  if (rawMsg.includes('interrupted') || rawMsg.includes('timed out')) {
    return {
      userMessage: 'Processing was interrupted. Please upload again.',
      errorDetail: detail,
    };
  }

  // 3. File size or payload limit
  if (
    rawMsg.includes('exceeds') ||
    rawMsg.includes('too large') ||
    rawMsg.includes('413') ||
    rawMsg.includes('payload')
  ) {
    return {
      userMessage: 'File size exceeds the allowable limit. Please upload a smaller file.',
      errorDetail: detail,
    };
  }

  // 4. Extraction or parsing errors (fake worker, module loading, require stack, canvas, corrupted)
  // Maps all server extraction failures to the standardized friendly message
  return {
    userMessage: "We couldn't read this file. Try uploading it again, or use a different PDF.",
    errorDetail: detail,
  };
}
