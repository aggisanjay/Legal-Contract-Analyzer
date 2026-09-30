export const MACHINE_DELIMITER = '<<<QUOTES>>>';
export const LEGACY_DELIMITER = '---QUOTES---';

/**
 * Strips preamble boilerplate like "The governing law is clearly stated in the contract.\n\n---\n\n"
 * or lone "---" lines from the visible answer prose.
 */
export function cleanAnswerPreambleAndSeparators(text: string): string {
  let cleaned = text;

  // Strip conversational preamble lines (e.g. "The governing law is clearly stated in the contract.")
  cleaned = cleaned.replace(/^(?:The\s+[^.\n]+\s+is\s+clearly\s+stated\s+in\s+the\s+contract\.\s*(?:\r?\n+)?)/i, '');
  cleaned = cleaned.replace(/^(?:Based\s+on\s+(?:a\s+thorough\s+review\s+of\s+)?the\s+contract\s*(?:provided)?,?\s*(?:\r?\n+)?)/i, '');
  cleaned = cleaned.replace(/^(?:According\s+to\s+the\s+provided\s+contract,?\s*(?:\r?\n+)?)/i, '');

  // Strip lone "---" or "---QUOTES---" or "<<<QUOTES>>>" lines
  cleaned = cleaned
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== '---' &&
        trimmed !== '----' &&
        trimmed !== '-----' &&
        trimmed !== LEGACY_DELIMITER &&
        trimmed !== MACHINE_DELIMITER
      );
    })
    .join('\n');

  return cleaned.trim();
}

/**
 * Parser for handling real LLM streaming with delimiter filtering.
 * Ensures no delimiter or trailing candidate JSON tokens leak into the user's visible prose.
 */
export class StreamQuoteDelimiterParser {
  private buffer = '';
  private passedDelimiter = false;
  private quotesBuffer = '';
  private proseBuffer = '';

  constructor(private onProseToken?: (token: string) => void) {}

  public feed(chunk: string) {
    if (this.passedDelimiter) {
      this.quotesBuffer += chunk;
      return;
    }

    this.buffer += chunk;

    // Check for unambiguous machine delimiter first, then legacy delimiter
    let delimIdx = this.buffer.indexOf(MACHINE_DELIMITER);
    let delimLen = MACHINE_DELIMITER.length;
    if (delimIdx === -1) {
      delimIdx = this.buffer.indexOf(LEGACY_DELIMITER);
      delimLen = LEGACY_DELIMITER.length;
    }

    if (delimIdx !== -1) {
      this.passedDelimiter = true;
      const prosePart = this.buffer.slice(0, delimIdx);
      this.emitProse(prosePart);
      this.quotesBuffer = this.buffer.slice(delimIdx + delimLen);
      this.buffer = '';
      return;
    }

    // Guard against partial delimiters split across streaming chunks (e.g. "\n<", "\n-")
    const potentialPrefix = this.buffer.match(/(\r?\n[<-][<-A-Z]*)$/);
    if (potentialPrefix) {
      const safeLen = this.buffer.length - potentialPrefix[0].length;
      if (safeLen > 0) {
        const safeText = this.buffer.slice(0, safeLen);
        this.emitProse(safeText);
        this.buffer = this.buffer.slice(safeLen);
      }
    } else {
      this.emitProse(this.buffer);
      this.buffer = '';
    }
  }

  public flush(): { prose: string; quotesJson: string } {
    if (!this.passedDelimiter && this.buffer.length > 0) {
      this.emitProse(this.buffer);
      this.buffer = '';
    }
    const cleanProse = cleanAnswerPreambleAndSeparators(this.proseBuffer);
    return {
      prose: cleanProse,
      quotesJson: this.quotesBuffer,
    };
  }

  private emitProse(rawToken: string) {
    if (!rawToken) return;
    // Filter out lone "---" lines from stream output
    const lines = rawToken.split(/\r?\n/);
    const filtered = lines
      .filter((l) => {
        const trimmed = l.trim();
        return (
          trimmed !== '---' &&
          trimmed !== '----' &&
          trimmed !== MACHINE_DELIMITER &&
          trimmed !== LEGACY_DELIMITER
        );
      })
      .join('\n');

    if (filtered.length > 0) {
      this.proseBuffer += filtered;
      this.onProseToken?.(filtered);
    }
  }
}
