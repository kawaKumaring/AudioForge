/**
 * 목소리 고르기의 **묶음과 짧은 이름** — 규칙 한 곳 (2026-10-01).
 *
 * ★왜: 목록이 "Supertonic 여성 1 … Supertonic 남성 5, Qwen Sohee (GPU · 시작 느림)" 으로 한 줄씩 길게 늘어섰다.
 *   같은 낱말이 열 번 되풀이되고, 빠름/느림은 이름 속 괄호에 묻혀 있었다.
 *   엔진은 묶음 제목으로 한 번만 말하고, 칩에는 **고를 때 필요한 것만**(여성 1 · 소희) 남긴다.
 * 이름표 원본(label)은 그대로 둔다 — 칩의 툴팁·화면 읽기 프로그램이 그것을 읽는다.
 */
export interface VoiceLike { engineId: string; modelId: string; label: string; path: string }

export interface VoiceGroup<V extends VoiceLike> {
  key: string
  title: string
  /** 묶음 제목 옆의 짧은 설명(속도·장치). */
  note: string
  /** 칩이 넓어야 하는가(이름이 긴 묶음). */
  wide: boolean
  voices: Array<{ voice: V; short: string; tag: string }>
}

/** Qwen 화자 이름 → 한국어 이름(아는 것만). */
const QWEN_NAMES: Record<string, string> = { sohee: '소희' }

function supertonicShort(label: string): string {
  return label.replace(/^Supertonic\s*/i, '').trim() || label
}
function qwenShort(label: string): string {
  const m = /^Qwen\s+([^(]+?)\s*(\(|$)/i.exec(label)
  const name = (m?.[1] || label).trim()
  return QWEN_NAMES[name.toLowerCase()] || name
}
/** 여성 → 남성, 그 안에서 번호 차례. 모르는 이름은 뒤로(이름 차례). */
function supertonicOrder(short: string): [number, number, string] {
  const m = /^(여성|남성)\s*(\d+)$/.exec(short)
  return m ? [m[1] === '여성' ? 0 : 1, Number(m[2]), short] : [2, 0, short]
}

export function groupVoices<V extends VoiceLike>(list: readonly V[]): VoiceGroup<V>[] {
  const fast: VoiceGroup<V> = { key: 'fast', title: '빠른 기본 목소리', note: 'CPU · 곧바로 읽는다', wide: false, voices: [] }
  const slow: VoiceGroup<V> = { key: 'slow', title: '고품질 · 느림', note: '그래픽카드 · 첫 소리까지 몇 초', wide: true, voices: [] }
  const other: VoiceGroup<V> = { key: 'other', title: '다른 기본 목소리', note: '', wide: true, voices: [] }
  for (const v of list) {
    if (v.engineId === 'supertonic') fast.voices.push({ voice: v, short: supertonicShort(v.label), tag: '' })
    else if (v.engineId === 'qwen-custom') slow.voices.push({ voice: v, short: qwenShort(v.label), tag: 'GPU' })
    else other.voices.push({ voice: v, short: v.label, tag: '' })
  }
  fast.voices.sort((a, b) => {
    const x = supertonicOrder(a.short), y = supertonicOrder(b.short)
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2])
  })
  return [fast, slow, other].filter((g) => g.voices.length)
}
