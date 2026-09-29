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
  /**
   * 본문 글자 크기(px). ★지시 (2026-09-30): "텍스트를 불러오면 처음 셋팅되어 있는 텍스트 크기가 크다.
   *   크기를 줄이고 해당 크기를 옵션에서 조절할 수 있게." 예전 기본은 19 였다.
   */
  fontSize: number
}

export const READER_FONT_MIN = 13
export const READER_FONT_MAX = 24

export const DEFAULT_READER_PREFS: ReaderPrefs = { follow: true, skipHanjaInParens: false, fontSize: 16 }

/** 저장본을 믿지 않는다 — 모르는 값은 기본으로 돌린다. */
export function parseReaderPrefs(raw: unknown): ReaderPrefs {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    follow: typeof o.follow === 'boolean' ? o.follow : DEFAULT_READER_PREFS.follow,
    skipHanjaInParens: typeof o.skipHanjaInParens === 'boolean'
      ? o.skipHanjaInParens : DEFAULT_READER_PREFS.skipHanjaInParens,
    fontSize: typeof o.fontSize === 'number' && Number.isFinite(o.fontSize)
      ? Math.round(Math.min(READER_FONT_MAX, Math.max(READER_FONT_MIN, o.fontSize)))
      : DEFAULT_READER_PREFS.fontSize,
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
 * **소리로 내지 않는 기호** — 따옴표·별표·괄호류·꾸밈 기호 (2026-09-30 사용자 신고:
 * "' \" * 같은 특수기호를 소리 내려고 '에 에 에' 하는 소리를 낸다").
 * ★문장 부호(. , ! ? … ; :)는 남긴다 — 쉼과 억양을 만든다. 괄호 ( ) 와 하이픈 - 도 남긴다(읽는 내용·낱말의 일부).
 * ★기호만 빼고 **안의 글은 그대로** 읽는다 — `"누구세요?"` → `누구세요?`, `[퀘스트 완료]` → `퀘스트 완료`.
 * ★영어 낱말 안의 작은따옴표(don't)는 남긴다.
 */
const SILENT_SYMBOLS = /["“”„‟«»‹›「」『』〈〉《》【】〔〕\[\]{}<>*＊_＿`´^|\\/＼#＃@=＝+＋♡♥☆★◆◇■□●○◎▲△▼▽※→←↑↓↔♪♬♩♫]/g
/** 글자로 둘러싸이지 않은 작은따옴표 — 여는/닫는 따옴표로 쓰인 것. */
const LONE_QUOTE = /(?<![A-Za-z])['‘’‚‛]|['‘’‚‛](?![A-Za-z])/g
/** 숫자 사이의 물결표는 범위다 — `10~20명` 은 '10에서 20명' 으로 읽는다. 나머지 물결표(아~)는 뺀다. */
const RANGE_TILDE = /(\d)\s*[~～〜]\s*(\d)/g
const OTHER_TILDE = /[~～〜]/g

/** 기호를 뺀 뒤 띄어쓰기를 다시 고른다 — 부호 앞의 빈칸, 겹친 빈칸. */
function tidy(s: string): string {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,!?…;:)])/g, '$1').replace(/([(])[ \t]+/g, '$1')
    .split('\n').map((l) => l.trim()).join('\n').trim()
}

/**
 * 이 덩이를 **소리로 보낼 글.** 보이는 글은 그대로이고 소리로 보낼 때만 탄다.
 * - 늘: 소리 내지 않는 기호를 뺀다(위).
 * - 설정을 켜면: 괄호 속 한자를 뺀다.
 * 빼고 나서 **읽을 글자가 남지 않으면** 빈 글을 돌려준다 — 부르는 쪽이 소리 없이 건너뛴다(`* * *` 장면 구분 줄 등).
 */
export function speakableText(text: string, prefs: Pick<ReaderPrefs, 'skipHanjaInParens'>): string {
  let s = prefs.skipHanjaInParens ? text.replace(HANJA_IN_PARENS, '') : text
  s = s.replace(RANGE_TILDE, '$1에서 $2').replace(OTHER_TILDE, ' ')
    .replace(SILENT_SYMBOLS, ' ').replace(LONE_QUOTE, ' ')
  s = tidy(s)
  return /[\p{L}\p{N}]/u.test(s) ? s : ''
}
