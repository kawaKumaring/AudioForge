/**
 * 최종 연결 파일이 **입력 생성본 위에 저장되지 못하게** 막는다.
 *
 * ★왜 필요한가 (2026-09-27 검수 1항 [P1])
 *   `card_join` 은 임시 파일에 쓴 뒤 `os.replace` 로 자리를 바꾼다. 그 자리가 입력 생성본이면
 *   **읽기만 했다는 주석과 무관하게** 마지막 교체에서 원본이 사라진다.
 *   재현: A+B 를 이으면서 저장 자리를 A 로 고르면 ok=true 로 A 가 0.25초→0.5초가 됐다.
 *
 * ★왜 이름 비교로는 부족한가
 *   Windows 는 같은 파일을 여러 이름으로 부른다 — 대소문자(`A.wav`/`a.wav`),
 *   구분자(`\` / `/`), 상대 경로, `..` 을 지나는 길, 8.3 단축 이름, 하드링크, 접합.
 *   그래서 **파일 고유 번호(장치+색인)를 먼저 본다.** 번호를 얻을 수 없을 때만 이름을 정규화해
 *   비교한다. 둘 중 하나라도 같다고 하면 같은 파일로 본다 — 막는 쪽으로 기운다.
 *
 * ★무엇을 막고 무엇을 막지 않는가
 *   막는 것: 이번 연결의 **입력 생성본**(과 그 임시 자리)을 출력으로 지정하는 것.
 *   막지 않는 것: 사용자가 **이전에 저장한 최종 음성**을 다시 고르는 것 —
 *   그것은 의도한 교체다. 이 파일은 입력 목록에 있는 것만 본다.
 *
 * 이 파일은 판단만 한다. 파일을 열지도, 지우지도 않는다(조회는 probe 가 한다).
 */

/** 파일을 식별하는 두 가지 수단. 본체는 node:fs 로, 검사는 가짜로 넣는다. */
export interface PathProbe {
  /**
   * 별칭을 푼 실제 경로. 풀 수 없으면(아직 없는 파일 등) 받은 값을 그대로 돌려준다.
   * 절대 경로로 만드는 일까지 포함한다.
   */
  real(p: string): string
  /**
   * 파일 고유 번호(장치+색인)를 한 문자열로. 파일이 없거나 얻을 수 없으면 null.
   * null 은 '다른 파일' 이라는 뜻이 아니라 '이 수단으로는 모른다' 는 뜻이다.
   */
  fileId(p: string): string | null
}

/** 이름만 남겨 비교할 꼴로. 구분자·대소문자·끝 구분자·중복 구분자를 없앤다. */
export function normalizePathForCompare(p: string): string {
  const s = String(p || '').replace(/\\/g, '/').trim()
  if (!s) return ''
  const collapsed = s.replace(/\/{2,}/g, '/')
  const cut = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
  return cut.toLowerCase()
}

/**
 * 두 경로가 **같은 파일**을 가리키는가.
 * 고유 번호가 양쪽에 다 있으면 그것이 결론이다(이름이 달라도 같은 파일일 수 있다).
 * 하나라도 없으면 이름 비교로 내려온다 — 없는 파일을 만들려는 경우가 여기다.
 */
export function sameFileTarget(a: string, b: string, probe: PathProbe): boolean {
  if (!a || !b) return false
  const ida = probe.fileId(a)
  const idb = probe.fileId(b)
  if (ida && idb) return ida === idb
  const ra = normalizePathForCompare(probe.real(a))
  const rb = normalizePathForCompare(probe.real(b))
  return !!ra && ra === rb
}

export interface JoinInputRef {
  /** 화면에 보일 이름(카드 이름). 없으면 파일 이름을 쓴다. */
  label?: string
  path: string
}

/** 연결 처리가 쓰는 임시 자리. 이것도 입력을 덮으면 안 된다. */
export const JOIN_TEMP_SUFFIX = '.part'

/**
 * 이 출력 자리가 쓰면 안 되는 자리인가. 쓸 수 있으면 빈 문자열.
 *
 * ★오류나 취소로 끝나더라도 입력 바이트는 그대로여야 한다.
 *   그래서 이 검사는 **소리를 읽기 전에** 한다 — 쓰다 만 상태를 만들지 않는다.
 */
export function joinOutputFault(output: string, inputs: JoinInputRef[], probe: PathProbe): string {
  const out = String(output || '').trim()
  if (!out) return '저장할 자리를 알 수 없습니다'
  const temp = out + JOIN_TEMP_SUFFIX
  for (const input of inputs || []) {
    const p = String(input?.path || '').trim()
    if (!p) continue
    if (sameFileTarget(out, p, probe)) {
      const who = input.label ? `'${input.label}'` : '입력'
      return `${who} 카드의 생성본 파일 위에 저장할 수 없습니다. 다른 이름을 고르세요.`
    }
    if (sameFileTarget(temp, p, probe)) {
      const who = input.label ? `'${input.label}'` : '입력'
      return `${who} 카드의 생성본이 작업 중 임시 파일과 같은 자리입니다. 다른 이름을 고르세요.`
    }
  }
  return ''
}
