// src/components/VRMScene.tsx

'use client'

import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { Timer } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js'
import {
  VRMLoaderPlugin,
  VRM,
  VRMUtils,
  VRMExpressionPresetName,
  VRMHumanBoneName,
} from '@pixiv/three-vrm'
import type { VRMPose } from '@pixiv/three-vrm'
import type { VRMViseme } from '@/lib/lipsync'

// ─── VRM モデルパス ───
const VRM_MODEL_PATH = `/models/${process.env.NEXT_PUBLIC_VRM_MODEL || 'agent.vrm'}`

// ─── カメラ記憶のストレージキー ───
const CAMERA_STORAGE_KEY = 'vrm-camera-state'

// ─── デフォルトカメラ位置（目線の高さ）───
const DEFAULT_CAMERA_POSITION = new THREE.Vector3(0, 1.35, 1.5)
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 1.35, 0)

// ─── カメラ状態の保存・復元 ───
interface CameraState {
  px: number; py: number; pz: number
  tx: number; ty: number; tz: number
}

function saveCameraState(camera: THREE.Camera, target: THREE.Vector3): void {
  try {
    const state: CameraState = {
      px: camera.position.x, py: camera.position.y, pz: camera.position.z,
      tx: target.x, ty: target.y, tz: target.z,
    }
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

function loadCameraState(): CameraState | null {
  try {
    const stored = localStorage.getItem(CAMERA_STORAGE_KEY)
    if (stored) return JSON.parse(stored) as CameraState
  } catch { /* ignore */ }
  return null
}

// ─── 定数マップ ───
const VISEME_MAP: Record<string, VRMExpressionPresetName> = {
  aa: VRMExpressionPresetName.Aa,
  ee: VRMExpressionPresetName.Ee,
  ih: VRMExpressionPresetName.Ih,
  oh: VRMExpressionPresetName.Oh,
  ou: VRMExpressionPresetName.Ou,
}

const EMOTION_MAP: Record<string, VRMExpressionPresetName> = {
  joy: VRMExpressionPresetName.Happy,
  sad: VRMExpressionPresetName.Sad,
  angry: VRMExpressionPresetName.Angry,
  surprise: VRMExpressionPresetName.Surprised,
  neutral: VRMExpressionPresetName.Neutral,
}

const EMOTION_EXPRESSIONS = [
  VRMExpressionPresetName.Happy,
  VRMExpressionPresetName.Sad,
  VRMExpressionPresetName.Angry,
  VRMExpressionPresetName.Surprised,
  VRMExpressionPresetName.Neutral,
]

const EMOTION_EYE_CLOSURE: Record<string, number> = {
  [VRMExpressionPresetName.Happy]: 0.7,
  [VRMExpressionPresetName.Sad]: 0.2,
  [VRMExpressionPresetName.Angry]: 0.3,
  [VRMExpressionPresetName.Surprised]: 0.0,
  [VRMExpressionPresetName.Neutral]: 0.0,
}

const EMOTION_MOUTH_INFLUENCE: Record<string, number> = {
  [VRMExpressionPresetName.Happy]: 0.3,
  [VRMExpressionPresetName.Sad]: 0.1,
  [VRMExpressionPresetName.Angry]: 0.15,
  [VRMExpressionPresetName.Surprised]: 0.5,
  [VRMExpressionPresetName.Neutral]: 0.0,
}

// ─── Euler → クォータニオン変換ヘルパー ───
const _euler = new THREE.Euler()
const _quat = new THREE.Quaternion()

function eulerToQuatArray(x: number, y: number, z: number): [number, number, number, number] {
  _euler.set(x, y, z)
  _quat.setFromEuler(_euler)
  return [_quat.x, _quat.y, _quat.z, _quat.w]
}

// ─── VRM 1.0 初期ポーズ ───
// VRM 1.0 正規化ボーン座標系:
//   - モデルは Z+ 方向を向く
//   - LeftUpperArm を体に寄せるには Z 軸を負方向に回転
//   - RightUpperArm を体に寄せるには Z 軸を正方向に回転
const ARM_DOWN_ANGLE = 1.2

const BASE_POSE: VRMPose = {
  [VRMHumanBoneName.LeftUpperArm]: { rotation: eulerToQuatArray(0, 0, -ARM_DOWN_ANGLE) },
  [VRMHumanBoneName.RightUpperArm]: { rotation: eulerToQuatArray(0, 0, ARM_DOWN_ANGLE) },
  [VRMHumanBoneName.LeftLowerArm]: { rotation: eulerToQuatArray(0, 0.15, 0) },
  [VRMHumanBoneName.RightLowerArm]: { rotation: eulerToQuatArray(0, -0.15, 0) },
}

// ─── Props ───
interface VRMSceneProps {
  isSpeaking: boolean
  visemeWeights: Record<VRMViseme, number>
  emotion: string | null
  onCanvasReady?: (canvas: HTMLCanvasElement) => void
}

export default function VRMScene({ isSpeaking, visemeWeights, emotion, onCanvasReady }: VRMSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const vrmRef = useRef<VRM | null>(null)
  const timerRef = useRef(new Timer())
  const simplexRef = useRef(new SimplexNoise())

  const isSpeakingRef = useRef(isSpeaking)
  const visemeWeightsRef = useRef(visemeWeights)
  const emotionRef = useRef(emotion)

  const onCanvasReadyRef = useRef(onCanvasReady)
  useEffect(() => { onCanvasReadyRef.current = onCanvasReady }, [onCanvasReady])

  useEffect(() => { isSpeakingRef.current = isSpeaking }, [isSpeaking])
  useEffect(() => { visemeWeightsRef.current = visemeWeights }, [visemeWeights])
  useEffect(() => { emotionRef.current = emotion }, [emotion])

  const blinkTimerRef = useRef(2 + Math.random() * 4)
  const blinkPhaseRef = useRef(0)
  const blinkValueRef = useRef(0)

  const emotionValuesRef = useRef<Record<string, number>>(
    Object.fromEntries(EMOTION_EXPRESSIONS.map(e => [e, 0]))
  )

  const lipValuesRef = useRef<Record<string, number>>(
    Object.fromEntries(Object.values(VISEME_MAP).map(e => [e, 0]))
  )

  const initScene = useCallback(() => {
    if (!containerRef.current) return

    // ─── シーン・カメラ・レンダラー ───
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    const camera = new THREE.PerspectiveCamera(
      30,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      20,
    )

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    })
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    containerRef.current.appendChild(renderer.domElement)

    onCanvasReadyRef.current?.(renderer.domElement)

    // ─── ライティング ───
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0)
    dirLight.position.set(1, 1, 1)
    scene.add(dirLight)
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))

    // ─── OrbitControls ───
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.1
    controls.rotateSpeed = 0.5
    controls.zoomSpeed = 0.8
    controls.panSpeed = 0.5
    controls.minDistance = 0.3
    controls.maxDistance = 5.0
    controls.maxPolarAngle = Math.PI * 0.85
    controls.minPolarAngle = Math.PI * 0.1

    // カメラ状態を復元 or デフォルト
    const savedCamera = loadCameraState()
    if (savedCamera) {
      camera.position.set(savedCamera.px, savedCamera.py, savedCamera.pz)
      controls.target.set(savedCamera.tx, savedCamera.ty, savedCamera.tz)
    } else {
      camera.position.copy(DEFAULT_CAMERA_POSITION)
      controls.target.copy(DEFAULT_CAMERA_TARGET)
    }
    controls.update()

    // カメラ操作終了時に保存（500ms デバウンス）
    let cameraSaveTimer: ReturnType<typeof setTimeout> | null = null
    controls.addEventListener('change', () => {
      if (cameraSaveTimer) clearTimeout(cameraSaveTimer)
      cameraSaveTimer = setTimeout(() => {
        saveCameraState(camera, controls.target)
      }, 500)
    })

    // ─── VRM の LookAt ターゲット（カメラ位置に追従）───
    const lookAtTarget = new THREE.Object3D()
    scene.add(lookAtTarget)

    // ─── VRM ロード ───
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    loader.load(VRM_MODEL_PATH, (gltf) => {
      const vrm = gltf.userData.vrm as VRM
      scene.add(vrm.scene)

      // ★ VRM 0.x モデルの場合のみ 180 度回転を適用
      // VRM 1.0 は Z+ 方向を向くため回転不要
      VRMUtils.rotateVRM0(vrm)

      // 初期ポーズを setNormalizedPose で適用
      vrm.humanoid.setNormalizedPose(BASE_POSE)

      if (vrm.lookAt) vrm.lookAt.target = lookAtTarget

      vrmRef.current = vrm
      console.log('[VRM] Model loaded:', vrm.meta)
    })

    // ─── アニメーションループ ───
    const timer = timerRef.current

    let animFrameId: number
    const animate = () => {
      animFrameId = requestAnimationFrame(animate)
      timer.update()
      const delta = timer.getDelta()
      const elapsed = timer.getElapsed()
      const vrm = vrmRef.current
      const simplex = simplexRef.current

      // OrbitControls 更新
      controls.update()

      // LookAt ターゲットをカメラ位置にスムーズ追従
      const lerpSpeed = 1.0 - Math.pow(0.001, delta)
      lookAtTarget.position.x += (camera.position.x - lookAtTarget.position.x) * lerpSpeed
      lookAtTarget.position.y += (camera.position.y - lookAtTarget.position.y) * lerpSpeed
      lookAtTarget.position.z += (camera.position.z - lookAtTarget.position.z) * lerpSpeed

      if (vrm && vrm.expressionManager && vrm.humanoid) {

        // 1. 呼吸 + Perlin ノイズ + 腕ポーズ → setNormalizedPose で一括適用
        const breathCycle = Math.sin(elapsed * 1.2)
        const breathIntensity = 0.012

        const animPose: VRMPose = {
          [VRMHumanBoneName.Spine]: {
            rotation: eulerToQuatArray(breathCycle * breathIntensity, 0, 0),
          },
          [VRMHumanBoneName.Chest]: {
            rotation: eulerToQuatArray(breathCycle * breathIntensity * 0.5, 0, 0),
          },
          [VRMHumanBoneName.Head]: {
            rotation: eulerToQuatArray(
              simplex.noise(elapsed * 0.3, 0) * 0.015,
              simplex.noise(0, elapsed * 0.25) * 0.02,
              simplex.noise(elapsed * 0.2, 10) * 0.008,
            ),
          },
          // ★ VRM 1.0: 腕を下ろす方向は LeftUpperArm = -Z, RightUpperArm = +Z
          [VRMHumanBoneName.LeftUpperArm]: {
            rotation: eulerToQuatArray(
              0, 0,
              -ARM_DOWN_ANGLE + simplex.noise(elapsed * 0.4, 20) * 0.005,
            ),
          },
          [VRMHumanBoneName.RightUpperArm]: {
            rotation: eulerToQuatArray(
              0, 0,
              ARM_DOWN_ANGLE + simplex.noise(elapsed * 0.35, 30) * 0.005,
            ),
          },
          [VRMHumanBoneName.LeftLowerArm]: {
            rotation: eulerToQuatArray(0, 0.15, 0),
          },
          [VRMHumanBoneName.RightLowerArm]: {
            rotation: eulerToQuatArray(0, -0.15, 0),
          },
        }

        vrm.humanoid.setNormalizedPose(animPose)

        // 2. 感情表現
        const currentEmotion = emotionRef.current || 'neutral'
        const targetExpression = EMOTION_MAP[currentEmotion]
        const emotionLerpUp = 3.0 * delta
        const emotionLerpDown = 2.0 * delta

        let eyeClosureFromEmotion = 0
        let emotionIsTransitioning = false
        let mouthInfluenceFromEmotion = 0

        for (const expr of EMOTION_EXPRESSIONS) {
          const currentVal = emotionValuesRef.current[expr] || 0
          let targetVal: number
          if (expr === targetExpression) {
            targetVal = (expr === VRMExpressionPresetName.Neutral) ? 0 : 1.0
          } else {
            targetVal = 0
          }
          const speed = targetVal > currentVal ? emotionLerpUp : emotionLerpDown
          const newVal = currentVal + (targetVal - currentVal) * Math.min(speed, 1.0)

          if (Math.abs(newVal - targetVal) > 0.05) {
            emotionIsTransitioning = true
          }

          emotionValuesRef.current[expr] = newVal

          if (expr !== VRMExpressionPresetName.Neutral) {
            vrm.expressionManager.setValue(expr, newVal)
          }

          if (newVal > 0.01 && EMOTION_EYE_CLOSURE[expr] !== undefined) {
            eyeClosureFromEmotion += EMOTION_EYE_CLOSURE[expr] * newVal
          }

          if (newVal > 0.01 && EMOTION_MOUTH_INFLUENCE[expr] !== undefined) {
            mouthInfluenceFromEmotion += EMOTION_MOUTH_INFLUENCE[expr] * newVal
          }
        }
        eyeClosureFromEmotion = Math.min(eyeClosureFromEmotion, 1.0)
        mouthInfluenceFromEmotion = Math.min(mouthInfluenceFromEmotion, 1.0)

        // 3. リップシンク
        const weights = visemeWeightsRef.current
        const speaking = isSpeakingRef.current
        const lipLerpSpeed = 10.0 * delta

        for (const [visemeKey, preset] of Object.entries(VISEME_MAP)) {
          const rawTarget = speaking ? (weights[visemeKey as VRMViseme] || 0) : 0
          const adjustedTarget = Math.max(0, rawTarget - mouthInfluenceFromEmotion * rawTarget * 0.5)
          const currentVal = lipValuesRef.current[preset] || 0
          const newVal = currentVal + (adjustedTarget - currentVal) * Math.min(lipLerpSpeed, 1.0)
          lipValuesRef.current[preset] = newVal

          if (speaking || newVal > 0.01) {
            vrm.expressionManager.setValue(preset, newVal)
          }
        }

        // 4. まばたき
        const blinkMaxValue = Math.max(0, 1.0 - eyeClosureFromEmotion)

        if (emotionIsTransitioning && blinkPhaseRef.current === 0) {
          blinkTimerRef.current = 0.5 + Math.random() * 1.0
        } else {
          blinkTimerRef.current -= delta

          if (blinkPhaseRef.current === 0 && blinkTimerRef.current <= 0) {
            blinkPhaseRef.current = 1
            blinkTimerRef.current = 0
          } else if (blinkPhaseRef.current === 1) {
            blinkValueRef.current += (blinkMaxValue - blinkValueRef.current) * Math.min(22 * delta, 1.0)
            if (blinkValueRef.current >= blinkMaxValue * 0.95) {
              blinkValueRef.current = blinkMaxValue
              blinkPhaseRef.current = 2
              blinkTimerRef.current = 0.03 + Math.random() * 0.02
            }
          } else if (blinkPhaseRef.current === 2) {
            blinkTimerRef.current -= delta
            if (blinkTimerRef.current <= 0) {
              blinkPhaseRef.current = 3
            }
          } else if (blinkPhaseRef.current === 3) {
            blinkValueRef.current += (0 - blinkValueRef.current) * Math.min(10 * delta, 1.0)
            if (blinkValueRef.current < 0.02) {
              blinkValueRef.current = 0
              blinkPhaseRef.current = 0
              blinkTimerRef.current = 2 + Math.random() * 4
            }
          }
        }

        vrm.expressionManager.setValue(VRMExpressionPresetName.Blink, blinkValueRef.current)

        // VRM update
        vrm.update(delta)
      }

      renderer.render(scene, camera)
    }
    animate()

    // ─── リサイズ ───
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return
      const w = containerRef.current.clientWidth
      const h = containerRef.current.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    resizeObserver.observe(containerRef.current)

    // ─── クリーンアップ ───
    return () => {
      cancelAnimationFrame(animFrameId)
      if (cameraSaveTimer) clearTimeout(cameraSaveTimer)
      controls.dispose()
      resizeObserver.disconnect()
      renderer.dispose()
      timer.dispose()
    }
  }, [])

  useEffect(() => {
    const cleanup = initScene()
    return cleanup
  }, [initScene])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: '500px' }}
    />
  )
}
