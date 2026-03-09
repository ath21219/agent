'use client'

import { useEffect, useRef, useCallback } from 'react'
import * as THREE from 'three'
import { Timer } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js'
import {
  VRMLoaderPlugin,
  VRM,
  VRMExpressionPresetName,
  VRMHumanBoneName,
} from '@pixiv/three-vrm'
import type { VRMViseme } from '@/lib/lipsync'

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

// ★ 感情ごとの瞼の閉じ度合い（0=開, 1=完全に閉じ）
// この値だけまばたきの最大振れ幅を制限する
const EMOTION_EYE_CLOSURE: Record<string, number> = {
  [VRMExpressionPresetName.Happy]: 0.7,  // 笑顔で目を細める → 残り 0.3 分だけまばたき可能
  [VRMExpressionPresetName.Sad]: 0.2,
  [VRMExpressionPresetName.Angry]: 0.3,
  [VRMExpressionPresetName.Surprised]: 0.0,  // 目を見開く → まばたき制限なし（むしろ開いている）
  [VRMExpressionPresetName.Neutral]: 0.0,
}

// ★ 感情ごとの口への影響度（0=口に影響しない, 1=口を大きく使う）
// リップシンクの値からこの分を差し引いて加算を相殺する
const EMOTION_MOUTH_INFLUENCE: Record<string, number> = {
  [VRMExpressionPresetName.Happy]: 0.3,  // 笑顔は口角を上げるが大きくは開けない
  [VRMExpressionPresetName.Sad]: 0.1,
  [VRMExpressionPresetName.Angry]: 0.15,
  [VRMExpressionPresetName.Surprised]: 0.5,  // 驚きは口を大きく開ける
  [VRMExpressionPresetName.Neutral]: 0.0,
}

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

  useEffect(() => { isSpeakingRef.current = isSpeaking }, [isSpeaking])
  useEffect(() => { visemeWeightsRef.current = visemeWeights }, [visemeWeights])
  useEffect(() => { emotionRef.current = emotion }, [emotion])

  const mouseRef = useRef({ x: 0, y: 0 })

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

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1a2e)

    const camera = new THREE.PerspectiveCamera(
      30,
      containerRef.current.clientWidth / containerRef.current.clientHeight,
      0.1,
      20
    )
    camera.position.set(0, 1.3, 1.5)
    camera.lookAt(0, 1.2, 0)

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,  // ← 追加: toDataURL() でキャプチャ可能にする
    })
    renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    containerRef.current.appendChild(renderer.domElement)

    if (onCanvasReady) {
      onCanvasReady(renderer.domElement)
    }

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0)
    dirLight.position.set(1, 1, 1)
    scene.add(dirLight)
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))

    const lookAtTarget = new THREE.Object3D()
    camera.add(lookAtTarget)
    scene.add(camera)

    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))

    loader.load('/models/agent.vrm', (gltf) => {
      const vrm = gltf.userData.vrm as VRM
      scene.add(vrm.scene)
      vrm.scene.rotation.y = Math.PI

      const leftUpperArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm)
      const rightUpperArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm)
      if (leftUpperArm) leftUpperArm.rotation.z = 1.2
      if (rightUpperArm) rightUpperArm.rotation.z = -1.2
      const leftLowerArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm)
      const rightLowerArm = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm)
      if (leftLowerArm) leftLowerArm.rotation.y = -0.15
      if (rightLowerArm) rightLowerArm.rotation.y = 0.15

      if (vrm.lookAt) vrm.lookAt.target = lookAtTarget

      vrmRef.current = vrm
      console.log('[VRM] Model loaded:', vrm.meta)
    })

    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current.x = 10.0 * ((e.clientX - 0.5 * window.innerWidth) / window.innerHeight)
      mouseRef.current.y = -10.0 * ((e.clientY - 0.5 * window.innerHeight) / window.innerHeight)
    }
    window.addEventListener('mousemove', handleMouseMove)

    const timer = timerRef.current

    let animFrameId: number
    const animate = () => {
      animFrameId = requestAnimationFrame(animate)
      timer.update()
      const delta = timer.getDelta()
      const elapsed = timer.getElapsed()
      const vrm = vrmRef.current
      const simplex = simplexRef.current

      if (vrm && vrm.expressionManager && vrm.humanoid) {

        // ══════════════════════════════════════
        // 1. 呼吸
        // ══════════════════════════════════════
        const breathCycle = Math.sin(elapsed * 1.2)
        const breathIntensity = 0.012
        const spineNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine)
        if (spineNode) spineNode.rotation.x = breathCycle * breathIntensity
        const chestNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Chest)
        if (chestNode) chestNode.rotation.x = breathCycle * breathIntensity * 0.5

        // ══════════════════════════════════════
        // 2. Perlin ノイズ微細揺れ
        // ══════════════════════════════════════
        const headNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head)
        if (headNode) {
          headNode.rotation.x = simplex.noise(elapsed * 0.3, 0) * 0.015
          headNode.rotation.y = simplex.noise(0, elapsed * 0.25) * 0.02
          headNode.rotation.z = simplex.noise(elapsed * 0.2, 10) * 0.008
        }
        const leftUpperArmNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm)
        const rightUpperArmNode = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm)
        if (leftUpperArmNode) leftUpperArmNode.rotation.z = 1.2 + simplex.noise(elapsed * 0.4, 20) * 0.005
        if (rightUpperArmNode) rightUpperArmNode.rotation.z = -1.2 + simplex.noise(elapsed * 0.35, 30) * 0.005

        // ══════════════════════════════════════
        // 3. 視線追従
        // ══════════════════════════════════════
        const lerpSpeed = 1.0 - Math.pow(0.001, delta)
        lookAtTarget.position.x += (mouseRef.current.x - lookAtTarget.position.x) * lerpSpeed
        lookAtTarget.position.y += (mouseRef.current.y - lookAtTarget.position.y) * lerpSpeed

        // ══════════════════════════════════════
        // 4. ★ 感情表現（常にフル強度）
        // ══════════════════════════════════════
        const currentEmotion = emotionRef.current || 'neutral'
        const targetExpression = EMOTION_MAP[currentEmotion]
        const emotionLerpUp = 3.0 * delta
        const emotionLerpDown = 2.0 * delta

        let eyeClosureFromEmotion = 0
        let emotionIsTransitioning = false
        let mouthInfluenceFromEmotion = 0  // ★ 感情が口に与えている影響度

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

          // ★ 感情を常にフル強度で設定（スケーリングしない）
          if (expr !== VRMExpressionPresetName.Neutral) {
            vrm.expressionManager.setValue(expr, newVal)
          }

          // 瞼の閉じ度合い
          if (newVal > 0.01 && EMOTION_EYE_CLOSURE[expr] !== undefined) {
            eyeClosureFromEmotion += EMOTION_EYE_CLOSURE[expr] * newVal
          }

          // ★ 口への影響度を加重平均
          if (newVal > 0.01 && EMOTION_MOUTH_INFLUENCE[expr] !== undefined) {
            mouthInfluenceFromEmotion += EMOTION_MOUTH_INFLUENCE[expr] * newVal
          }
        }
        eyeClosureFromEmotion = Math.min(eyeClosureFromEmotion, 1.0)
        mouthInfluenceFromEmotion = Math.min(mouthInfluenceFromEmotion, 1.0)

        // ══════════════════════════════════════
        // 5. ★ リップシンク（感情の口影響分を差し引き）
        // ══════════════════════════════════════
        const weights = visemeWeightsRef.current
        const speaking = isSpeakingRef.current
        const lipLerpSpeed = 10.0 * delta

        for (const [visemeKey, preset] of Object.entries(VISEME_MAP)) {
          const rawTarget = speaking ? (weights[visemeKey as VRMViseme] || 0) : 0

          // ★ 感情が口に与えている分を差し引いて加算の過剰を防ぐ
          // ただし 0 以下にはしない（口は閉じる方向には行かない）
          const adjustedTarget = Math.max(0, rawTarget - mouthInfluenceFromEmotion * rawTarget * 0.5)

          const currentVal = lipValuesRef.current[preset] || 0
          const newVal = currentVal + (adjustedTarget - currentVal) * Math.min(lipLerpSpeed, 1.0)
          lipValuesRef.current[preset] = newVal

          if (speaking || newVal > 0.01) {
            vrm.expressionManager.setValue(preset, newVal)
          }
        }

        // ══════════════════════════════════════
        // 6. ★ 自然なまばたき
        // ══════════════════════════════════════
        const blinkMaxValue = Math.max(0, 1.0 - eyeClosureFromEmotion)

        // 感情遷移中は新しいまばたきを開始しない
        if (emotionIsTransitioning && blinkPhaseRef.current === 0) {
          blinkTimerRef.current = 0.5 + Math.random() * 1.0
        } else {
          blinkTimerRef.current -= delta

          if (blinkPhaseRef.current === 0 && blinkTimerRef.current <= 0) {
            // ★ 閉じフェーズ開始
            blinkPhaseRef.current = 1
            blinkTimerRef.current = 0  // 補間で閉じるのでタイマーは経過時間の追跡用
          } else if (blinkPhaseRef.current === 1) {
            // ★ 滑らかに閉じる
            blinkValueRef.current += (blinkMaxValue - blinkValueRef.current) * Math.min(22 * delta, 1.0)
            if (blinkValueRef.current >= blinkMaxValue * 0.95) {
              blinkValueRef.current = blinkMaxValue
              blinkPhaseRef.current = 2
              blinkTimerRef.current = 0.03 + Math.random() * 0.02  // ★ 閉じた状態を少し維持
            }
          } else if (blinkPhaseRef.current === 2) {
            // ★ 閉じた状態を維持
            blinkTimerRef.current -= delta
            if (blinkTimerRef.current <= 0) {
              blinkPhaseRef.current = 3
            }
          } else if (blinkPhaseRef.current === 3) {
            // ★ 滑らかに開く（閉じるより少しゆっくり）
            blinkValueRef.current += (0 - blinkValueRef.current) * Math.min(10 * delta, 1.0)
            if (blinkValueRef.current < 0.02) {
              blinkValueRef.current = 0
              blinkPhaseRef.current = 0
              blinkTimerRef.current = 2 + Math.random() * 4
            }
          }
        }

        vrm.expressionManager.setValue(VRMExpressionPresetName.Blink, blinkValueRef.current)

        // ══════════════════════════════════════
        // VRM update
        // ══════════════════════════════════════
        vrm.update(delta)
      }

      renderer.render(scene, camera)
    }
    animate()

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current) return
      const w = containerRef.current.clientWidth
      const h = containerRef.current.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      cancelAnimationFrame(animFrameId)
      window.removeEventListener('mousemove', handleMouseMove)
      resizeObserver.disconnect()
      renderer.dispose()
      timer.dispose()
    }
  }, [onCanvasReady])

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
