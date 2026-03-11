// src/lib/fact-extractor.ts

import {
  FACT_EXTRACTION_SYSTEM,
  FACT_EXTRACTION_USER,
  fillTemplate,
} from './prompts'

export interface ExtractedFact {
  summary: string
  importance: number
}

export async function extractFacts(
  recentMessages: { role: string; content: string }[],
  knownFacts: string[],
  llmEndpoint: string,
): Promise<ExtractedFact[]> {
  const conversationText = recentMessages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n')

  const knownFactsText = knownFacts.length > 0
    ? knownFacts.map(f => `- ${f}`).join('\n')
    : '（なし）'

  const prompt = fillTemplate(FACT_EXTRACTION_USER, {
    KNOWN_FACTS: knownFactsText,
    CONVERSATION: conversationText,
  })

  const response = await fetch(llmEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: FACT_EXTRACTION_SYSTEM },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    console.error('[FactExtractor] LLM call failed:', response.status)
    return []
  }

  const data = await response.json()
  try {
    const text = data.choices?.[0]?.message?.content || ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []
    const parsed = JSON.parse(jsonMatch[0]) as ExtractedFact[]
    return parsed.filter(
      f => f.summary && typeof f.importance === 'number'
    )
  } catch {
    console.error('[FactExtractor] Failed to parse response')
    return []
  }
}
