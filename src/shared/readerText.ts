/**
 * 낭독 — **보이는 글과 읽는 글을 나누는 규칙**, 그리고 낭독 설정.
 *
 * ★보이는 글은 건드리지 않는다. 덩이는 원문 글자 자리(start/end)를 들고 다니며
 *   본문 표시·건너뛰기를 잇는다 — 원문을 고치면 그 고리가 끊긴다.
 *   그래서 **소리로 보낼 때만** 이 규칙을 탄다.
 */

/** 설정 파일의 열쇠 — 낭독 설정 한 벌. */
export const READER_PREFS_STORAGE_KEY = 'readerPrefs'

export interface ReaderPrefs {
  /** 읽는 구절을 화면이 따라간다. */
  follow: boolean
  /**
   * 괄호 속 한자를 읽지 않는다 — `학교(學校)` 를 "학교" 로만 읽는다.
   * ★지시 (2026-09-29): "(한자) 가 있을 때 한자를 중국어로 읽는데, 옵션으로 () 안의 한문은
   *   읽지 않도록." 기본은 **끔** — 켜기 전에는 예전과 똑같이 읽는다.
   */
  skipHanjaInParens: boolean
}

export const DEFAULT_READER_PREFS: ReaderPrefs = { follow: true, skipHanjaInParens: false }

/** 저장본을 믿지 않는다 — 모르는 값은 기본으로 돌린다. */
export function parseReaderPrefs(raw: unknown): ReaderPrefs {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    follow: typeof o.follow === 'boolean' ? o.follow : DEFAULT_READER_PREFS.follow,
    skipHanjaInParens: typeof o.skipHanjaInParens === 'boolean'
      ? o.skipHanjaInParens : DEFAULT_READER_PREFS.skipHanjaInParens,
  }
}

// 한자(한중일 통합 한자 + 확장 A + 호환 한자)
const HAN = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF'
/**
 * 괄호 하나 — 안이 **한자뿐**일 때만(띄어쓰기·가운뎃점·쉼표는 한자 사이에 올 수 있다).
 * ★한글·영문·숫자가 섞이면 건드리지 않는다. `(학교)`·`(1920년)`·`(學校, school)` 은 읽는 내용이다.
 * 반각 `()` 과 전각 `（）` 을 모두 본다. 앞의 띄어쓰기도 함께 뺀다 — `대한민국 (大韓民國)` → `대한민국`.
 */
const HANJA_IN_PARENS = new RegExp(`[ \\t]*[(（][ \\t]*[${HAN}][${HAN} \\t·・,、]*[)）]`, 'g')

/**
 * 이 덩이를 **소리로 보낼 글.** 설정이 꺼져 있으면 원문 그대로다.
 * 빼고 나서 아무것도 남지 않으면 빈 글을 돌려준다 — 부르는 쪽이 건너뛴다.
 */
export function speakableText(text: string, prefs: Pick<ReaderPrefs, 'skipHanjaInParens'>): string {
  if (!prefs.skipHanjaInParens) return text
  return text.replace(HANJA_IN_PARENS, '').replace(/[ \t]{2,}/g, ' ')
}
