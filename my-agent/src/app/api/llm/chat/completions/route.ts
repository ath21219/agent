// src/app/api/llm/chat/completions/route.ts

import { NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { messages, model, stream } = body

    const apiKey = process.env.LLM_API_KEY || ''
    const baseURL = (process.env.LLM_BASE_URL || '').replace(/\/$/, '')
    const resolvedModel = model || process.env.LLM_MODEL || ''

    if (!apiKey || !baseURL) {
      return new Response(
        JSON.stringify({ error: 'LLM API not configured on server' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const upstreamRes = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        stream: !!stream,
      }),
    })

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      console.error('[LLM Proxy] Upstream error:', upstreamRes.status, errText)
      return new Response(
        JSON.stringify({ error: `LLM API error: ${upstreamRes.status}`, details: errText }),
        { status: upstreamRes.status, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (stream) {
      return new Response(upstreamRes.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    const result = await upstreamRes.json()
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('[LLM Proxy] Internal error:', err)
    return new Response(
      JSON.stringify({ error: 'LLM proxy internal error', details: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
