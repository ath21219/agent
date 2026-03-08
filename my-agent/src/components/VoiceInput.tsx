'use client'

import { useMicVAD, utils } from '@ricky0123/vad-react'
import { useCallback } from 'react'

interface VoiceInputProps {
  onTranscript: (text: string) => void
  isListening: boolean
  setIsListening: (v: boolean) => void
}

export default function VoiceInput({ onTranscript, isListening, setIsListening }: VoiceInputProps) {

  // --- Whisper API に音声を送って文字起こし ---
  const transcribeAudio = useCallback(async (audioData: Float32Array) => {
    try {
      const wavBlob = float32ToWav(audioData, 16000)

      const formData = new FormData()
      formData.append('file', wavBlob, 'recording.wav')
      formData.append('model', 'kotoba-tech/kotoba-whisper-v2.0-faster')
      formData.append('language', 'ja')

      // ★ 自分自身の API Route に送信（CORS 問題なし）
      const response = await fetch('/api/stt', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const errorBody = await response.text()
        console.error('[STT] API error:', response.status, errorBody)
        return
      }

      const result = await response.json()
      const transcript = result.text?.trim()

      if (transcript) {
        console.log('[STT] Transcript:', transcript)
        onTranscript(transcript)
      }
    } catch (err) {
      console.error('[STT] Transcription failed:', err)
    }
  }, [onTranscript])

  // --- Silero VAD: 音声区間を検出 ---
  const vad = useMicVAD({
    startOnLoad: false,
    baseAssetPath: "/vad/",           // またはCDN URL（環境に合わせて）
    onnxWASMBasePath: "/vad/",
    // ★ Phase 1-A: レイテンシ最適化パラメータ
    model: "v5",                       // v5 モデルの方が精度が高い
    redemptionMs: 600,                 // デフォルト1400ms → 600ms（無音判定を早める）
    minSpeechMs: 250,                  // デフォルト400ms → 250ms（短い発話も拾う）
    preSpeechPadMs: 300,               // デフォルト800ms → 300ms（発話前パディング短縮）
    positiveSpeechThreshold: 0.35,     // デフォルト0.3 → やや厳しくしてノイズ誤検出を防ぐ
    negativeSpeechThreshold: 0.20,     // デフォルト0.25 → やや緩くして発話終了判定を早める

    onSpeechEnd: (audio: Float32Array) => {
      console.log('[VAD] Speech ended, sending to Whisper...')
      transcribeAudio(audio)
    },
    onSpeechStart: () => {
      console.log('[VAD] Speech started')
    },
  })

  // --- isListening が変わったら VAD を開始/停止 ---
  // useMicVAD は start/pause を公開している
  if (isListening && !vad.listening) {
    vad.start()
  } else if (!isListening && vad.listening) {
    vad.pause()
  }

  return null
}

// === Float32Array (PCM 16kHz mono) → WAV Blob 変換ユーティリティ ===
function float32ToWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  // WAV ヘッダー
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)           // chunk size
  view.setUint16(20, 1, true)            // PCM format
  view.setUint16(22, 1, true)            // mono
  view.setUint32(24, sampleRate, true)   // sample rate
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true)            // block align
  view.setUint16(34, 16, true)           // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  // PCM データ
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
