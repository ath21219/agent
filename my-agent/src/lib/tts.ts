// src/lib/tts.ts

import { LipsyncAnalyser } from './lipsync'

interface TTSConfig {
  apiKey: string
  baseURL: string
  model: string
  voice: string
}

const BYTES_PER_SAMPLE = 2

interface SentenceBuffer {
  index: number
  text: string
  chunks: Float32Array[]
  sampleRate: number
  fetchDone: boolean
  fetchError: Error | null
  abortController: AbortController
  onStart: () => void
  onEnd: () => void
  notifyReady: () => void
  waitForReady: () => Promise<void>
}

export function createTTS(config: Partial<TTSConfig> = {}) {
  const ttsConfig: TTSConfig = {
    apiKey: config.apiKey || 'proxy',
    baseURL: config.baseURL || '/api/tts',
    model: config.model || process.env.TTS_MODEL || '',
    voice: config.voice || process.env.TTS_VOICE || '',
  }

  // === Audio Context 管理 ===
  let audioContext: AudioContext | null = null
  let analyserNode: AnalyserNode | null = null
  let lipsyncAnalyser: LipsyncAnalyser | null = null

  function getAudioContext(): AudioContext {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext()
      console.log('[TTS] AudioContext sampleRate:', audioContext.sampleRate)
    }
    return audioContext
  }

  function getAnalyser(): AnalyserNode {
    if (!analyserNode) {
      const ctx = getAudioContext()
      analyserNode = ctx.createAnalyser()
      analyserNode.fftSize = 1024
      analyserNode.smoothingTimeConstant = 0.3
      analyserNode.connect(ctx.destination)
    }
    return analyserNode
  }

  function getLipsyncAnalyser(): LipsyncAnalyser {
    if (!lipsyncAnalyser) {
      lipsyncAnalyser = new LipsyncAnalyser(getAnalyser())
    }
    return lipsyncAnalyser
  }

  // === PCM変換 ===
  function pcmToFloat32(pcmData: Uint8Array): Float32Array {
    const numSamples = Math.floor(pcmData.length / BYTES_PER_SAMPLE)
    const float32 = new Float32Array(numSamples)
    const view = new DataView(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength)
    for (let i = 0; i < numSamples; i++) {
      const int16 = view.getInt16(i * BYTES_PER_SAMPLE, true)
      float32[i] = int16 / 32768.0
    }
    return float32
  }

  // === 再生スケジューラ ===
  let nextPlayTime = 0

  function scheduleChunk(float32Data: Float32Array, sampleRate: number): number {
    const ctx = getAudioContext()
    const analyser = getAnalyser()

    const audioBuffer = ctx.createBuffer(1, float32Data.length, sampleRate)
    audioBuffer.getChannelData(0).set(float32Data)

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(analyser)

    const now = ctx.currentTime
    const startTime = Math.max(nextPlayTime, now)
    source.start(startTime)

    const duration = float32Data.length / sampleRate
    nextPlayTime = startTime + duration
    return duration
  }

  // === パイプライン ===

  const MAX_PREFETCH = 3
  const PREFETCH_STAGGER_MS = 300

  let sentenceBuffers: Map<number, SentenceBuffer> = new Map()
  let pipelineActive = false
  let globalAborted = false
  let nextEnqueueIndex = 0
  let currentPlayIndex = 0
  let nextFetchIndex = 0
  let activeFetches = 0

  let playbackLoopDone: Promise<void> = Promise.resolve()
  let fetchSchedulerLoopDone: Promise<void> = Promise.resolve()

  let pipelineNotify: () => void = () => { }
  let pipelineWait: () => Promise<void> = () => Promise.resolve()

  function createSignal(): { notify: () => void; wait: () => Promise<void> } {
    let resolve: () => void = () => { }
    let promise = new Promise<void>(r => { resolve = r })
    return {
      notify: () => {
        resolve()
        promise = new Promise<void>(r => { resolve = r })
      },
      wait: () => promise,
    }
  }

  function createSentenceSignal(): { notify: () => void; wait: () => Promise<void> } {
    let resolve: () => void = () => { }
    let promise = new Promise<void>(r => { resolve = r })
    return {
      notify: () => {
        resolve()
        promise = new Promise<void>(r => { resolve = r })
      },
      wait: () => promise,
    }
  }

  async function fetchIntoBuffer(buf: SentenceBuffer): Promise<void> {
    try {
      const response = await fetch(ttsConfig.baseURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ttsConfig.model,
          input: buf.text,
          voice: ttsConfig.voice,
          response_format: 'pcm',
        }),
        signal: buf.abortController.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`TTS API error: ${response.status} ${errorText}`)
      }
      if (!response.body) {
        throw new Error('TTS API did not return a streaming body')
      }

      buf.sampleRate = parseInt(
        response.headers.get('X-Sample-Rate') || '48000',
        10,
      )

      const reader = response.body.getReader()
      let pendingBytes = new Uint8Array(0)
      const minChunkBytes = buf.sampleRate * BYTES_PER_SAMPLE * 0.2

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const combined = new Uint8Array(pendingBytes.length + value.length)
        combined.set(pendingBytes, 0)
        combined.set(value, pendingBytes.length)

        if (combined.length >= minChunkBytes) {
          const usableLength =
            Math.floor(combined.length / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
          const toPlay = combined.slice(0, usableLength)
          pendingBytes = combined.slice(usableLength)

          buf.chunks.push(pcmToFloat32(toPlay))
          buf.notifyReady()
        } else {
          pendingBytes = combined
        }
      }

      if (pendingBytes.length >= BYTES_PER_SAMPLE) {
        const usableLength =
          Math.floor(pendingBytes.length / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
        const toPlay = pendingBytes.slice(0, usableLength)
        buf.chunks.push(pcmToFloat32(toPlay))
      }

      buf.fetchDone = true
      buf.notifyReady()
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(`[TTS] Fetch aborted: #${buf.index}`)
      } else {
        console.error(`[TTS] Fetch failed: #${buf.index}`, err)
        buf.fetchError = err
      }
      buf.fetchDone = true
      buf.notifyReady()
    } finally {
      activeFetches--
      pipelineNotify()
    }
  }

  async function playbackLoop(): Promise<void> {
    while (pipelineActive && !globalAborted) {
      const buf = sentenceBuffers.get(currentPlayIndex)
      if (!buf) {
        await pipelineWait()
        continue
      }

      if (globalAborted) return

      buf.onStart()
      console.log(
        `[TTS] Play start: #${buf.index} "${buf.text.slice(0, 30)}..."`,
      )

      let chunkCursor = 0

      while (true) {
        if (globalAborted) return

        if (chunkCursor < buf.chunks.length) {
          while (chunkCursor < buf.chunks.length) {
            scheduleChunk(buf.chunks[chunkCursor], buf.sampleRate)
            chunkCursor++
          }
        } else if (buf.fetchDone) {
          break
        } else {
          await buf.waitForReady()
          if (globalAborted) return
        }
      }

      if (buf.fetchError) {
        console.error(
          `[TTS] Skipping due to error: #${buf.index}`,
          buf.fetchError,
        )
      }

      const ctx = getAudioContext()
      const remaining = nextPlayTime - ctx.currentTime
      if (remaining > 0 && !globalAborted) {
        await new Promise(resolve => setTimeout(resolve, remaining * 1000))
      }

      if (globalAborted) return

      buf.onEnd()
      console.log(`[TTS] Play end: #${buf.index}`)

      buf.chunks.length = 0
      sentenceBuffers.delete(currentPlayIndex)

      currentPlayIndex++
      pipelineNotify()
    }
    console.log('[TTS] Playback loop exited')
  }

  async function fetchSchedulerLoop(): Promise<void> {
    while (pipelineActive && !globalAborted) {
      const windowEnd = currentPlayIndex + MAX_PREFETCH
      if (nextFetchIndex < windowEnd && sentenceBuffers.has(nextFetchIndex)) {
        const buf = sentenceBuffers.get(nextFetchIndex)!
        if (!buf.fetchDone && buf.chunks.length === 0 && activeFetches < MAX_PREFETCH) {
          console.log(
            `[TTS] Prefetch start: #${buf.index} "${buf.text.slice(0, 30)}..."`,
          )
          activeFetches++
          fetchIntoBuffer(buf)
          nextFetchIndex++

          await new Promise(r => setTimeout(r, PREFETCH_STAGGER_MS))
          if (globalAborted) return
          continue
        }
      }

      await pipelineWait()
    }
    console.log('[TTS] Fetch scheduler loop exited')
  }

  async function startPipeline(): Promise<void> {
    if (pipelineActive) return

    await playbackLoopDone
    await fetchSchedulerLoopDone

    pipelineActive = true
    globalAborted = false

    const sig = createSignal()
    pipelineNotify = sig.notify
    pipelineWait = sig.wait

    playbackLoopDone = playbackLoop().catch(err => {
      console.error('[TTS] Playback loop error:', err)
    })
    fetchSchedulerLoopDone = fetchSchedulerLoop().catch(err => {
      console.error('[TTS] Fetch scheduler error:', err)
    })
  }

  function enqueueSentence(
    text: string,
    onStart: () => void,
    onEnd: () => void,
  ): void {
    const index = nextEnqueueIndex++
    const sig = createSentenceSignal()

    const buf: SentenceBuffer = {
      index,
      text,
      chunks: [],
      sampleRate: 48000,
      fetchDone: false,
      fetchError: null,
      abortController: new AbortController(),
      onStart,
      onEnd,
      notifyReady: sig.notify,
      waitForReady: sig.wait,
    }

    sentenceBuffers.set(index, buf)
    startPipeline()
    pipelineNotify()
  }

  function clearQueue(): void {
    globalAborted = true
    pipelineActive = false

    for (const buf of sentenceBuffers.values()) {
      buf.abortController.abort()
      if (!buf.fetchDone) {
        buf.fetchDone = true
        buf.notifyReady()
      }
    }

    for (const buf of sentenceBuffers.values()) {
      if (buf.index >= currentPlayIndex) {
        buf.onEnd()
      }
    }

    sentenceBuffers.clear()
    nextEnqueueIndex = 0
    currentPlayIndex = 0
    nextFetchIndex = 0
    activeFetches = 0
    nextPlayTime = 0

    pipelineNotify()
  }

  async function speak(text: string): Promise<{ duration: number }> {
    const response = await fetch(ttsConfig.baseURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ttsConfig.model,
        input: text,
        voice: ttsConfig.voice,
        response_format: 'mp3',
      }),
    })
    if (!response.ok) throw new Error(`TTS error: ${response.status}`)

    const arrayBuffer = await response.arrayBuffer()
    const ctx = getAudioContext()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(getAnalyser())
    source.start()
    return { duration: audioBuffer.duration }
  }

  return { speak, enqueueSentence, clearQueue, getLipsyncAnalyser }
}
