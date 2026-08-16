// 무음 감지 — Python python/audio_utils.py `trim_silence`의 감지/세그먼트 로직을 충실히 복제.
// 미리보기가 실제 처리와 어긋나지 않으려면 파라미터·알고리즘이 동일해야 한다(설계 §5).
//   프레임 20ms, 홉 10ms, 임계 -40dB, 50ms(5프레임) 미만 무음은 말소리로 병합.
//   말소리 세그먼트는 [start*hop, end*hop+frameLen)로 잡히고(끝에 frameLen 유지),
//   제거되는 무음 = 이 세그먼트들의 여집합. (경계당 frameLen 오차를 피하려면 반드시 여집합으로 계산.)
// ⚠️ 이 상수/로직을 바꾸면 Python도 함께 바꿔야 한다. 일치는 검증 스크립트로 확인(제거 총량 대조).

export interface SilenceRegion {
  start: number // 초
  end: number   // 초
}

export interface SilenceAnalysis {
  regions: SilenceRegion[] // 제거될 무음 구간
  totalDur: number         // 원본 길이(초)
  speechDur: number        // 남을 말소리 총 길이(초)
  speechSegments: number   // 말소리 세그먼트 수(삽입 간격 계산용)
}

/**
 * @param channel 모노 채널 데이터(AudioBuffer.getChannelData(0))
 * @param sr 샘플레이트
 * @param thresholdDb 감지 임계(기본 -40dB = Python 기본값)
 */
export function detectSilence(channel: Float32Array, sr: number, thresholdDb = -40): SilenceAnalysis {
  const totalSamples = channel.length
  const totalDur = totalSamples / sr
  const frameLen = Math.floor(0.02 * sr)
  const hop = Math.max(1, Math.floor(frameLen / 2))
  const nFrames = Math.max(1, Math.floor((totalSamples - frameLen) / hop) + 1)
  const threshold = Math.pow(10, thresholdDb / 20)

  const isSpeech = new Uint8Array(nFrames)
  for (let i = 0; i < nFrames; i++) {
    const base = i * hop
    let sum = 0
    for (let j = 0; j < frameLen; j++) {
      const v = channel[base + j] || 0
      sum += v * v
    }
    isSpeech[i] = Math.sqrt(sum / frameLen) > threshold ? 1 : 0
  }

  // 50ms 미만 무음은 말소리로 병합 (Python: min_silence_frames = int(100/20) = 5)
  const minSilenceFrames = Math.floor(100 / 20)
  {
    let i = 0
    while (i < nFrames) {
      if (!isSpeech[i]) {
        let j = i
        while (j < nFrames && !isSpeech[j]) j++
        if (j - i < minSilenceFrames) for (let k = i; k < j; k++) isSpeech[k] = 1
        i = j
      } else i++
    }
  }

  // 말소리 세그먼트(샘플 단위) — Python과 동일: [segStart*hop, i*hop+frameLen)
  const speech: Array<[number, number]> = []
  let inSeg = false
  let segStart = 0
  for (let i = 0; i < nFrames; i++) {
    if (isSpeech[i] && !inSeg) { segStart = i; inSeg = true }
    else if (!isSpeech[i] && inSeg) { speech.push([segStart * hop, i * hop + frameLen]); inSeg = false }
  }
  if (inSeg) speech.push([segStart * hop, totalSamples])

  // Python: 세그먼트가 하나도 없으면 원본 그대로 반환(무음 제거 안 함)
  if (speech.length === 0) {
    return { regions: [], totalDur, speechDur: totalDur, speechSegments: 0 }
  }

  // 제거되는 무음 = 말소리 세그먼트의 여집합
  const regions: SilenceRegion[] = []
  let cursor = 0
  for (const [s, e] of speech) {
    const segEnd = Math.min(e, totalSamples)
    if (s > cursor) regions.push({ start: cursor / sr, end: s / sr })
    cursor = Math.max(cursor, segEnd)
  }
  if (cursor < totalSamples) regions.push({ start: cursor / sr, end: totalSamples / sr })

  const removed = regions.reduce((a, r) => a + (r.end - r.start), 0)
  return { regions, totalDur, speechDur: Math.max(0, totalDur - removed), speechSegments: speech.length }
}

/** 처리 후 예상 길이(초). 남을 말소리 + 세그먼트 사이 삽입 무음(silenceGap*(세그먼트수-1)). */
export function estimateProcessedDuration(a: SilenceAnalysis, silenceGapSec: number): number {
  const gaps = Math.max(0, a.speechSegments - 1)
  return a.speechDur + gaps * silenceGapSec
}
