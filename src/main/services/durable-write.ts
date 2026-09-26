/**
 * 사용자 데이터 파일을 **끊겨도 잃지 않게** 쓴다 — 임시본 → 디스크 확정 → 이름 바꾸기.
 *
 * ★왜 생겼나(2026-09-24 2차 감사)
 *   더빙 번역문(`lines.json`)이 `writeFileSync` 로 최종 경로를 곧바로 열고 있었다.
 *   쓰다 끊기면 사람이 손본 번역문뿐 아니라 **같은 파일에 실린 원문·시각·낱말 시각까지**
 *   한꺼번에 사라지고, 잘린 파일이 그대로 남는다.
 *
 *   이 저장소는 같은 사고를 **이미 겪고** 설정 저장에서 이 패턴을 버렸다.
 *   그런데 옳은 방식이 **재사용 가능한 물건으로 존재하지 않았다** — 설정은 함수 안에
 *   인라인으로, 참조 저장소와 참조 전사는 각자 module-private 사본으로 갖고 있었고
 *   **셋 다 export 되어 있지 않았다.** 그래서 새로 저장 자리를 만드는 사람 손에 닿는
 *   것은 `fs.writeFileSync` 뿐이었다. 그것이 뿌리다.
 *
 * ★기존 사본 셋을 여기로 모으지 않는다(일부러)
 *   · `settings-store` 의 임시본 이름 `.settings.<pid>.tmp` 는 **검사가 그 이름을 그대로**
 *     폴더로 막아 '교체 실패가 성공으로 보고되지 않음' 을 확인한다. 이름을 바꾸면
 *     그 검사가 막으려던 경로를 더는 막지 못한다.
 *   · `reference-store` 의 임시본 이름은 runId 로 지어져 **run 단위 청소 계약**에 묶여 있다.
 *   합치는 것이 옳아 보여도, 합치면 있는 보증이 조용히 사라진다. 새 자리부터 이것을 쓴다.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync,
} from 'fs'
import { basename, dirname, join } from 'path'

/** 파일 하나를 쓰고 **디스크에 확정**한다(fsync). 이름 바꾸기는 하지 않는다. */
export function writeFileDurable(path: string, data: string): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export interface AtomicReplaceOptions {
  /**
   * 승격 전에 임시본을 **되읽어** 확인한다. 던지면 승격하지 않는다.
   * 기본값은 JSON 으로 파싱되는지 보는 것 — 깨진 것을 승격하지 않는다.
   */
  verify?: ((text: string) => void) | null
}

/** 기본 확인 — JSON 으로 읽히는지. */
function verifyJson(text: string): void {
  JSON.parse(text)
}

/**
 * 같은 폴더의 임시본에 쓰고, 확인한 뒤 **이름을 바꿔 교체**한다.
 *
 * 실패하면 던진다. 그때 **기존 파일의 바이트는 그대로다** — 이름 바꾸기 전에 멈추므로.
 * 임시본은 지운다(지우지 못하면 임시본만 남는다 — 그것이 최악이다).
 *
 * 임시본은 반드시 **같은 폴더**에 만든다. 다른 볼륨이면 이름 바꾸기가 원자적이지 않다.
 */
export function replaceFileAtomically(path: string, data: string, opts: AtomicReplaceOptions = {}): void {
  const dir = dirname(path)
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`)
  const verify = opts.verify === undefined ? verifyJson : opts.verify
  try {
    mkdirSync(dir, { recursive: true })
    writeFileDurable(temp, data)
    if (verify) verify(readFileSync(temp, 'utf-8'))
    renameSync(temp, path)
  } catch (err) {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* 임시본 잔존만 남는다 */ }
    throw err
  }
}
