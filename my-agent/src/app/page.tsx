'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import VRMScene from '@/components/VRMScene'
import VoiceInput from '@/components/VoiceInput'
import { createAgent } from '@/lib/agent'
import { createTTS } from '@/lib/tts'
import type { LipsyncAnalyser, VRMViseme } from '@/lib/lipsync'
import {
  startCamera, stopCamera, isCameraActive,
  startScreenCapture, stopScreenCapture, isScreenActive,
  setVRMCanvas, captureAll, saveFrameLog, exportVisionLog, clearVisionLog,
  describeVRMState,
  DEFAULT_VISION_CONFIG,
  type VisionConfig, type Resolution,
} from '@/lib/vision'

export default function Home() {
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([])
  const [inputText, setInputText] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [visemeWeights, setVisemeWeights] = useState<Record<VRMViseme, number>>({
    aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, sil: 1,
  })
  const [currentEmotion, setCurrentEmotion] = useState<string | null>('neutral')
  const [isListening, setIsListening] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [estimatedTokens, setEstimatedTokens] = useState(0)

  // ─── Vision 状態 ───
  const [visionConfig, setVisionConfig] = useState<VisionConfig>(DEFAULT_VISION_CONFIG)
  const [visionEnabled, setVisionEnabled] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [screenOn, setScreenOn] = useState(false)
  const [showVisionPanel, setShowVisionPanel] = useState(false)

  const [memoryStatus, setMemoryStatus] = useState<{ db: boolean; embedding: boolean } | null>(null)

  const agentRef = useRef(createAgent())
  const ttsRef = useRef(createTTS())
  const activeSentencesRef = useRef(0)
  const lipsyncLoopRef = useRef<number | null>(null)
  const lipsyncAnalyserRef = useRef<LipsyncAnalyser | null>(null)
  const pendingEmotionsRef = useRef<string[]>([])
  const neutralTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // ★ 起動時に localStorage から会話履歴を復元
  useEffect(() => {
    const restored = agentRef.current.getDisplayHistory()
    if (restored.length > 0) {
      setMessages(restored)
      setEstimatedTokens(agentRef.current.getEstimatedTokens())
    }
  }, [])

  // メッセージ追加時に自動スクロール
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText])

  const updateTokenCount = useCallback(() => {
    setEstimatedTokens(agentRef.current.getEstimatedTokens())
  }, [])

  useEffect(() => {
    fetch('/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'health' }),
    })
      .then(res => res.json())
      .then(status => setMemoryStatus(status))
      .catch(() => setMemoryStatus(null))
  }, [])

  // ─── カメラ ON/OFF ───
  const toggleCamera = useCallback(async () => {
    if (isCameraActive()) {
      stopCamera()
      setCameraOn(false)
    } else {
      try {
        await startCamera()
        setCameraOn(true)
      } catch (err) {
        console.error('Camera error:', err)
      }
    }
  }, [])

  // ─── 画面共有 ON/OFF ───
  const toggleScreen = useCallback(async () => {
    if (isScreenActive()) {
      stopScreenCapture()
      setScreenOn(false)
    } else {
      try {
        await startScreenCapture()
        setScreenOn(true)
      } catch (err) {
        console.error('Screen capture error:', err)
      }
    }
  }, [])

  // ─── VRM Canvas コールバック ───
  const handleCanvasReady = useCallback((canvas: HTMLCanvasElement) => {
    setVRMCanvas(canvas)
  }, [])

  // ─── リップシンク ───
  const startLipSync = useCallback(() => {
    setIsSpeaking(true)
    if (neutralTimerRef.current) {
      clearTimeout(neutralTimerRef.current)
      neutralTimerRef.current = null
    }
    if (!lipsyncAnalyserRef.current) {
      lipsyncAnalyserRef.current = ttsRef.current.getLipsyncAnalyser()
    }
    if (lipsyncLoopRef.current !== null) return
    const loop = () => {
      if (lipsyncAnalyserRef.current) {
        const { weights } = lipsyncAnalyserRef.current.update()
        setVisemeWeights({ ...weights })
      }
      lipsyncLoopRef.current = requestAnimationFrame(loop)
    }
    lipsyncLoopRef.current = requestAnimationFrame(loop)
  }, [])

  const stopLipSync = useCallback(() => {
    if (lipsyncLoopRef.current !== null) {
      cancelAnimationFrame(lipsyncLoopRef.current)
      lipsyncLoopRef.current = null
    }
    setVisemeWeights({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, sil: 1 })
    setIsSpeaking(false)
    if (neutralTimerRef.current) clearTimeout(neutralTimerRef.current)
    neutralTimerRef.current = setTimeout(() => {
      setCurrentEmotion('neutral')
      neutralTimerRef.current = null
    }, 2000)
  }, [])

  useEffect(() => {
    return () => {
      if (lipsyncLoopRef.current !== null) cancelAnimationFrame(lipsyncLoopRef.current)
      if (neutralTimerRef.current) clearTimeout(neutralTimerRef.current)
    }
  }, [])

  // ─── メッセージ送信 ───
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isProcessing) return

    setIsProcessing(true)
    setStreamingText('')
    setMessages(prev => [...prev, { role: 'user', text }])
    activeSentencesRef.current = 0
    pendingEmotionsRef.current = []

    setTimeout(() => updateTokenCount(), 0)

    // ─── Vision キャプチャ ───
    let visionSnapshot = undefined
    if (visionEnabled) {
      const vrmState = {
        emotion: currentEmotion || 'neutral',
        isSpeaking,
      }
      visionSnapshot = captureAll(visionConfig, vrmState)

      // IndexedDB にログ保存
      if (visionSnapshot.frames.length > 0) {
        saveFrameLog(visionSnapshot).catch(err =>
          console.error('Vision log save error:', err)
        )
      }
    }

    try {
      await agentRef.current.chatStreamSentences(
        text,
        (sentence, emotion) => {
          setStreamingText(prev => prev + (prev ? '' : '') + sentence)
          pendingEmotionsRef.current.push(emotion)

          activeSentencesRef.current++
          ttsRef.current.enqueueSentence(
            sentence,
            () => {
              const em = pendingEmotionsRef.current.shift() || 'neutral'
              setCurrentEmotion(em)
              startLipSync()
            },
            () => {
              activeSentencesRef.current--
              if (activeSentencesRef.current <= 0) {
                stopLipSync()
              }
            },
          )
        },
        (fullText) => {
          setStreamingText('')
          setMessages(prev => [...prev, { role: 'assistant', text: fullText }])
          setIsProcessing(false)
          updateTokenCount()
        },
        { vision: visionSnapshot },
      )
    } catch (err) {
      console.error('[Agent] Error:', err)
      setMessages(prev => [...prev, { role: 'system', text: 'エラーが発生しました' }])
      setIsProcessing(false)
      stopLipSync()
    }
  }, [isProcessing, visionEnabled, visionConfig, currentEmotion, isSpeaking, startLipSync, stopLipSync, updateTokenCount])

  const handleVoiceTranscript = useCallback((transcript: string) => {
    sendMessage(transcript)
  }, [sendMessage])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(inputText)
    setInputText('')
  }

  const handleClearHistory = useCallback(() => {
    agentRef.current.clearHistory()
    setMessages([])
    setCurrentEmotion('neutral')
    setTimeout(() => setEstimatedTokens(agentRef.current.getEstimatedTokens()), 0)
    ttsRef.current.clearQueue()
  }, [])

  return (
    <div className="flex h-screen bg-gray-900 text-white">
      {/* ─── 左: 3D + マイクボタン ─── */}
      <div className="flex-1 relative">
        <VRMScene
          isSpeaking={isSpeaking}
          visemeWeights={visemeWeights}
          emotion={currentEmotion}
          onCanvasReady={handleCanvasReady}
        />
        <button
          onClick={() => setIsListening(!isListening)}
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full ${isListening ? 'bg-red-600 animate-pulse' : 'bg-blue-600'} hover:opacity-80 transition`}
        >
          {isListening ? '🎤 聴取中...' : '🎤 話しかける'}
        </button>
      </div>

      {/* ─── 右: チャット + Vision パネル ─── */}
      <div className="w-96 flex flex-col border-l border-gray-700">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-800">
          <span className="text-xs text-gray-400">≈ {estimatedTokens} tokens</span>
          {memoryStatus ? (
            <span className={`text-xs ${memoryStatus.db && memoryStatus.embedding ? 'text-green-400' : 'text-yellow-400'}`}>
              {memoryStatus.db && memoryStatus.embedding
                ? '🧠 Memory'
                : memoryStatus.db
                  ? '🧠 Memory (embedding offline)'
                  : '⚠ Memory offline'}
            </span>
          ) : (
            <span className="text-xs text-gray-500">🧠 Memory N/A</span>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setShowVisionPanel(v => !v)}
              className={`text-xs px-2 py-1 rounded ${showVisionPanel ? 'bg-purple-600' : 'bg-gray-600'} hover:opacity-80 transition`}
            >
              Vision
            </button>
            <button
              onClick={handleClearHistory}
              className="text-xs text-gray-400 hover:text-red-400 transition"
              title="会話履歴をクリア"
            >
              履歴クリア
            </button>
          </div>
        </div>

        {/* ─── Vision 設定パネル ─── */}
        {showVisionPanel && (
          <div className="px-4 py-3 border-b border-gray-700 bg-gray-850 space-y-2 text-xs">
            {/* Vision ON/OFF */}
            <div className="flex items-center justify-between">
              <span>Vision</span>
              <button
                onClick={() => setVisionEnabled(v => !v)}
                className={`px-3 py-1 rounded ${visionEnabled ? 'bg-green-600' : 'bg-gray-600'}`}
              >
                {visionEnabled ? 'ON' : 'OFF'}
              </button>
            </div>

            {visionEnabled && (
              <>
                {/* カメラ */}
                <div className="flex items-center justify-between">
                  <span>カメラ</span>
                  <button
                    onClick={toggleCamera}
                    className={`px-3 py-1 rounded ${cameraOn ? 'bg-green-600' : 'bg-gray-600'}`}
                  >
                    {cameraOn ? 'ON' : 'OFF'}
                  </button>
                </div>

                {/* 画面共有 */}
                <div className="flex items-center justify-between">
                  <span>画面共有</span>
                  <button
                    onClick={toggleScreen}
                    className={`px-3 py-1 rounded ${screenOn ? 'bg-green-600' : 'bg-gray-600'}`}
                  >
                    {screenOn ? 'ON' : 'OFF'}
                  </button>
                </div>

                {/* VRM ミラー */}
                <div className="flex items-center justify-between">
                  <span>VRM ミラー</span>
                  <button
                    onClick={() => setVisionConfig(c => ({ ...c, vrmMirrorEnabled: !c.vrmMirrorEnabled }))}
                    className={`px-3 py-1 rounded ${visionConfig.vrmMirrorEnabled ? 'bg-green-600' : 'bg-gray-600'}`}
                  >
                    {visionConfig.vrmMirrorEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                {/* 内部状態テキスト */}
                <div className="flex items-center justify-between">
                  <span>内部状態テキスト</span>
                  <button
                    onClick={() => setVisionConfig(c => ({ ...c, internalStateEnabled: !c.internalStateEnabled }))}
                    className={`px-3 py-1 rounded ${visionConfig.internalStateEnabled ? 'bg-green-600' : 'bg-gray-600'}`}
                  >
                    {visionConfig.internalStateEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                {/* 解像度 */}
                <div className="flex items-center justify-between">
                  <span>解像度</span>
                  <div className="flex gap-1">
                    {(['normal', 'hd'] as Resolution[]).map(r => (
                      <button
                        key={r}
                        onClick={() => setVisionConfig(c => ({ ...c, resolution: r }))}
                        className={`px-2 py-1 rounded ${visionConfig.resolution === r ? 'bg-blue-600' : 'bg-gray-600'}`}
                      >
                        {r === 'normal' ? '通常' : 'HD'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ログ操作 */}
                <div className="flex items-center justify-between pt-1 border-t border-gray-600">
                  <span className="text-gray-400">Vision ログ</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => exportVisionLog().catch(console.error)}
                      className="px-2 py-1 rounded bg-gray-600 hover:bg-gray-500"
                    >
                      Export
                    </button>
                    <button
                      onClick={() => {
                        if (confirm('Vision ログを削除しますか？')) {
                          clearVisionLog().catch(console.error)
                        }
                      }}
                      className="px-2 py-1 rounded bg-gray-600 hover:text-red-400"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* メッセージ一覧 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`p-3 rounded-lg max-w-[85%] ${msg.role === 'user' ? 'bg-blue-800 ml-auto' : 'bg-gray-700'}`}
            >
              <p className="text-sm">{msg.text}</p>
            </div>
          ))}
          {streamingText && (
            <div className="bg-gray-700 p-3 rounded-lg max-w-[85%]">
              <p className="text-sm">{streamingText}<span className="animate-pulse">▌</span></p>
            </div>
          )}
          {isProcessing && !streamingText && (
            <div className="bg-gray-700 p-3 rounded-lg w-16">
              <p className="text-sm animate-pulse">...</p>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* テキスト入力 */}
        <form onSubmit={handleSubmit} className="p-4 border-t border-gray-700">
          <div className="flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="メッセージを入力..."
              className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
              disabled={isProcessing}
            />
            <button
              type="submit"
              disabled={isProcessing || !inputText.trim()}
              className="px-4 py-2 bg-blue-600 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition"
            >
              送信
            </button>
          </div>
        </form>
      </div>

      <VoiceInput
        onTranscript={handleVoiceTranscript}
        isListening={isListening}
        setIsListening={setIsListening}
      />
    </div>
  )
}
