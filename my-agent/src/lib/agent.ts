// src/lib/agent.ts

import { generateText } from '@xsai/generate-text'
import { streamText } from '@xsai/stream-text'
import type { VisionSnapshot } from './vision'
import {
  SYSTEM_PROMPT,
  MEMORY_SECTION_PERSONAL,
  MEMORY_SECTION_SUMMARY,
  MEMORY_SECTION_RELATED,
} from './prompts'

// --- 型定義 ---
export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AgentConfig {
  apiKey: string
  baseURL: string
  model: string
  systemPrompt: string
  maxHistoryTokens: number
  storageKey: string
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface MultimodalMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

const IMAGE_TOKENS_NORMAL = 258
const IMAGE_TOKENS_HD = 1032

const SENTENCE_DELIMITERS = /([。！？\!\?\n])/

// --- トークン推定 ---
function estimateTokens(text: string): number {
  let asciiChars = 0
  let nonAsciiChars = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) asciiChars++
    else nonAsciiChars++
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5)
}

function estimateMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 4
  }
  return total
}

// --- localStorage ヘルパー ---
function saveHistory(key: string, messages: Message[]): void {
  try {
    const toSave = messages.filter(m => m.role !== 'system')
    localStorage.setItem(key, JSON.stringify(toSave))
  } catch { /* SSR等では無視 */ }
}

function loadHistory(key: string): Message[] {
  try {
    const stored = localStorage.getItem(key)
    if (stored) {
      const parsed = JSON.parse(stored) as Message[]
      if (Array.isArray(parsed) && parsed.every(m => m.role && m.content)) {
        return parsed
      }
    }
  } catch { /* パース失敗時は空配列 */ }
  return []
}

// --- 感情タグ抽出 ---
function extractEmotion(text: string): { emotion: string; cleanText: string } {
  const match = text.match(/^\[(joy|sad|angry|surprise|neutral)\]\s*/)
  return {
    emotion: match ? match[1] : 'neutral',
    cleanText: match ? text.replace(match[0], '') : text,
  }
}

// --- マルチモーダルメッセージ構築 ---
function buildMultimodalMessages(
  history: Message[],
  vision?: VisionSnapshot,
): MultimodalMessage[] {
  if (!vision || (vision.frames.length === 0 && !vision.internalState)) {
    return history as MultimodalMessage[]
  }

  const msgs: MultimodalMessage[] = history.slice(0, -1) as MultimodalMessage[]
  const lastUser = history[history.length - 1]

  const parts: ContentPart[] = []
  if (vision.internalState) {
    parts.push({ type: 'text', text: vision.internalState })
  }
  const labelMap: Record<string, string> = {
    camera: '【ユーザーのカメラ映像】',
    screen: '【ユーザーの画面】',
    'vrm-mirror': '【あなた自身の今の姿（鏡）】',
  }
  for (const frame of vision.frames) {
    parts.push({ type: 'text', text: labelMap[frame.label] || `【${frame.label}】` })
    parts.push({ type: 'image_url', image_url: { url: frame.dataUrl } })
  }
  parts.push({ type: 'text', text: lastUser.content })
  msgs.push({ role: 'user', content: parts })
  return msgs
}

