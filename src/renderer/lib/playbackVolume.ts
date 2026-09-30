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
// @ts-ignore TS5097
import { PLAYBACK_RATE_DEFAULT, PLAYBACK_RATE_STORAGE_KEY, normalizePlaybackRate } from '../../shared/playbackRate.ts'

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
  // ★소리가 나기 시작하면 알린다 — '지금 소리를 내는 자리' 를 앱이 하나로 지키기 위해서다.
  //   등록부가 이미 모든 요소를 알고 있으므로, 각 화면이 따로 챙기지 않아도 된다.
  // 진짜 DOM 요소일 때만 건다 — 검사에서 쓰는 대역 객체는 이 자리가 없다.
  if (typeof el.addEventListener === 'function') {
    el.addEventListener('play', () => { for (const cb of playListeners) cb(el) })
  }
}

/** 재생이 시작될 때 알린다. 화면이 '소리 낼 자리' 를 가져가는 근거로 쓴다. */
const playListeners = new Set<(el: HTMLMediaElement) => void>()
export function onManagedPlay(cb: (el: HTMLMediaElement) => void): () => void {
  playListeners.add(cb)
  return () => { playListeners.delete(cb) }
}

/**
 * 등록된 소리 요소를 **모두 멈춘다.** 다른 자리가 소리를 가져갈 때 부른다.
 * ★멈추기만 한다 — 위치도 음량도 건드리지 않는다(이어 듣기를 빼앗지 않는다).
 */
export function pauseManagedAudio(): void {
  for (const ref of [...attached]) {
    const el = ref.deref()
    if (!el) { attached.delete(ref); continue }
    try { if (!el.paused) el.pause() } catch { /* 이미 버려진 요소 */ }
  }
}

/**
 * 소리 요소를 만들면서 곧바로 음량 관리 아래 둔다(만드는 자리에서 잊지 않도록).
 * `readAloud: true` — **낭독 소리**(책 읽기·낭독 목소리 들어 보기)면 재생 빠르기도 건다.
 * ★낭독 전용이다(2026-10-01 지시: "낭독배속은 낭독에서만 사용하는 기능이다") — 생성본·최종 음성·더빙·원본에는 걸지 않는다.
 */
export function createManagedAudio(src?: string, opts: { readAloud?: boolean } = {}): HTMLAudioElement {
  const el = src ? new Audio(src) : new Audio()
  attachPlaybackVolume(el)
  if (opts.readAloud) markMadeSound(el)
  return el
}

// ── 재생 빠르기 — 낭독 소리에만 (2026-09-30 지시 · 10-01 낭독 전용으로 좁힘) ─────────────────────────
// ★다시 만들지 않는다. 재생할 때만 빠르기를 바꾸고 음 높이는 그대로(preservesPitch).
// ★`src` 를 바꾸면 요소가 빠르기를 **기본 빠르기로 되돌린다**(미디어 불러오기 규칙) — 그래서 기본 빠르기도 함께 건다.
//   그러지 않으면 낭독이 다음 조각으로 넘어갈 때마다 1배로 돌아간다.
let currentRate = PLAYBACK_RATE_DEFAULT
const madeSounds = new Set<WeakRef<HTMLMediaElement>>()
const rateListeners = new Set<(v: number) => void>()

function applyRateTo(el: HTMLMediaElement) {
  try {
    ;(el as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = true
    el.defaultPlaybackRate = currentRate
    el.playbackRate = currentRate
  } catch { /* 버려진 요소 */ }
}

/** 이 요소는 앱이 만든 소리다 — 지금 빠르기를 걸고 이후 변경도 따라온다. */
export function markMadeSound(el: HTMLMediaElement | null | undefined): void {
  if (!el) return
  applyRateTo(el)
  for (const ref of madeSounds) if (ref.deref() === el) return
  madeSounds.add(new WeakRef(el))
}

export function getPlaybackRate(): number {
  return currentRate
}

/** 빠르기를 바꾼다 — 만들어진 소리 요소 모두에 즉시(재생 중이어도) 걸고 화면에 알린다. 보관은 savePlaybackRate. */
export function setPlaybackRate(v: unknown): number {
  currentRate = normalizePlaybackRate(v)
  for (const ref of [...madeSounds]) {
    const el = ref.deref()
    if (!el) { madeSounds.delete(ref); continue }
    applyRateTo(el)
  }
  for (const fn of rateListeners) fn(currentRate)
  return currentRate
}

export function onPlaybackRateChange(fn: (v: number) => void): () => void {
  rateListeners.add(fn)
  return () => { rateListeners.delete(fn) }
}

export async function loadPlaybackRate(): Promise<number> {
  try {
    const got = await window.api.settings.get() as Record<string, unknown>
    const raw = got?.[PLAYBACK_RATE_STORAGE_KEY]
    if (raw !== null && raw !== undefined) return setPlaybackRate(raw)
  } catch { /* 읽기 실패 = 보관된 값 없음 */ }
  return currentRate
}

export async function savePlaybackRate(): Promise<{ ok: boolean; code?: string }> {
  try {
    const r = (await window.api.settings.set(PLAYBACK_RATE_STORAGE_KEY, currentRate)) as
      { ok?: boolean; code?: string } | undefined
    if (r && r.ok === false) return { ok: false, code: r.code }
    return { ok: true }
  } catch (e) {
    return { ok: false, code: (e as Error)?.name || 'SAVE_FAILED' }
  }
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
