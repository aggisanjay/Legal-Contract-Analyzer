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

export class AIClient {
  private providers: Map<string, ProviderEndpoint> = new Map();

  constructor() {
    this.refreshProviders();
  }

  /**
   * Refreshes provider configurations from environment variables.
   */
  public refreshProviders(): void {
    const list: ProviderEndpoint[] = [];

    // 1. Google Gemini (OpenAI-compatible endpoint)
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey.trim() && geminiKey !== 'your-gemini-api-key') {
      list.push({
        id: 'gemini',
        name: 'Google Gemini',
        apiKey: geminiKey.trim(),
        baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        rateLimitedUntil: 0,
      });
    }

    // 2. Groq (Ultra-fast Inference)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey.trim() && groqKey !== 'your-groq-api-key') {
      list.push({
        id: 'groq',
        name: 'Groq Cloud',
        apiKey: groqKey.trim(),
        baseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        rateLimitedUntil: 0,
      });
    }

    // 3. Hugging Face Inference API / Router
    const hfKey = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN;
    if (hfKey && hfKey.trim() && hfKey !== 'your-huggingface-api-key') {
      list.push({
        id: 'huggingface',
        name: 'Hugging Face Inference',
        apiKey: hfKey.trim(),
        baseUrl: (process.env.HUGGINGFACE_BASE_URL || 'https://router.huggingface.co/hf-inference/v1').replace(/\/+$/, ''),
        model: process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
        rateLimitedUntil: 0,
      });
    }

    // Order according to AI_PROVIDER_CASCADE if defined (e.g. "gemini,groq,huggingface")
    const cascadeEnv = (process.env.AI_PROVIDER_CASCADE || 'gemini,groq,huggingface')
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
   * Sends a completion request with automatic cascading failover across Gemini, Groq, Hugging Face, etc.
   */
  async createChatCompletion(options: {
    messages: ChatMessageParam[];
    tools?: ToolDefinition[];
    temperature?: number;
    responseFormatJson?: boolean;
    onProviderChange?: (providerName: string) => void;
  }): Promise<ChatCompletionResponse> {
    const { messages, tools, temperature = 0.1, responseFormatJson, onProviderChange } = options;
    const candidates = this.getCandidateProviders();

    if (candidates.length === 0) {
      return this.generateSimulatedCompletion(messages, tools);
    }

    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of candidates) {
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
        const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout per provider

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

        // If rate limit (429) or quota or server failure (5xx)
        if (response.status === 429 || response.status === 402 || response.status >= 500) {
          const errBody = await response.text().catch(() => '');
          console.warn(
            `[AI Cascade] Provider "${provider.name}" (${provider.id}) rate limit / error ${response.status}: ${errBody.slice(0, 120)}. Switching to next model...`
          );
          // Set 60-second cooldown for this provider
          provider.rateLimitedUntil = Date.now() + 60_000;
          errors.push({ provider: provider.name, error: `HTTP ${response.status}: ${errBody}` });
          continue; // Try next candidate provider!
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
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[AI Cascade] Failed with provider "${provider.name}": ${msg}. Trying next provider...`);
        provider.rateLimitedUntil = Date.now() + 30_000;
        errors.push({ provider: provider.name, error: msg });
      }
    }

    console.warn('[AI Cascade] All configured external AI providers failed or were rate limited. Falling back to internal legal intelligence synthesizer.');
    return this.generateSimulatedCompletion(messages, tools);
  }

  /**
   * Streams chat completions with automatic failover to another model if rate limit occurs before streaming.
   */
  async *streamChatCompletion(options: {
    messages: ChatMessageParam[];
    temperature?: number;
    onProviderChange?: (providerName: string) => void;
  }): AsyncGenerator<{ text: string; provider?: string }, void, unknown> {
    const { messages, temperature = 0.1, onProviderChange } = options;
    const candidates = this.getCandidateProviders();

    if (candidates.length === 0) {
      const sim = await this.generateSimulatedCompletion(messages);
      const words = (sim.content || '').split(' ');
      for (const word of words) {
        yield { text: word + ' ', provider: 'Local Legal Synthesizer' };
        await new Promise((r) => setTimeout(r, 20));
      }
      return;
    }

    for (const provider of candidates) {
      try {
        onProviderChange?.(provider.name);

        const payload = {
          model: provider.model,
          messages,
          temperature,
          stream: true,
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

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

        // Check for rate limit or server error
        if (response.status === 429 || response.status === 402 || response.status >= 500) {
          const errBody = await response.text().catch(() => '');
          console.warn(`[AI Stream Cascade] Provider "${provider.name}" rate limited (${response.status}). Switching to next provider...`);
          provider.rateLimitedUntil = Date.now() + 60_000;
          continue; // Try next provider!
        }

        if (!response.ok || !response.body) {
          continue;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let yieldedTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') return;

            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                yieldedTokens++;
                yield { text: delta, provider: provider.name };
              }
            } catch {
              // Ignore partial frame
            }
          }
        }

        // If we successfully streamed tokens, stop and return
        if (yieldedTokens > 0) {
          return;
        }
      } catch (err) {
        console.warn(`[AI Stream Cascade] Provider "${provider.name}" stream error:`, err);
        provider.rateLimitedUntil = Date.now() + 30_000;
      }
    }

    // Fallback if all streams failed
    const sim = await this.generateSimulatedCompletion(messages);
    const words = (sim.content || '').split(' ');
    for (const word of words) {
      yield { text: word + ' ', provider: 'Local Legal Synthesizer' };
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Deterministic local fallback generator when all external providers are exhausted or unconfigured.
   */
  private async generateSimulatedCompletion(
    messages: ChatMessageParam[],
    tools?: ToolDefinition[]
  ): Promise<ChatCompletionResponse> {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const query = lastUserMessage.toLowerCase();

    const hasToolResults = messages.some((m) => m.role === 'tool');
    if (tools && tools.length > 0 && !hasToolResults) {
      if (query.includes('terminat')) {
        return {
          content: null,
          tool_calls: [
            {
              id: 'call_search_1',
              type: 'function',
              function: {
                name: 'search_document',
                arguments: JSON.stringify({ query: 'termination convenience notice', topK: 3 }),
              },
            },
          ],
          providerUsed: 'Local Fallback Engine',
        };
      }
      if (query.includes('liabilit') || query.includes('cap')) {
        return {
          content: null,
          tool_calls: [
            {
              id: 'call_search_2',
              type: 'function',
              function: {
                name: 'search_document',
                arguments: JSON.stringify({ query: 'limitation aggregate liability cap', topK: 3 }),
              },
            },
          ],
          providerUsed: 'Local Fallback Engine',
        };
      }
      if (query.includes('govern') || query.includes('law') || query.includes('jurisdiction')) {
        return {
          content: null,
          tool_calls: [
            {
              id: 'call_search_3',
              type: 'function',
              function: {
                name: 'search_document',
                arguments: JSON.stringify({ query: 'governing law jurisdiction', topK: 3 }),
              },
            },
          ],
          providerUsed: 'Local Fallback Engine',
        };
      }
      return {
        content: null,
        tool_calls: [
          {
            id: 'call_list_1',
            type: 'function',
            function: {
              name: 'list_clauses',
              arguments: JSON.stringify({}),
            },
          },
        ],
        providerUsed: 'Local Fallback Engine',
      };
    }

    let evidenceText = '';
    for (const msg of messages) {
      if (msg.role === 'tool' || msg.content.includes('EVIDENCE:')) {
        evidenceText += `\n${msg.content}`;
      }
    }

    const lines = evidenceText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 20);

    let candidateQuote = '';
    let answerText = '';

    for (const line of lines) {
      if (query.includes('liabilit') && /liability|aggregate|exceed/i.test(line)) {
        candidateQuote = line.replace(/^["'\s]+|["'\s]+$/g, '');
        answerText = `Based on the contract provisions, the parties have established specific limitation of liability terms. Specifically: "${candidateQuote}".`;
        break;
      }
      if (query.includes('terminat') && /terminat|convenience|notice|days/i.test(line)) {
        candidateQuote = line.replace(/^["'\s]+|["'\s]+$/g, '');
        answerText = `Under the termination provisions of this agreement: "${candidateQuote}".`;
        break;
      }
      if ((query.includes('govern') || query.includes('law')) && /governed|laws|jurisdiction/i.test(line)) {
        candidateQuote = line.replace(/^["'\s]+|["'\s]+$/g, '');
        answerText = `According to the governing law section of the agreement: "${candidateQuote}".`;
        break;
      }
    }

    if (!candidateQuote && lines.length > 0) {
      candidateQuote = lines[0].replace(/^["'\s]+|["'\s]+$/g, '');
      answerText = `The relevant contract terms indicate: "${candidateQuote}".`;
    }

    if (!candidateQuote) {
      return {
        content: JSON.stringify({
          answer: "I couldn't find sufficient evidence in the uploaded contract to answer this reliably.",
          citations: [],
        }),
        providerUsed: 'Local Fallback Engine',
      };
    }

    return {
      content: JSON.stringify({
        answer: answerText,
        citations: [
          {
            quote: candidateQuote,
          },
        ],
      }),
      providerUsed: 'Local Fallback Engine',
    };
  }
}

export const aiClient = new AIClient();
