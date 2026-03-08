'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import VRMScene from '@/components/VRMScene'
import VoiceInput from '@/components/VoiceInput'
import { createAgent } from '@/lib/agent'
import { createTTS } from '@/lib/tts'
import type { LipsyncAnalyser, VRMViseme } from '@/lib/lipsync'

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

  // トークン数を更新
  const updateTokenCount = useCallback(() => {
    setEstimatedTokens(agentRef.current.getEstimatedTokens())
  }, [])

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

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isProcessing) return

    setIsProcessing(true)
    setStreamingText('')
    setMessages(prev => [...prev, { role: 'user', text }])
    activeSentencesRef.current = 0
    pendingEmotionsRef.current = []

    // ★ ユーザー発言追加直後にトークン数を更新
    // （agent 内部では chatStreamSentences の冒頭で push されるため、
    //   次のフレームで反映される。ここでは先に UI を更新する）
    setTimeout(() => updateTokenCount(), 0)

    try {
      await agentRef.current.chatStreamSentences(
        text,
        (sentence, emotion, isFirst) => {
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
      )
    } catch (err) {
      console.error('[Agent] Error:', err)
      setMessages(prev => [...prev, { role: 'system', text: 'エラーが発生しました' }])
      setIsProcessing(false)
      stopLipSync()
    }
  }, [isProcessing, startLipSync, stopLipSync, updateTokenCount])

  const handleVoiceTranscript = useCallback((transcript: string) => {
    sendMessage(transcript)
  }, [sendMessage])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(inputText)
    setInputText('')
  }

  // ★ 会話クリア
  const handleClearHistory = useCallback(() => {
    agentRef.current.clearHistory()
    setMessages([])
    setCurrentEmotion('neutral')
    // ★ クリア後に明示的にトークン数を再取得
    setTimeout(() => setEstimatedTokens(agentRef.current.getEstimatedTokens()), 0)
    ttsRef.current.clearQueue()
  }, [])

  return (
    <div className="flex h-screen bg-gray-900 text-white">
      <div className="flex-1 relative">
        <VRMScene
          isSpeaking={isSpeaking}
          visemeWeights={visemeWeights}
          emotion={currentEmotion}
        />
        <button
          onClick={() => setIsListening(!isListening)}
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full ${isListening ? 'bg-red-600 animate-pulse' : 'bg-blue-600'} hover:opacity-80 transition`}
        >
          {isListening ? '🎤 聴取中...' : '🎤 話しかける'}
        </button>
      </div>

      <div className="w-96 flex flex-col border-l border-gray-700">
        {/* ★ ヘッダー: トークン数 + クリアボタン */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 bg-gray-800">
          <span className="text-xs text-gray-400">≈ {estimatedTokens} tokens</span>
          <button
            onClick={handleClearHistory}
            className="text-xs text-gray-400 hover:text-red-400 transition"
            title="会話履歴をクリア"
          >
            履歴クリア
          </button>
        </div>

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
