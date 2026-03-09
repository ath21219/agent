// src/lib/embedding.ts

// ─── インターフェース ───
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  readonly dimensions: number
}

// ─── TEI (Text Embeddings Inference) プロバイダー ───
// OpenAI 互換 /v1/embeddings エンドポイントを使用
export class TEIEmbeddingProvider implements EmbeddingProvider {
  private baseURL: string
  private model: string
  readonly dimensions: number

  constructor(opts: { baseURL: string; model: string; dimensions: number }) {
    this.baseURL = opts.baseURL.replace(/\/$/, '')
    this.model = opts.model
    this.dimensions = opts.dimensions
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text])
    return result
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // ruri-v3 は検索文書用プレフィックスを推奨
    // 保存時は "文章: " を付与、検索クエリ時は呼び出し側で "検索クエリ: " を付与
    const response = await fetch(`${this.baseURL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Embedding API error: ${response.status} ${err}`)
    }

    const json = await response.json() as {
      data: { embedding: number[]; index: number }[]
    }

    // index 順にソート
    return json.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding)
  }
}

// ─── API Embedding プロバイダー (OpenAI / Gemini 等) ───
// 将来の差し替え用。TEIEmbeddingProvider と同じインターフェース。
export class APIEmbeddingProvider implements EmbeddingProvider {
  private baseURL: string
  private apiKey: string
  private model: string
  readonly dimensions: number

  constructor(opts: { baseURL: string; apiKey: string; model: string; dimensions: number }) {
    this.baseURL = opts.baseURL.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.dimensions = opts.dimensions
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text])
    return result
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseURL}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Embedding API error: ${response.status} ${err}`)
    }

    const json = await response.json() as {
      data: { embedding: number[]; index: number }[]
    }

    return json.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding)
  }
}

// ─── ファクトリー ───
export function createEmbeddingProvider(): EmbeddingProvider {
  const baseURL = process.env.EMBEDDING_BASE_URL || 'http://localhost:8090'
  const model = process.env.EMBEDDING_MODEL || 'cl-nagoya/ruri-v3-310m'
  const dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10)
  const apiKey = process.env.EMBEDDING_API_KEY || ''

  if (apiKey) {
    return new APIEmbeddingProvider({ baseURL, apiKey, model, dimensions })
  }
  return new TEIEmbeddingProvider({ baseURL, model, dimensions })
}
