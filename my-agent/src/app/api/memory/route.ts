// src/app/api/memory/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { MemoryStore } from '@/lib/memory-store'
import { createEmbeddingProvider } from '@/lib/embedding'

// ─── シングルトン ───
let store: MemoryStore | null = null

function getStore(): MemoryStore {
  if (!store) {
    const connectionString = process.env.PG_CONNECTION_STRING
      || 'postgresql://agent:agent_dev@localhost:5432/agent_memory'
    const embeddingProvider = createEmbeddingProvider()
    store = new MemoryStore(connectionString, embeddingProvider)
  }
  return store
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body
    const s = getStore()

    switch (action) {
      // ─── Health ───
      case 'health': {
        const status = await s.healthCheck()
        return NextResponse.json(status)
      }

      // ─── Chat Texts ───
      case 'saveChatText': {
        const { role, content, tokenEstimate, sessionId } = body
        const id = await s.saveChatText(role, content, tokenEstimate ?? 0, sessionId)
        return NextResponse.json({ id })
      }

      case 'searchChatTexts': {
        const { query, limit, sessionId } = body
        const results = await s.searchChatTexts(query, limit, sessionId)
        return NextResponse.json({ results })
      }

      case 'getRecentChatTexts': {
        const { limit, sessionId } = body
        const chats = await s.getRecentChatTexts(limit, sessionId)
        return NextResponse.json({ chats })
      }

      // ─── Personal Elements ───
      case 'savePersonalElement': {
        const { summary, sourceChatIds, importance } = body
        const id = await s.savePersonalElement(summary, sourceChatIds, importance)
        return NextResponse.json({ id })
      }

      case 'searchPersonalElements': {
        const { query, limit } = body
        const results = await s.searchPersonalElements(query, limit)
        return NextResponse.json({ results })
      }

      case 'getAllPersonalElements': {
        const elements = await s.getAllPersonalElements()
        return NextResponse.json({ elements })
      }

      // ─── Conversation Summaries ───
      case 'saveConversationSummary': {
        const { summary, chatIdFrom, chatIdTo, sessionId } = body
        const id = await s.saveConversationSummary(summary, chatIdFrom, chatIdTo, sessionId)
        return NextResponse.json({ id })
      }

      case 'getLatestSummary': {
        const { sessionId } = body
        const result = await s.getLatestSummary(sessionId)
        return NextResponse.json({ summary: result })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    console.error('[Memory API] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    )
  }
}
