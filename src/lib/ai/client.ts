export interface ChatMessageParam {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResponse {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  providerUsed?: string;
}

export interface ProviderEndpoint {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  rateLimitedUntil: number;
}

export class AIUnavailableError extends Error {
  constructor(message = 'AI provider unavailable or rate-limited. Try again shortly.') {
    super(message);
    this.name = 'AIUnavailableError';
  }
}

export class AIClient {
  private providers: Map<string, ProviderEndpoint> = new Map();

  constructor() {
    this.refreshProviders();
  }

  /**
   * Refreshes provider configurations from environment variables.
   * Reads generic AI_API_KEY, AI_BASE_URL, AI_MODEL as the primary provider,
   * while keeping multi-provider cascade options (Gemini, Groq, Hugging Face).
   */
  public refreshProviders(): void {
    const list: ProviderEndpoint[] = [];

    // 1. Primary AI Provider (Generic Assignment Requirement: AI_API_KEY, AI_BASE_URL, AI_MODEL)
    const primaryKey = process.env.AI_API_KEY;
    if (primaryKey && primaryKey.trim() && primaryKey !== 'your-ai-api-key') {
      list.push({
        id: 'primary',
        name: 'Primary AI Provider',
        apiKey: primaryKey.trim(),
        baseUrl: (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
        model: process.env.AI_MODEL || 'gemini-3.8-flash',
        rateLimitedUntil: 0,
      });
    }

    // 2. Google Gemini (OpenAI-compatible endpoint)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey.trim() && geminiKey !== 'your-gemini-api-key' && geminiKey !== primaryKey) {
      list.push({
        id: 'gemini',
        name: 'Google Gemini',
        apiKey: geminiKey.trim(),
        baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
        model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
        rateLimitedUntil: 0,
      });
    }

    // 3. Groq (Ultra-fast Inference)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey.trim() && groqKey !== 'your-groq-api-key' && groqKey !== primaryKey) {
      list.push({
        id: 'groq',
        name: 'Groq Cloud',
        apiKey: groqKey.trim(),
        baseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        rateLimitedUntil: 0,
      });
    }

    // 4. Hugging Face Inference API / Router
    const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    if (hfKey && hfKey.trim() && hfKey !== 'your-huggingface-api-key' && hfKey !== primaryKey) {
      list.push({
        id: 'huggingface',
        name: 'Hugging Face Inference',
        apiKey: hfKey.trim(),
        baseUrl: (process.env.HUGGINGFACE_BASE_URL || 'https://router.huggingface.co/hf-inference/v1').replace(/\/+$/, ''),
        model: process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
        rateLimitedUntil: 0,
      });
    }

    // Order according to AI_PROVIDER_CASCADE if defined (e.g. "primary,gemini,groq,huggingface")
    const cascadeEnv = (process.env.AI_PROVIDER_CASCADE || 'primary,gemini,groq,huggingface')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    list.sort((a, b) => {
      const idxA = cascadeEnv.indexOf(a.id);
      const idxB = cascadeEnv.indexOf(b.id);
      const posA = idxA === -1 ? 999 : idxA;
      const posB = idxB === -1 ? 999 : idxB;
      return posA - posB;
    });

    this.providers.clear();
    for (const p of list) {
      this.providers.set(p.id, p);
    }
  }

  get isConfigured(): boolean {
    this.refreshProviders();
    return this.providers.size > 0;
  }

  /**
   * Returns list of configured providers currently not in a rate-limit cooldown.
   */
  private getCandidateProviders(): ProviderEndpoint[] {
    this.refreshProviders();
    const now = Date.now();
    const available: ProviderEndpoint[] = [];
    for (const p of this.providers.values()) {
      if (p.rateLimitedUntil <= now) {
        available.push(p);
      }
    }
    // If all are in cooldown, reset cooldowns to allow retry
    if (available.length === 0 && this.providers.size > 0) {
      for (const p of this.providers.values()) {
        p.rateLimitedUntil = 0;
        available.push(p);
      }
    }
    return available;
  }

  /**
   * Sends a completion request with automatic cascading failover across configured providers.
   * Uses 60s provider timeout. Never fabricates answers; throws AIUnavailableError if none succeed.
   */
  async createChatCompletion(options: {
    messages: ChatMessageParam[];
    tools?: ToolDefinition[];
    temperature?: number;
    responseFormatJson?: boolean;
    signal?: AbortSignal;
    onProviderChange?: (providerName: string) => void;
  }): Promise<ChatCompletionResponse> {
    const { messages, tools, temperature = 0.1, responseFormatJson, signal, onProviderChange } = options;
    const candidates = this.getCandidateProviders();

    if (candidates.length === 0) {
      throw new AIUnavailableError('No AI provider configured. Please set AI_API_KEY or GEMINI_API_KEY.');
    }

    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of candidates) {
      if (signal?.aborted) {
        throw new Error('Operation aborted');
      }

      try {
        onProviderChange?.(provider.name);

        const payload: Record<string, unknown> = {
          model: provider.model,
          messages,
          temperature,
        };

        if (tools && tools.length > 0) {
          payload.tools = tools;
          payload.tool_choice = 'auto';
        }

        if (responseFormatJson) {
          payload.response_format = { type: 'json_object' };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

        const abortListener = () => controller.abort();
        signal?.addEventListener('abort', abortListener);

        const response = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', abortListener);

        // If rate limit (429), quota (402), or server failure (5xx)
        if (response.status === 429 || response.status === 402 || response.status >= 500) {
          const errBody = await response.text().catch(() => '');
          console.warn(
            `[AI Cascade] Provider "${provider.name}" (${provider.id}) status ${response.status}: ${errBody.slice(0, 120)}. Switching to next model...`
          );
          provider.rateLimitedUntil = Date.now() + 60_000;
          errors.push({ provider: provider.name, error: `HTTP ${response.status}: ${errBody}` });
          continue;
        }

        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          console.warn(`[AI Cascade] Provider "${provider.name}" returned error ${response.status}: ${errBody.slice(0, 100)}`);
          provider.rateLimitedUntil = Date.now() + 60_000;
          errors.push({ provider: provider.name, error: `HTTP ${response.status}: ${errBody}` });
          continue;
        }

        const data = await response.json();
        const choice = data.choices?.[0];

        return {
          content: choice?.message?.content || null,
          tool_calls: choice?.message?.tool_calls,
          providerUsed: provider.name,
        };
      } catch (err: unknown) {
        if (signal?.aborted) {
          throw new Error('Operation aborted');
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[AI Cascade] Failed with provider "${provider.name}": ${msg}. Trying next provider...`);
        provider.rateLimitedUntil = Date.now() + 30_000;
        errors.push({ provider: provider.name, error: msg });
      }
    }

    throw new AIUnavailableError(
      'AI provider unavailable or rate-limited. Try again shortly.'
    );
  }

  /**
   * Real provider streaming using SSE chunks from the active AI provider.
   * Enforces 20s idle-token timeout. Propagates upstream abort immediately.
   * Throws AIUnavailableError if all providers fail; never fabricates fake answers.
   */
  async *streamChatCompletion(options: {
    messages: ChatMessageParam[];
    temperature?: number;
    signal?: AbortSignal;
    onProviderChange?: (providerName: string) => void;
  }): AsyncGenerator<{ text: string; provider?: string }, void, unknown> {
    const { messages, temperature = 0.1, signal, onProviderChange } = options;
    const candidates = this.getCandidateProviders();

    if (candidates.length === 0) {
      throw new AIUnavailableError('No AI provider configured. Please set AI_API_KEY or GEMINI_API_KEY.');
    }

    const errors: string[] = [];

    for (const provider of candidates) {
      if (signal?.aborted) {
        return;
      }

      try {
        onProviderChange?.(provider.name);

        const payload = {
          model: provider.model,
          messages,
          temperature,
          stream: true,
        };

        const internalController = new AbortController();
        const onAbort = () => internalController.abort();
        signal?.addEventListener('abort', onAbort);

        // Idle-token timeout: abort if 20s elapse without receiving a token
        let idleTimer: NodeJS.Timeout | null = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            console.warn(`[AI Stream] Provider "${provider.name}" idle token timeout (20s).`);
            internalController.abort();
          }, 20000);
        };

        resetIdleTimer();

        const response = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: internalController.signal,
        });

        if (response.status === 429 || response.status === 402 || response.status >= 500) {
          if (idleTimer) clearTimeout(idleTimer);
          signal?.removeEventListener('abort', onAbort);
          provider.rateLimitedUntil = Date.now() + 60_000;
          errors.push(`${provider.name} (${response.status})`);
          continue;
        }

        if (!response.ok || !response.body) {
          if (idleTimer) clearTimeout(idleTimer);
          signal?.removeEventListener('abort', onAbort);
          errors.push(`${provider.name} HTTP ${response.status}`);
          continue;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let yieldedTokens = 0;

        try {
          while (true) {
            if (signal?.aborted) {
              await reader.cancel();
              break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            resetIdleTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const jsonStr = trimmed.slice(6);
              if (jsonStr === '[DONE]') {
                if (idleTimer) clearTimeout(idleTimer);
                signal?.removeEventListener('abort', onAbort);
                return;
              }

              try {
                const parsed = JSON.parse(jsonStr);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                  yieldedTokens++;
                  yield { text: delta, provider: provider.name };
                }
              } catch {
                // Ignore incomplete SSE chunk
              }
            }
          }
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
          signal?.removeEventListener('abort', onAbort);
          reader.releaseLock();
        }

        if (yieldedTokens > 0 || signal?.aborted) {
          return;
        }
      } catch (err: unknown) {
        if (signal?.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[AI Stream Cascade] Provider "${provider.name}" stream error: ${msg}`);
        provider.rateLimitedUntil = Date.now() + 30_000;
        errors.push(`${provider.name}: ${msg}`);
      }
    }

    throw new AIUnavailableError(
      'AI provider unavailable or rate-limited. Try again shortly.'
    );
  }
}

export const aiClient = new AIClient();
