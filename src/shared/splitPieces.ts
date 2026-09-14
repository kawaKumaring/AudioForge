// 분할 조각 — **저장 전에 보여 줄 것**과 **실제로 저장될 것**이 같도록 규칙을 한 곳에 둔다.
//
// ★화면이 보여 준 경계·이름이 실행 단계에서 달라지면 미리듣기가 거짓말이 된다.
//   그래서 경계·이름 규칙을 여기 하나만 두고, 파이썬(split_markers.build_pieces)이 같은 값을 낸다.
// ★여기서 경계를 새로 찾지 않는다. 화면이 확정한 마커를 **그대로** 조각으로 만든다.

export interface SplitPiece {
  /** 0부터. 이름의 번호는 index+1 이다 — 조각을 빼도 번호는 바뀌지 않는다. */
  index: number
  start: number
  end: number
  duration: number
  /** 파일 이름(확장자 제외). */
  name: string
  /** 화면에 보일 이름. */
  label: string
}

/** 파일 이름에 쓸 수 없는 글자를 뺀다(파이썬과 같은 규칙). */
export function safeLabel(label: string): string {
  return [...(label || '')].filter((c) => !'\/:*?"<>|'.includes(c)).join('').trim()
}

/**
 * 마커와 전체 길이로 조각을 만든다.
 * boundaries = [0, ...markers, total] — 인접한 두 값이 한 조각이다.
 */
export function buildPieces(markers: number[], totalSeconds: number, labels: string[] = []): SplitPiece[] {
  const bounds = [0, ...markers, totalSeconds]
  const out: SplitPiece[] = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const raw = (labels[i] || '').trim()
    const label = raw || `Track ${String(i + 1).padStart(2, '0')}`
    const safe = safeLabel(label)
    out.push({
      index: i, start: bounds[i], end: bounds[i + 1],
      duration: Math.max(0, bounds[i + 1] - bounds[i]),
      name: safe ? `${String(i + 1).padStart(2, '0')}_${safe}` : `track_${String(i + 1).padStart(2, '0')}`,
      label,
    })
  }
  return out
}

/** 저장할 조각만 — 고르지 않았으면 전부. 번호는 그대로 둔다(빼도 이름이 밀리지 않는다). */
export function selectedPieces(pieces: SplitPiece[], selected: number[] | null): SplitPiece[] {
  if (!selected) return pieces
  const set = new Set(selected)
  return pieces.filter((p) => set.has(p.index))
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
