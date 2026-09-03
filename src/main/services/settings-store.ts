/**
 * `settings.json` 원자 저장 — main 이 소유하는 키 단위 병합.
 *
 * 왜 별 모듈인가: 이 동작은 **실패했을 때 무엇이 남는가**가 전부다. 예전 구현은 평범한
 * `writeFileSync` 였고, 쓰다 죽으면 잘린 파일 하나가 `pythonPath` 까지 함께 날렸다.
 * 그 성질은 실제 파일로 눌러 봐야 확인되므로 electron 을 import 하지 않는 자리에 떼어
 * 놓고 `node --test` 로 직접 검증한다.
 *
 * 계약
 *   · renderer 는 **키 하나와 값 하나**만 보낸다. 설정 전체 사본을 보내지 않는다 —
 *     오래된 사본을 되쓰면 그 사이 다른 키가 되돌아간다.
 *   · main 이 **현재 파일을 읽어** 허용된 키 하나만 갱신한다.
 *   · 임시본은 **같은 폴더**(같은 볼륨)에 만들고 flush 한 뒤 rename 으로 교체한다.
 *   · 실패하면 기존 파일 바이트가 그대로 남는다. 실패를 성공으로 보고하지 않는다.
 *
 * 저장 위치는 호출부가 준다(테스트가 임시 폴더를 쓰고, 앱은 userData 를 쓴다).
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeSync,
} from 'fs'
import { dirname, join } from 'path'

/** 설정 파일을 읽을 때 나올 수 있는 결과. 손상을 빈 설정과 구분한다. */
export type SettingsReadResult =
  | { kind: 'ok'; settings: Record<string, unknown> }
  | { kind: 'absent' }
  /** JSON 자체가 깨졌다. **덮어쓰지 않는다** — 사용자가 복구할 원본을 남긴다. */
  | { kind: 'corrupt'; reason: string }

export function readSettingsFile(path: string): SettingsReadResult {
  if (!existsSync(path)) return { kind: 'absent' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    return { kind: 'corrupt', reason: `READ_FAILED:${(err as Error).name}` }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'corrupt', reason: 'NOT_AN_OBJECT' }
    }
    return { kind: 'ok', settings: parsed as Record<string, unknown> }
  } catch {
    return { kind: 'corrupt', reason: 'JSON_PARSE_FAILED' }
  }
}

export type SettingsWriteResult =
  | { ok: true }
  /**
   * 저장하지 않았다. `preserved` 는 기존 파일을 건드리지 않았다는 뜻이다 —
   * renderer 는 이 결과를 받으면 상태를 persisted 로 표시해서는 안 된다.
   */
  | { ok: false; code: string; preserved: boolean }

/**
 * 허용된 키 하나만 갱신해 원자적으로 교체한다.
 *
 * 기존 파일이 **손상**이면 저장하지 않는다. 손상본을 읽어 병합하면 다른 키를 잃고,
 * 덮어쓰면 사용자가 복구할 원본이 사라진다. 둘 다 하지 않고 사유를 돌려준다.
 *
 * `value === undefined` 는 그 키를 지우는 것이다(없는 키를 지우는 것도 성공이다).
 */
export function setSettingsKey(
  path: string, key: string, value: unknown
): SettingsWriteResult {
  const current = readSettingsFile(path)
  if (current.kind === 'corrupt') {
    return { ok: false, code: `SETTINGS_CORRUPT:${current.reason}`, preserved: true }
  }
  const next: Record<string, unknown> =
    current.kind === 'ok' ? { ...current.settings } : {}
  if (value === undefined) delete next[key]
  else next[key] = value

  const dir = dirname(path)
  // 임시본은 반드시 같은 폴더에 — 다른 볼륨이면 rename 이 원자적이지 않다.
  const temp = join(dir, `.settings.${process.pid}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, JSON.stringify(next, null, 2))
      fsyncSync(fd)          // 여기까지 왔으면 임시본 내용이 디스크에 있다
    } finally {
      closeSync(fd)
    }
    // 되읽어 검증한다 — 깨진 것을 승격하지 않는다.
    const back = readSettingsFile(temp)
    if (back.kind !== 'ok') {
      throw new Error(`TEMP_UNREADABLE:${back.kind}`)
    }
    renameSync(temp, path)   // 같은 볼륨 교체. Windows 에서도 기존 대상을 대체한다
    return { ok: true }
  } catch (err) {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* 임시본 잔존만 남는다 */ }
    // 실패를 삼키지 않는다. 기존 파일은 rename 전이므로 바이트가 그대로다.
    return { ok: false, code: `SETTINGS_WRITE_FAILED:${(err as Error).name}`, preserved: true }
  }
}
