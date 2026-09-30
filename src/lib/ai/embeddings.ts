export interface EmbeddingProvider {
  name: string;
  generateEmbedding(text: string): Promise<number[]>;
  generateBatchEmbeddings(texts: string[]): Promise<number[][]>;
}

/**
 * Fast, deterministic local vectorizer based on subword hashing and term frequency.
 * Produces 128-dimensional normalized dense vectors.
 * Ensures zero-configuration retrieval that works completely offline or when no remote embedding API is specified.
 */
export class FastLocalVectorProvider implements EmbeddingProvider {
  name = 'fast-local-vector';
  private dimension = 128;

  async generateEmbedding(text: string): Promise<number[]> {
    return this.vectorize(text);
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorize(t));
  }

  private vectorize(text: string): number[] {
    const vector = new Array(this.dimension).fill(0);
    if (!text || text.trim().length === 0) {
      return vector;
    }

    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length === 0) return vector;

    for (const word of words) {
      // Primary hash
      const h1 = this.hash(word) % this.dimension;
      vector[Math.abs(h1)] += 1.0;

      // Subword bigrams for partial / legal stems
      for (let i = 0; i < word.length - 2; i++) {
        const sub = word.slice(i, i + 3);
        const h2 = this.hash(sub) % this.dimension;
        vector[Math.abs(h2)] += 0.35;
      }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < this.dimension; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimension; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  private hash(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return hash;
  }
}

/**
 * Remote OpenAI-compatible Embeddings Provider.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name = 'openai-compatible';
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private fallback: FastLocalVectorProvider;

  constructor(apiKey: string, baseUrl: string, model = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.fallback = new FastLocalVectorProvider();
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const batch = await this.generateBatchEmbeddings([text]);
    return batch[0];
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey || this.apiKey === 'your-api-key-here') {
      return this.fallback.generateBatchEmbeddings(texts);
    }

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      });

      if (!response.ok) {
        console.warn(`Embeddings API error (${response.status}), falling back to local vectorizer`);
        return this.fallback.generateBatchEmbeddings(texts);
      }

      const data = await response.json();
      if (Array.isArray(data.data)) {
        return data.data.map((item: { embedding: number[] }) => item.embedding);
      }
      return this.fallback.generateBatchEmbeddings(texts);
    } catch (err) {
      console.warn('Embeddings request failed, falling back to local vectorizer', err);
      return this.fallback.generateBatchEmbeddings(texts);
    }
  }
}

/**
 * Calculates cosine similarity between two dense vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Get the active default embedding provider based on environment variables.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.AI_EMBEDDING_MODEL || 'text-embedding-3-small';

  if (apiKey && apiKey !== 'your-api-key-here' && process.env.USE_REMOTE_EMBEDDINGS === 'true') {
    return new OpenAIEmbeddingProvider(apiKey, baseUrl, model);
  }

  return new FastLocalVectorProvider();
}
