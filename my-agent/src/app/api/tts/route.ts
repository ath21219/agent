// src/app/api/tts/route.ts

import { NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { input, voice, model, response_format } = body
    const format = response_format || 'pcm'

    // サーバー専用環境変数
    const apiKey = process.env.TTS_API_KEY || ''
    const baseURL = (process.env.TTS_BASE_URL || '').replace(/\/$/, '')
    const resolvedModel = model || process.env.TTS_MODEL || ''
    const resolvedVoice = voice || process.env.TTS_VOICE || ''

    if (!apiKey || !baseURL) {
      return new Response(
        JSON.stringify({ error: 'TTS API not configured on server' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const upstreamRes = await fetch(`${baseURL}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        input,
        voice: resolvedVoice,
        response_format: response_format || 'pcm',
      }),
    })

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      console.error('[TTS Proxy] Upstream error:', upstreamRes.status, errText)
      return new Response(
        JSON.stringify({ error: `TTS API error: ${upstreamRes.status}`, details: errText }),
        { status: upstreamRes.status, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // PCMバイナリストリームを透過パイプ
    // 上流のサンプルレートヘッダを転送
    const sampleRate = upstreamRes.headers.get('X-Sample-Rate') || '48000'
    const contentType = format === 'mp3' ? 'audio/mpeg'
      : format === 'opus' ? 'audio/ogg'
        : 'application/octet-stream'

    return new Response(upstreamRes.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'X-Sample-Rate': sampleRate,
        'Cache-Control': 'no-cache',
      },
    })

  } catch (err) {
    console.error('[TTS Proxy] Internal error:', err)
    return new Response(
      JSON.stringify({ error: 'TTS proxy internal error', details: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
