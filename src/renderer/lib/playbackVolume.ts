// 재생 음량의 **단일 소유자** — 만들어지는 모든 소리 요소에 같은 값을 건다.
//
// 왜 한곳에 모으는가(2026-09-10 사용자 보고): 이 앱의 재생 지점은 네 곳이고
// (참조 구간 미리듣기 · 결과 트랙 · 목소리 미리듣기 · 감정 표본) 각자 자기 요소를 만든다.
// 음량을 각 자리에서 따로 챙기면 한 곳을 고칠 때마다 다른 곳이 최대로 남는다 —
// 실제로 네 곳 모두 기본값 1.0(최대)으로 나가고 있었다.
// 그래서 규칙은 하나다: **소리 요소를 만들면 이 파일에 등록한다.** 등록된 것은 항상 현재 음량이다.
//
// 보관은 설정 파일(`playbackVolume`)이고, 값의 해석은 shared/playbackVolume 이 정한다.
// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(app.store 의 같은 관례).
import { PLAYBACK_VOLUME_DEFAULT, PLAYBACK_VOLUME_STORAGE_KEY, normalizePlaybackVolume } from '../../shared/playbackVolume.ts'

/** 지금 음량. 설정을 읽기 전에도 재생이 일어날 수 있으므로 기본값에서 시작한다. */
let current = PLAYBACK_VOLUME_DEFAULT
/**
 * 등록된 소리 요소들. 약한 참조 집합이라 화면에서 사라진 요소를 붙잡지 않는다
 * (요소 수명은 각 화면이 소유한다 — 이 파일은 음량만 본다).
 */
const attached = new Set<WeakRef<HTMLMediaElement>>()
const listeners = new Set<(v: number) => void>()

function applyTo(el: HTMLMediaElement) {
  try { el.volume = current } catch { /* 요소가 이미 버려졌으면 할 일이 없다 */ }
}

/** 죽은 약한 참조를 걷어내며 살아 있는 요소에 지금 음량을 건다. */
function applyAll() {
  for (const ref of [...attached]) {
    const el = ref.deref()
    if (!el) { attached.delete(ref); continue }
    applyTo(el)
  }
}

/**
 * 이 요소를 음량 관리 아래 둔다. 지금 음량을 즉시 걸고, 이후 변경도 따라온다.
 * 같은 요소를 여러 번 넣어도 문제가 없다(값을 다시 걸 뿐이다).
 */
export function attachPlaybackVolume(el: HTMLMediaElement | null | undefined): void {
  if (!el) return
  applyTo(el)
  for (const ref of attached) if (ref.deref() === el) return
  attached.add(new WeakRef(el))
}

/** 소리 요소를 만들면서 곧바로 음량 관리 아래 둔다(만드는 자리에서 잊지 않도록). */
export function createManagedAudio(src?: string): HTMLAudioElement {
  const el = src ? new Audio(src) : new Audio()
  attachPlaybackVolume(el)
  return el
}

export function getPlaybackVolume(): number {
  return current
}

/**
 * 음량을 바꾼다 — 등록된 모든 요소에 즉시 반영하고 화면에 알린다.
 * **보관은 하지 않는다**(끄는 동안 디스크를 두드리지 않기 위해). 보관은 savePlaybackVolume 이 한다.
 */
export function setPlaybackVolume(v: unknown): number {
  current = normalizePlaybackVolume(v)
  applyAll()
  for (const fn of listeners) fn(current)
  return current
}

/** 음량이 바뀔 때 알려 준다(화면 표시용). 해제 함수를 돌려준다. */
export function onPlaybackVolumeChange(fn: (v: number) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 보관된 음량을 읽어 적용한다. 실패하면 기본값을 그대로 쓴다(재생을 막지 않는다). */
export async function loadPlaybackVolume(): Promise<number> {
  try {
    const got = await window.api.settings.get() as Record<string, unknown>
    const raw = got?.[PLAYBACK_VOLUME_STORAGE_KEY]
    if (raw !== null && raw !== undefined) return setPlaybackVolume(raw)
  } catch { /* 읽기 실패 = 보관된 값 없음으로 다룬다 */ }
  return current
}

/**
 * 지금 음량을 보관한다. 응답을 확인해 실패를 삼키지 않는다.
 * 슬라이더를 끄는 동안 매번 부르지 말고 **손을 뗀 뒤** 한 번 부른다(호출부의 몫).
 */
export async function savePlaybackVolume(): Promise<{ ok: boolean; code?: string }> {
  try {
    const r = (await window.api.settings.set(PLAYBACK_VOLUME_STORAGE_KEY, current)) as
      { ok?: boolean; code?: string } | undefined
    if (r && r.ok === false) return { ok: false, code: r.code }
    return { ok: true }
  } catch (e) {
    return { ok: false, code: (e as Error)?.name || 'SAVE_FAILED' }
  }
}
