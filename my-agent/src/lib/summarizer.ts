// src/lib/summarizer.ts

import {
  SUMMARIZE_SYSTEM,
  SUMMARIZE_USER,
  fillTemplate,
} from './prompts'

export async function summarizeConversation(
  messages: { role: string; content: string }[],
  llmEndpoint: string,
): Promise<string | null> {
  const conversationText = messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n')

  const prompt = fillTemplate(SUMMARIZE_USER, {
    CONVERSATION: conversationText,
  })

  const response = await fetch(llmEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  })

  if (!response.ok) {
    console.error('[Summarizer] LLM call failed:', response.status)
    return null
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || null
}
