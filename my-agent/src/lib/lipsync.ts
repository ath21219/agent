// src/lib/lipsync.ts

export type VRMViseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'sil'

interface FrequencyBand {
  low: number
  high: number
}

const BANDS = {
  f1Low: { low: 250, high: 500 } as FrequencyBand,
  f1High: { low: 600, high: 1000 } as FrequencyBand,
  f2Low: { low: 800, high: 1300 } as FrequencyBand,
  f2High: { low: 1800, high: 2800 } as FrequencyBand,
}

export class LipsyncAnalyser {
  private analyser: AnalyserNode
  private sampleRate: number
  private frequencyData: Uint8Array<ArrayBuffer>
  private smoothedViseme: Record<VRMViseme, number>
  private currentViseme: VRMViseme = 'sil'

  private silenceThreshold = 15
  private smoothingUp = 0.5
  private smoothingDown = 0.25

  constructor(analyser: AnalyserNode) {
    this.analyser = analyser
    this.sampleRate = analyser.context.sampleRate
    this.frequencyData = new Uint8Array(analyser.frequencyBinCount)
    this.smoothedViseme = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, sil: 0 }
  }

  private getBandEnergy(band: FrequencyBand): number {
    const binCount = this.analyser.frequencyBinCount
    const nyquist = this.sampleRate / 2
    const binWidth = nyquist / binCount
    const lowBin = Math.floor(band.low / binWidth)
    const highBin = Math.min(Math.ceil(band.high / binWidth), binCount - 1)
    let sum = 0
    let count = 0
    for (let i = lowBin; i <= highBin; i++) {
      sum += this.frequencyData[i]
      count++
    }
    return count > 0 ? sum / count : 0
  }

  private getOverallEnergy(): number {
    let sum = 0
    for (let i = 0; i < this.frequencyData.length; i++) {
      sum += this.frequencyData[i]
    }
    return sum / this.frequencyData.length
  }

  private detectVisemeRaw(): Record<VRMViseme, number> {
    const f1Low = this.getBandEnergy(BANDS.f1Low)
    const f1High = this.getBandEnergy(BANDS.f1High)
    const f2Low = this.getBandEnergy(BANDS.f2Low)
    const f2High = this.getBandEnergy(BANDS.f2High)
    const overall = this.getOverallEnergy()

    if (overall < this.silenceThreshold) {
      return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, sil: 1 }
    }

    const f1Ratio = f1High / (f1Low + f1High + 0.01)
    const f2Ratio = f2High / (f2Low + f2High + 0.01)

    const aa = Math.pow(f1Ratio, 1.5) * (1 - Math.abs(f2Ratio - 0.5) * 1.5)
    const ih = Math.pow(1 - f1Ratio, 1.2) * Math.pow(f2Ratio, 1.5)
    const ou = Math.pow(1 - f1Ratio, 1.2) * Math.pow(1 - f2Ratio, 1.5)
    const ee = (1 - Math.abs(f1Ratio - 0.45) * 2.5) * Math.pow(f2Ratio, 1.2)
    const oh = Math.pow(f1Ratio, 0.8) * Math.pow(1 - f2Ratio, 1.2)

    const scores = { aa, ih, ou, ee, oh }
    const maxScore = Math.max(...Object.values(scores))

    const boosted: Record<string, number> = {}
    for (const [key, val] of Object.entries(scores)) {
      boosted[key] = val >= maxScore * 0.8
        ? Math.pow(val, 0.7)
        : val * 0.3
    }

    const total = Object.values(boosted).reduce((a, b) => a + b, 0)
    if (total < 0.001) {
      return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, sil: 1 }
    }

    return {
      aa: boosted.aa / total,
      ih: boosted.ih / total,
      ou: boosted.ou / total,
      ee: boosted.ee / total,
      oh: boosted.oh / total,
      sil: 0,
    }
  }

  update(): { viseme: VRMViseme; weights: Record<VRMViseme, number> } {
    this.analyser.getByteFrequencyData(this.frequencyData)
    const raw = this.detectVisemeRaw()

    for (const key of Object.keys(raw) as VRMViseme[]) {
      const target = raw[key]
      const current = this.smoothedViseme[key]
      const factor = target > current ? this.smoothingUp : this.smoothingDown
      this.smoothedViseme[key] = current + (target - current) * factor
    }

    let maxWeight = 0
    let maxViseme: VRMViseme = 'sil'
    for (const [key, weight] of Object.entries(this.smoothedViseme)) {
      if (weight > maxWeight) {
        maxWeight = weight
        maxViseme = key as VRMViseme
      }
    }
    this.currentViseme = maxViseme

    return { viseme: this.currentViseme, weights: { ...this.smoothedViseme } }
  }

  getCurrentViseme(): VRMViseme {
    return this.currentViseme
  }
}
