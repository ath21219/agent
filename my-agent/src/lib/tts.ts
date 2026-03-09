import { LipsyncAnalyser } from './lipsync'

interface TTSConfig {
  apiKey: string
  baseURL: string
  model: string
  voice: string
}

const BYTES_PER_SAMPLE = 2 // 16-bit = 2 bytes

/** 各文のフェッチ状態を管理するバッファ */
interface SentenceBuffer {
  index: number
  text: string
  chunks: Float32Array[]     // 受信済みPCMチャンク（Float32変換済み）
  sampleRate: number
  fetchDone: boolean         // フェッチ完了フラグ
  fetchError: Error | null
  abortController: AbortController
  onStart: () => void
  onEnd: () => void
  // チャンク到着またはフェッチ完了を通知するための仕組み
  notifyReady: () => void
  waitForReady: () => Promise<void>
}

export function createTTS(config: Partial<TTSConfig> = {}) {
  const ttsConfig: TTSConfig = {
    apiKey: config.apiKey || 'proxy',                        // プロキシ経由なので不要
    baseURL: config.baseURL || '/api/tts',                   // ★ ローカルプロキシ
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

  // === 先行フェッチ + 順序再生 パイプライン ===

  /** 先行フェッチの最大同時数 */
  const MAX_PREFETCH = 3
  /** 先行フェッチ開始の間隔（ミリ秒） */
  const PREFETCH_STAGGER_MS = 300

  // パイプライン全体の状態
  let sentenceBuffers: Map<number, SentenceBuffer> = new Map()
  let pipelineActive = false
  let globalAborted = false
  let nextEnqueueIndex = 0
  let currentPlayIndex = 0    // 次に再生すべき文のindex
  let nextFetchIndex = 0      // 次にフェッチを開始すべき文のindex
  let activeFetches = 0       // 現在進行中のフェッチ数

  // パイプライン全体の進行通知
  let pipelineNotify: () => void = () => { }
  let pipelineWait: () => Promise<void> = () => Promise.resolve()

  function createSignal(): { notify: () => void; wait: () => Promise<void> } {
    let resolve: () => void = () => { }
    let promise = new Promise<void>(r => { resolve = r })
    return {
      notify: () => {
        resolve()
        // 新しいPromiseをセットアップ（次のwaitに備える）
        promise = new Promise<void>(r => { resolve = r })
      },
      wait: () => promise,
    }
  }

  function createSentenceSignal(): { notify: () => void; wait: () => Promise<void> } {
    // 文バッファ用のシグナル。チャンク到着 or フェッチ完了で通知
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

  /**
   * 1つの文に対するTTSフェッチを実行し、チャンクをバッファに蓄積する。
   * 再生はここでは行わない。
   */
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
          buf.notifyReady() // 再生側に「チャンクが来たよ」と通知
        } else {
          pendingBytes = combined
        }
      }

      // 残りのデータ
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
      // フェッチ枠が空いたのでパイプラインに通知
      pipelineNotify()
    }
  }

  /**
   * 再生ループ: currentPlayIndex の文から順に、チャンクが届き次第スケジュール再生する。
   * 1つの文の再生が完全に終わったら次の文へ進む。
   */
  async function playbackLoop(): Promise<void> {
    while (pipelineActive) {
      const buf = sentenceBuffers.get(currentPlayIndex)
      if (!buf) {
        // まだこのindexのバッファが作られていない → パイプライン通知を待つ
        await pipelineWait()
        continue
      }

      // この文の再生開始
      buf.onStart()
      console.log(
        `[TTS] Play start: #${buf.index} "${buf.text.slice(0, 30)}..."`,
      )

      let chunkCursor = 0 // 次に再生すべきchunksのindex

      // この文の全チャンクを再生し終えるまでループ
      while (true) {
        if (globalAborted) return

        if (chunkCursor < buf.chunks.length) {
          // 未再生チャンクがある → スケジュール
          while (chunkCursor < buf.chunks.length) {
            scheduleChunk(buf.chunks[chunkCursor], buf.sampleRate)
            chunkCursor++
          }
        } else if (buf.fetchDone) {
          // フェッチ完了かつ全チャンク再生済み → この文は終了
          break
        } else {
          // まだフェッチ中で新しいチャンクを待っている
          await buf.waitForReady()
        }
      }

      // フェッチエラーがあった場合もonEndは呼ぶ
      if (buf.fetchError) {
        console.error(
          `[TTS] Skipping due to error: #${buf.index}`,
          buf.fetchError,
        )
      }

      // この文のスケジュール済み音声の再生完了を待つ
      const ctx = getAudioContext()
      const remaining = nextPlayTime - ctx.currentTime
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining * 1000))
      }

      buf.onEnd()
      console.log(`[TTS] Play end: #${buf.index}`)

      // 再生済みバッファを解放
      buf.chunks.length = 0
      sentenceBuffers.delete(currentPlayIndex)

      currentPlayIndex++

      // フェッチ枠が空いた可能性があるのでパイプラインに通知
      pipelineNotify()
    }
  }

  /**
   * フェッチスケジューラ: ウィンドウサイズ内で先行フェッチを開始する。
   * スタガリング間隔を空けてAPIに負荷をかけすぎないようにする。
   */
  async function fetchSchedulerLoop(): Promise<void> {
    while (pipelineActive) {
      if (globalAborted) return

      // ウィンドウ: 再生中の文 + 先行フェッチ数 が MAX_PREFETCH 以下
      const windowEnd = currentPlayIndex + MAX_PREFETCH
      if (nextFetchIndex < windowEnd && sentenceBuffers.has(nextFetchIndex)) {
        const buf = sentenceBuffers.get(nextFetchIndex)!
        // まだフェッチ開始していないもののみ
        if (!buf.fetchDone && buf.chunks.length === 0 && activeFetches < MAX_PREFETCH) {
          console.log(
            `[TTS] Prefetch start: #${buf.index} "${buf.text.slice(0, 30)}..."`,
          )
          activeFetches++
          fetchIntoBuffer(buf) // awaitしない（並行実行）
          nextFetchIndex++

          // スタガリング: 次のフェッチまで少し待つ
          await new Promise(r => setTimeout(r, PREFETCH_STAGGER_MS))
          continue
        }
      }

      // キューにまだ登録されていない文があるかもしれないので待つ
      // または全文完了なら終了
      if (!sentenceBuffers.has(nextFetchIndex) && nextFetchIndex >= nextEnqueueIndex) {
        // すべての登録済み文のフェッチを開始済み
        // 新しい文が来るか、パイプラインが終わるまで待つ
      }
      await pipelineWait()
    }
  }

  /**
   * パイプラインを起動する（初回のenqueue時に呼ばれる）
   */
  function startPipeline(): void {
    if (pipelineActive) return
    pipelineActive = true
    globalAborted = false

    const sig = createSignal()
    pipelineNotify = sig.notify
    pipelineWait = sig.wait

    // 再生ループとフェッチスケジューラを並行起動
    playbackLoop().catch(err => {
      console.error('[TTS] Playback loop error:', err)
    })
    fetchSchedulerLoop().catch(err => {
      console.error('[TTS] Fetch scheduler error:', err)
    })
  }

  /**
   * 文をエンキューする。
   * バッファを作成してパイプラインに登録する。
   */
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
      sampleRate: 48000, // デフォルト。フェッチ時にレスポンスヘッダで上書き
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
    pipelineNotify() // スケジューラに新しい文が来たことを通知
  }

  function clearQueue(): void {
    globalAborted = true
    pipelineActive = false

    // 進行中のフェッチをすべて中断
    for (const buf of sentenceBuffers.values()) {
      buf.abortController.abort()
      if (!buf.fetchDone) {
        buf.fetchDone = true
        buf.notifyReady()
      }
    }

    // 未再生の文のonEndを呼ぶ
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

    // パイプラインの待機を解除
    pipelineNotify()
  }

  // フォールバック: 非ストリーミング再生
  async function speak(text: string): Promise<{ duration: number }> {
    const response = await fetch(ttsConfig.baseURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ttsConfig.model,
        input: text,
        voice: ttsConfig.voice,
        response_format: 'mp3',   // 非ストリーミングは mp3 で受け取る
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
