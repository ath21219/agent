// src/lib/vision.ts

// ─── 型定義 ───
export interface CapturedFrame {
  label: string        // 'camera' | 'screen' | 'vrm-mirror'
  dataUrl: string      // Base64 data URL (JPEG)
}

export interface VisionSnapshot {
  frames: CapturedFrame[]
  internalState?: string   // VRM 内部状態テキスト（後述）
}

export type Resolution = 'normal' | 'hd'

export interface VisionConfig {
  cameraEnabled: boolean
  screenEnabled: boolean
  vrmMirrorEnabled: boolean
  internalStateEnabled: boolean
  resolution: Resolution
}

// ─── 定数 ───
const JPEG_QUALITY = 0.85  // 固定

const RESOLUTION_MAP: Record<Resolution, number> = {
  normal: 384,   // → Gemini/GPT-4o: 258 tokens 固定
  hd: 1280,  // → タイル分割で 516‑1032 tokens
}

// ─── リサイズ＆Base64変換 ───
function resizeToDataUrl(
  source: HTMLVideoElement | HTMLCanvasElement,
  maxSize: number,
): string {
  const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width
  const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height
  if (sw === 0 || sh === 0) return ''

  const scale = Math.min(1, maxSize / Math.max(sw, sh))
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0, dw, dh)
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

// ─── カメラ ───
let cameraStream: MediaStream | null = null
let cameraVideo: HTMLVideoElement | null = null

export async function startCamera(): Promise<void> {
  if (cameraStream) return
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  })
  cameraVideo = document.createElement('video')
  cameraVideo.srcObject = cameraStream
  cameraVideo.muted = true
  await cameraVideo.play()
}

export function stopCamera(): void {
  cameraStream?.getTracks().forEach(t => t.stop())
  cameraStream = null
  cameraVideo = null
}

export function isCameraActive(): boolean {
  return cameraStream !== null
}

function captureCamera(maxSize: number): string {
  if (!cameraVideo) return ''
  return resizeToDataUrl(cameraVideo, maxSize)
}

// ─── 画面共有 ───
let screenStream: MediaStream | null = null
let screenVideo: HTMLVideoElement | null = null

export async function startScreenCapture(): Promise<void> {
  if (screenStream) return
  screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true })
  screenVideo = document.createElement('video')
  screenVideo.srcObject = screenStream
  screenVideo.muted = true
  await screenVideo.play()
  // ユーザーが共有を停止した場合のクリーンアップ
  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    screenStream = null
    screenVideo = null
  })
}

export function stopScreenCapture(): void {
  screenStream?.getTracks().forEach(t => t.stop())
  screenStream = null
  screenVideo = null
}

export function isScreenActive(): boolean {
  return screenStream !== null
}

function captureScreen(maxSize: number): string {
  if (!screenVideo) return ''
  return resizeToDataUrl(screenVideo, maxSize)
}

// ─── VRM ミラー ───
let vrmCanvas: HTMLCanvasElement | null = null

export function setVRMCanvas(canvas: HTMLCanvasElement): void {
  vrmCanvas = canvas
}

function captureVRMMirror(maxSize: number): string {
  if (!vrmCanvas) return ''
  return resizeToDataUrl(vrmCanvas, maxSize)
}

// ─── VRM 内部状態テキスト ───
export interface VRMInternalState {
  emotion: string
  emotionIntensity?: number
  isSpeaking: boolean
  blendShapes?: Record<string, number>
}

export function describeVRMState(state: VRMInternalState): string {
  const emotionLabel = state.emotion === 'neutral' ? '落ち着いた表情' :
    state.emotion === 'joy' ? 'とても嬉しそうな表情' :
      state.emotion === 'sad' ? '悲しそうな表情' :
        state.emotion === 'angry' ? '怒った表情' :
          state.emotion === 'surprise' ? '驚いた表情' :
            `${state.emotion}の表情`

  const speakingLabel = state.isSpeaking ? '話している最中' : '黙っている'

  return `[あなたの現在の状態] ${emotionLabel}。${speakingLabel}。`
}

// ─── メインキャプチャ関数 ───
export function captureAll(config: VisionConfig, vrmState?: VRMInternalState): VisionSnapshot {
  const maxSize = RESOLUTION_MAP[config.resolution]
  const frames: CapturedFrame[] = []

  if (config.cameraEnabled) {
    const dataUrl = captureCamera(maxSize)
    if (dataUrl) frames.push({ label: 'camera', dataUrl })
  }

  if (config.screenEnabled) {
    const dataUrl = captureScreen(maxSize)
    if (dataUrl) frames.push({ label: 'screen', dataUrl })
  }

  if (config.vrmMirrorEnabled) {
    const dataUrl = captureVRMMirror(maxSize)
    if (dataUrl) frames.push({ label: 'vrm-mirror', dataUrl })
  }

  const internalState = config.internalStateEnabled && vrmState
    ? describeVRMState(vrmState)
    : undefined

  return { frames, internalState }
}

// ─── IndexedDB ログ保存 ───
const DB_NAME = 'vision-log'
const STORE_NAME = 'frames'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveFrameLog(snapshot: VisionSnapshot): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  store.add({
    timestamp: Date.now(),
    frames: snapshot.frames.map(f => ({ label: f.label, dataUrl: f.dataUrl })),
    internalState: snapshot.internalState ?? null,
  })
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function exportVisionLog(): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  const all: unknown[] = await new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  const jsonl = all.map(row => JSON.stringify(row)).join('\n')
  const blob = new Blob([jsonl], { type: 'application/x-jsonlines' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `vision-log-${new Date().toISOString().slice(0, 19)}.jsonl`
  a.click()
  URL.revokeObjectURL(url)
}

export async function clearVisionLog(): Promise<void> {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  tx.objectStore(STORE_NAME).clear()
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ─── デフォルト設定 ───
export const DEFAULT_VISION_CONFIG: VisionConfig = {
  cameraEnabled: true,
  screenEnabled: true,
  vrmMirrorEnabled: false,
  internalStateEnabled: true,
  resolution: 'normal',
}