// ─── 記憶層ヘルパー ───
async function memoryFetch(action: string, params: Record<string, unknown> = {}): Promise<any> {
  try {
    const res = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchMemoryContext(userText: string): Promise<string> {
  const parts: string[] = []

  // 1. パーソナル要素
  const elemResult = await memoryFetch('searchPersonalElements', {
    query: userText,
    limit: 5,
  })
  if (elemResult?.results?.length > 0) {
    const facts = elemResult.results
      .filter((r: any) => r.distance < 0.5)
      .map((r: any) => `- ${r.item.summary}（重要度: ${r.item.importance}）`)
      .join('\n')
    if (facts) {
      parts.push(`${MEMORY_SECTION_PERSONAL}\n${facts}`)
    }
  }

  // 2. 直近の会話要約
  const summaryResult = await memoryFetch('getLatestSummary', {})
  if (summaryResult?.summary) {
    parts.push(`${MEMORY_SECTION_SUMMARY}\n${summaryResult.summary.summary}`)
  }

  // 3. 関連する過去の会話
  const chatResult = await memoryFetch('searchChatTexts', {
    query: userText,
    limit: 3,
  })
  if (chatResult?.results?.length > 0) {
    const relevant = chatResult.results
      .filter((r: any) => r.distance < 0.4)
      .map((r: any) => `${r.item.role}: ${r.item.content}`)
      .join('\n')
    if (relevant) {
      parts.push(`${MEMORY_SECTION_RELATED}\n${relevant}`)
    }
  }

  return parts.join('\n\n')
}

async function saveToMemory(
  role: 'user' | 'assistant',
  content: string,
  tokenEstimate: number,
): Promise<void> {
  await memoryFetch('saveChatText', { role, content, tokenEstimate })
}

// === エージェントファクトリー ===
export function createAgent(config: Partial<AgentConfig> = {}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'

  const agentConfig: AgentConfig = {
    apiKey: config.apiKey || 'proxy',
    baseURL: config.baseURL || `${origin}/api/llm`,
    model: config.model || process.env.LLM_MODEL || '',
    systemPrompt: config.systemPrompt || SYSTEM_PROMPT,
    maxHistoryTokens: config.maxHistoryTokens || 8000,
    storageKey: config.storageKey || 'agent-history',
  }

  const restoredHistory = loadHistory(agentConfig.storageKey)
  let conversationHistory: Message[] = [
    { role: 'system', content: agentConfig.systemPrompt },
    ...restoredHistory,
  ]

  if (restoredHistory.length > 0) {
    console.log(`[Agent] Restored ${restoredHistory.length} messages from localStorage`)
  }

  // ─── Fact 抽出カウンター ───
  let turnsSinceExtraction = 0
  const EXTRACTION_INTERVAL = 10

  // --- 要約付きトリミング ---
  function trimHistoryWithSummary(
    messages: Message[],
    maxTokens: number,
    systemPrompt: string,
  ): Message[] {
    const systemMsg: Message = { role: 'system', content: systemPrompt }
    const systemTokens = estimateTokens(systemPrompt) + 4

    const history = messages.filter(m => m.role !== 'system')
    let totalTokens = systemTokens + estimateMessagesTokens(history)

    if (totalTokens <= maxTokens) {
      return [systemMsg, ...history]
    }

    const toRemove: Message[] = []
    const trimmed = [...history]
    while (totalTokens > maxTokens && trimmed.length > 4) {
      const removed = trimmed.shift()!
      toRemove.push(removed)
      totalTokens -= estimateTokens(removed.content) + 4
    }

    // 削除対象を要約して保存（非ブロッキング）
    if (toRemove.length >= 4) {
      const toSummarize = toRemove.map(m => ({
        role: m.role,
        content: m.content,
      }))
      memoryFetch('summarizeAndTrim', {
        messages: toSummarize,
        chatIdFrom: 0,
        chatIdTo: 0,
      }).catch(err => console.warn('[Agent] Summary save failed:', err))
    }

    console.log(
      `[Agent] History trimmed: ${history.length} → ${trimmed.length} messages ` +
      `(≈${totalTokens} tokens, ${toRemove.length} messages summarized)`
    )
    return [systemMsg, ...trimmed]
  }

  // --- 非ストリーミング版 ---
  async function chat(userMessage: string): Promise<{ text: string; emotion: string }> {
    conversationHistory.push({ role: 'user', content: userMessage })

    conversationHistory = trimHistoryWithSummary(
      conversationHistory, agentConfig.maxHistoryTokens, agentConfig.systemPrompt
    )

    const { text } = await generateText({
      apiKey: agentConfig.apiKey,
      baseURL: agentConfig.baseURL,
      model: agentConfig.model,
      messages: conversationHistory,
    })

    const { emotion, cleanText } = extractEmotion(text || '')
    conversationHistory.push({ role: 'assistant', content: cleanText })

    saveHistory(agentConfig.storageKey, conversationHistory)

    return { text: cleanText, emotion }
  }

  // --- ストリーミング + 文単位チャンキング ---
  async function chatStreamSentences(
    userText: string,
    onSentence: (sentence: string, emotion: string, isFirst: boolean) => void,
    onComplete: (fullText: string) => void,
    options?: { vision?: VisionSnapshot },
  ): Promise<void> {
    conversationHistory.push({ role: 'user', content: userText })

    conversationHistory = trimHistoryWithSummary(
      conversationHistory, agentConfig.maxHistoryTokens, agentConfig.systemPrompt
    )

    // 記憶コンテキスト取得 → システムプロンプトに注入
    let systemPromptWithMemory = agentConfig.systemPrompt
    try {
      const memoryContext = await fetchMemoryContext(userText)
      if (memoryContext) {
        systemPromptWithMemory = agentConfig.systemPrompt + '\n\n' + memoryContext
        conversationHistory[0] = { role: 'system', content: systemPromptWithMemory }
      }
    } catch (err) {
      console.warn('[Agent] Memory context fetch failed, continuing without:', err)
    }

    const messagesForLLM = buildMultimodalMessages(
      conversationHistory,
      options?.vision,
    )

    const { textStream } = await streamText({
      apiKey: agentConfig.apiKey,
      baseURL: agentConfig.baseURL,
      model: agentConfig.model,
      messages: messagesForLLM as Parameters<typeof streamText>[0]['messages'],
    })

    const reader = textStream.getReader()
    let buffer = ''
    let fullText = ''
    let emotion = 'neutral'
    let emotionExtracted = false
    let sentenceIndex = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += value
      fullText += value

      if (!emotionExtracted && buffer.includes(']')) {
        const { emotion: e, cleanText } = extractEmotion(buffer)
        emotion = e
        buffer = cleanText
        emotionExtracted = true
      }

      while (true) {
        const match = buffer.match(SENTENCE_DELIMITERS)
        if (!match || match.index === undefined) break

        const sentenceEnd = match.index + match[0].length
        const sentence = buffer.slice(0, sentenceEnd).trim()
        buffer = buffer.slice(sentenceEnd)

        if (sentence.length > 0) {
          onSentence(sentence, emotion, sentenceIndex === 0)
          sentenceIndex++
        }
      }
    }

    const remaining = emotionExtracted ? buffer.trim() : extractEmotion(buffer).cleanText.trim()
    if (!emotionExtracted) {
      emotion = extractEmotion(buffer).emotion
    }
    if (remaining.length > 0) {
      onSentence(remaining, emotion, sentenceIndex === 0)
    }

    const { cleanText: finalClean } = extractEmotion(fullText)
    conversationHistory.push({ role: 'assistant', content: finalClean })

    // システムプロンプトを元に戻す
    conversationHistory[0] = { role: 'system', content: agentConfig.systemPrompt }

    saveHistory(agentConfig.storageKey, conversationHistory)

    // 記憶層への保存
    const userTokens = estimateTokens(userText)
    const assistantTokens = estimateTokens(finalClean)
    saveToMemory('user', userText, userTokens).catch(err =>
      console.warn('[Agent] Memory save (user) failed:', err)
    )
    saveToMemory('assistant', finalClean, assistantTokens).catch(err =>
      console.warn('[Agent] Memory save (assistant) failed:', err)
    )

    // ─── Fact 抽出トリガー（10ターンごと）───
    turnsSinceExtraction++
    if (turnsSinceExtraction >= EXTRACTION_INTERVAL) {
      turnsSinceExtraction = 0
      const recent = conversationHistory
        .filter(m => m.role !== 'system')
        .slice(-20)
        .map(m => ({ role: m.role, content: m.content }))

      memoryFetch('extractAndSaveFacts', { recentMessages: recent })
        .then(result => {
          if (result?.facts?.length > 0) {
            console.log(`[Agent] Extracted ${result.facts.length} new facts`)
          }
        })
        .catch(err => console.warn('[Agent] Fact extraction failed:', err))
    }

    onComplete(finalClean)
  }

  function getHistory(): Message[] {
    return [...conversationHistory]
  }

  function getDisplayHistory(): { role: string; text: string }[] {
    return conversationHistory
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, text: m.content }))
  }

  function clearHistory(): void {
    conversationHistory = [
      { role: 'system', content: agentConfig.systemPrompt },
    ]
    saveHistory(agentConfig.storageKey, conversationHistory)
    console.log('[Agent] History cleared')
  }

  function getEstimatedTokens(): number {
    return estimateMessagesTokens(conversationHistory)
  }

  return {
    chat,
    chatStreamSentences,
    getHistory,
    getDisplayHistory,
    clearHistory,
    getEstimatedTokens,
  }
}
