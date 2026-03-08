import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    // クライアントから送られた FormData をそのまま受け取る
    const formData = await request.formData()

    // STT サーバーの URL（サーバー側の環境変数なので NEXT_PUBLIC_ 不要）
    const sttBaseURL = process.env.STT_BASE_URL || 'http://host.docker.internal:7821/v1/'

    // STT サーバーに転送
    const response = await fetch(`${sttBaseURL}audio/transcriptions`, {
      method: 'POST',
      headers: {
        // STT サーバーが API キーを要求する場合
        ...(process.env.STT_API_KEY
          ? { 'Authorization': `Bearer ${process.env.STT_API_KEY}` }
          : {}),
      },
      body: formData,
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[STT Proxy] Upstream error:', response.status, errorText)
      return NextResponse.json(
        { error: `STT server error: ${response.status}`, details: errorText },
        { status: response.status }
      )
    }

    const result = await response.json()
    return NextResponse.json(result)

  } catch (err) {
    console.error('[STT Proxy] Error:', err)
    return NextResponse.json(
      { error: 'STT proxy internal error', details: String(err) },
      { status: 500 }
    )
  }
}
