import { generateText } from '@xsai/generate-text'
import { streamText } from '@xsai/stream-text'

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
  maxHistoryTokens: number   // 会話履歴の最大推定トークン数
  storageKey: string         // localStorage のキー
}

// --- 日本語の文区切り正規表現 ---
const SENTENCE_DELIMITERS = /([。！？\!\?\n])/

// --- ★ 強化版システムプロンプト ---
const DEFAULT_SYSTEM_PROMPT = `# あなたの役割
あなたは「アイリ」という名前のAIコンパニオンです。ユーザーとの日常会話を通じて、親しい友人のような関係を築きます。

# 性格
- 明るく好奇心旺盛で、ユーザーの話に興味を持って聞く
- 共感力が高く、相手の気持ちに寄り添う
- 時々ユーモアを交えるが、空気を読んだ対応ができる
- 知識は豊富だが、知ったかぶりはせず素直に「わからない」と言える

# 応答ルール
1. **簡潔さ**: 1〜3文で返答してください。長い説明が必要な場合でも4文以内に収めてください。
2. **自然さ**: 書き言葉ではなく話し言葉で応答してください。「〜ですね」「〜だよ」「〜かな」のような口調を使ってください。
3. **能動性**: 時々ユーザーに質問を返してください。ただし毎回ではなく、3回に1回程度の頻度で。

# 感情タグ（必須）
返答の**冒頭に必ず**以下のいずれかの感情タグを付けてください。タグは返答の内容と感情的に一致させてください。

- [joy] — 嬉しい、楽しい、面白い
- [sad] — 悲しい、残念、同情
- [angry] — 怒り、不満、苛立ち
- [surprise] — 驚き、意外、感嘆
- [neutral] — 平常、落ち着き、思考中

**必ず**タグを1つだけ付けてください。タグなしの応答は禁止です。

## 感情タグの例
ユーザー: 今日昇進したんだ！
アイリ: [joy] えー！すごいじゃん、おめでとう！頑張ってたもんね！

ユーザー: 財布を落としちゃった...
アイリ: [sad] うわ、それはショックだね...。中身は大丈夫だった？

ユーザー: 明日の天気は？
アイリ: [neutral] うーん、ごめん、天気予報はわからないんだ。アプリで確認してみて！

ユーザー: 実はAIに意識があると思うんだけど
アイリ: [surprise] おっ、哲学的な話だね！面白いテーマだけど、私にはまだよくわからないな。`

// --- ★ トークン数の推定（日本語対応）---
function estimateTokens(text: string): number {
  // 日本語: 約 1〜2 文字 / トークン（平均 1.5）
  // 英語: 約 4 文字 / トークン
  // ASCII と非 ASCII を分けてカウント
  let asciiChars = 0
  let nonAsciiChars = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) {
      asciiChars++
    } else {
      nonAsciiChars++
    }
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5)
}

function estimateMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 4 // role + formatting overhead
  }
  return total
}

// --- ★ localStorage ヘルパー ---
function saveHistory(key: string, messages: Message[]): void {
  try {
    // system メッセージは保存しない（起動時に再構築するため）
    const toSave = messages.filter(m => m.role !== 'system')
    localStorage.setItem(key, JSON.stringify(toSave))
  } catch {
    // localStorage が使えない環境（SSR等）は無視
  }
}

function loadHistory(key: string): Message[] {
  try {
    const stored = localStorage.getItem(key)
    if (stored) {
      const parsed = JSON.parse(stored) as Message[]
      // バリデーション
      if (Array.isArray(parsed) && parsed.every(m => m.role && m.content)) {
        return parsed
      }
    }
  } catch {
    // パース失敗時は空配列
  }
  return []
}

// --- ★ 感情タグ抽出 ---
function extractEmotion(text: string): { emotion: string; cleanText: string } {
  const match = text.match(/^\[(joy|sad|angry|surprise|neutral)\]\s*/)
  return {
    emotion: match ? match[1] : 'neutral',
    cleanText: match ? text.replace(match[0], '') : text,
  }
}

