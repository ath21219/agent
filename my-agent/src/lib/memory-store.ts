// src/lib/memory-store.ts

import pg from 'pg'
import pgvector from 'pgvector/pg'
import type { EmbeddingProvider } from './embedding'

const { Pool } = pg

// ─── 型定義 ───
export interface ChatText {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tokenEstimate: number
  createdAt: Date
}

export interface PersonalElement {
  id: number
  summary: string
  importance: number
  sourceChatIds: number[]
  createdAt: Date
  updatedAt: Date
}

export interface ConversationSummary {
  id: number
  sessionId: string
  summary: string
  chatIdFrom: number
  chatIdTo: number
  createdAt: Date
}

export interface SearchResult<T> {
  item: T
  distance: number
}

// ─── MemoryStore ───
export class MemoryStore {
  private pool: pg.Pool
  private embedding: EmbeddingProvider
  private initialized = false

  constructor(connectionString: string, embeddingProvider: EmbeddingProvider) {
    this.pool = new Pool({ connectionString })
    this.embedding = embeddingProvider
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const client = await this.pool.connect()
    try {
      await pgvector.registerTypes(client)
      this.initialized = true
      console.log('[MemoryStore] Initialized')
    } finally {
      client.release()
    }

    // プール接続時に自動登録
    this.pool.on('connect', async (client) => {
      await pgvector.registerTypes(client)
    })
  }

  // ─── Chat Texts ───

  async saveChatText(
    role: 'user' | 'assistant',
    content: string,
    tokenEstimate: number,
    sessionId = 'default',
  ): Promise<number> {
    await this.initialize()

    // ruri-v3: 保存テキストには "文章: " プレフィックス
    const vec = await this.embedding.embed(`文章: ${content}`)

    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO chat_texts (session_id, role, content, token_estimate, embedding)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [sessionId, role, content, tokenEstimate, pgvector.toSql(vec)],
    )
    return result.rows[0].id
  }

  async searchChatTexts(
    query: string,
    limit = 5,
    sessionId = 'default',
  ): Promise<SearchResult<ChatText>[]> {
    await this.initialize()

    // ruri-v3: 検索クエリには "検索クエリ: " プレフィックス
    const vec = await this.embedding.embed(`検索クエリ: ${query}`)

    const result = await this.pool.query(
      `SELECT id, session_id, role, content, token_estimate, created_at,
              embedding <=> $1 AS distance
       FROM chat_texts
       WHERE session_id = $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [pgvector.toSql(vec), sessionId, limit],
    )

    return result.rows.map(row => ({
      item: {
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        tokenEstimate: row.token_estimate,
        createdAt: row.created_at,
      },
      distance: row.distance,
    }))
  }

  async getRecentChatTexts(
    limit = 20,
    sessionId = 'default',
  ): Promise<ChatText[]> {
    await this.initialize()

    const result = await this.pool.query(
      `SELECT id, session_id, role, content, token_estimate, created_at
       FROM chat_texts
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, limit],
    )

    return result.rows
      .map(row => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        tokenEstimate: row.token_estimate,
        createdAt: row.created_at,
      }))
      .reverse() // 古い順に返す
  }

  // ─── Personal Elements ───

  async savePersonalElement(
    summary: string,
    sourceChatIds: number[],
    importance = 0.5,
  ): Promise<number> {
    await this.initialize()

    const vec = await this.embedding.embed(`文章: ${summary}`)

    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO personal_elements (summary, importance, embedding, source_chat_ids)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [summary, importance, pgvector.toSql(vec), sourceChatIds],
    )
    return result.rows[0].id
  }

  async searchPersonalElements(
    query: string,
    limit = 5,
  ): Promise<SearchResult<PersonalElement>[]> {
    await this.initialize()

    const vec = await this.embedding.embed(`検索クエリ: ${query}`)

    const result = await this.pool.query(
      `SELECT id, summary, importance, source_chat_ids, created_at, updated_at,
              embedding <=> $1 AS distance
       FROM personal_elements
       ORDER BY embedding <=> $1
       LIMIT $2`,
      [pgvector.toSql(vec), limit],
    )

    return result.rows.map(row => ({
      item: {
        id: row.id,
        summary: row.summary,
        importance: row.importance,
        sourceChatIds: row.source_chat_ids,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      distance: row.distance,
    }))
  }

  async getAllPersonalElements(): Promise<PersonalElement[]> {
    await this.initialize()

    const result = await this.pool.query(
      `SELECT id, summary, importance, source_chat_ids, created_at, updated_at
       FROM personal_elements
       ORDER BY importance DESC, updated_at DESC`,
    )

    return result.rows.map(row => ({
      id: row.id,
      summary: row.summary,
      importance: row.importance,
      sourceChatIds: row.source_chat_ids,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  // ─── Conversation Summaries ───

  async saveConversationSummary(
    summary: string,
    chatIdFrom: number,
    chatIdTo: number,
    sessionId = 'default',
  ): Promise<number> {
    await this.initialize()

    const vec = await this.embedding.embed(`文章: ${summary}`)

    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO conversation_summaries (session_id, summary, chat_id_from, chat_id_to, embedding)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [sessionId, summary, chatIdFrom, chatIdTo, pgvector.toSql(vec)],
    )
    return result.rows[0].id
  }

  async getLatestSummary(sessionId = 'default'): Promise<ConversationSummary | null> {
    await this.initialize()

    const result = await this.pool.query(
      `SELECT id, session_id, summary, chat_id_from, chat_id_to, created_at
       FROM conversation_summaries
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionId],
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0]
    return {
      id: row.id,
      sessionId: row.session_id,
      summary: row.summary,
      chatIdFrom: row.chat_id_from,
      chatIdTo: row.chat_id_to,
      createdAt: row.created_at,
    }
  }

  // ─── ヘルスチェック ───

  async healthCheck(): Promise<{ db: boolean; embedding: boolean }> {
    let db = false
    let emb = false

    try {
      await this.pool.query('SELECT 1')
      db = true
    } catch { /* skip */ }

    try {
      const vec = await this.embedding.embed('test')
      emb = vec.length > 0
    } catch { /* skip */ }

    return { db, embedding: emb }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