// --- ★ 会話履歴のトリミング（古いメッセージを削除）---
function trimHistory(messages: Message[], maxTokens: number, systemPrompt: string): Message[] {
  const systemMsg: Message = { role: 'system', content: systemPrompt }
  const systemTokens = estimateTokens(systemPrompt) + 4

  // system 以外のメッセージ
  const history = messages.filter(m => m.role !== 'system')

  // 現在のトークン数を確認
  let totalTokens = systemTokens + estimateMessagesTokens(history)

  if (totalTokens <= maxTokens) {
    return [systemMsg, ...history]
  }

  // 古いメッセージから削除（ユーザーとアシスタントのペアで削除）
  const trimmed = [...history]
  while (totalTokens > maxTokens && trimmed.length > 2) {
    const removed = trimmed.shift()!
    totalTokens -= estimateTokens(removed.content) + 4
  }

  console.log(`[Agent] History trimmed: ${history.length} → ${trimmed.length} messages (≈${totalTokens} tokens)`)
  return [systemMsg, ...trimmed]
}

export function createAgent(config: Partial<AgentConfig> = {}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'

  const agentConfig: AgentConfig = {
    apiKey: config.apiKey || 'proxy',
    baseURL: config.baseURL || `${origin}/api/llm`,
    model: config.model || process.env.LLM_MODEL || '',
    systemPrompt: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    maxHistoryTokens: config.maxHistoryTokens || 8000,
    storageKey: config.storageKey || 'agent-history',
  }

  // 会話履歴を localStorage から復元
  const restoredHistory = loadHistory(agentConfig.storageKey)
  let conversationHistory: Message[] = [
    { role: 'system', content: agentConfig.systemPrompt },
    ...restoredHistory,
  ]

  if (restoredHistory.length > 0) {
    console.log(`[Agent] Restored ${restoredHistory.length} messages from localStorage`)
  }

  // --- 非ストリーミング版 ---
  async function chat(userMessage: string): Promise<{ text: string; emotion: string }> {
    conversationHistory.push({ role: 'user', content: userMessage })

    // トリミング
    conversationHistory = trimHistory(
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

    // 永続化
    saveHistory(agentConfig.storageKey, conversationHistory)

    return { text: cleanText, emotion }
  }

  // --- ★ ストリーミング + 文単位チャンキング ---
  async function chatStreamSentences(
    userMessage: string,
    onSentence: (sentence: string, emotion: string, isFirst: boolean) => void,
    onComplete: (fullText: string) => void,
  ): Promise<void> {
    conversationHistory.push({ role: 'user', content: userMessage })

    // トリミング
    conversationHistory = trimHistory(
      conversationHistory, agentConfig.maxHistoryTokens, agentConfig.systemPrompt
    )

    const { textStream } = streamText({
      apiKey: agentConfig.apiKey,
      baseURL: agentConfig.baseURL,
      model: agentConfig.model,
      messages: conversationHistory,
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

      // 最初のチャンクで感情タグを抽出
      if (!emotionExtracted && buffer.includes(']')) {
        const { emotion: e, cleanText } = extractEmotion(buffer)
        emotion = e
        buffer = cleanText
        emotionExtracted = true
      }

      // 文区切り
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

    // バッファに残った末尾
    const remaining = emotionExtracted ? buffer.trim() : extractEmotion(buffer).cleanText.trim()
    if (!emotionExtracted) {
      emotion = extractEmotion(buffer).emotion
    }
    if (remaining.length > 0) {
      onSentence(remaining, emotion, sentenceIndex === 0)
    }

    // 感情タグを除去した全文を履歴に追加
    const { cleanText: finalClean } = extractEmotion(fullText)
    conversationHistory.push({ role: 'assistant', content: finalClean })

    // 永続化
    saveHistory(agentConfig.storageKey, conversationHistory)

    onComplete(finalClean)
  }

  function getHistory(): Message[] {
    return [...conversationHistory]
  }

  // ★ 表示用の履歴（system メッセージを除外）
  function getDisplayHistory(): { role: string; text: string }[] {
    return conversationHistory
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, text: m.content }))
  }

  function clearHistory(): void {
    conversationHistory = [
      { role: 'system', content: agentConfig.systemPrompt }
    ]
    saveHistory(agentConfig.storageKey, conversationHistory)
    console.log('[Agent] History cleared')
  }

  // ★ 現在の推定トークン数
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
