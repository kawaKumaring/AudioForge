/**
 * 글 파일의 바이트를 글로 — **어떤 인코딩인지 알아내서** 읽는다.
 *
 * ★왜 (2026-09-30): 낭독은 UTF-8 만 받아 "UTF-8로 저장한 뒤 다시 불러오세요" 로 거절했다. 한국어 소설 텍스트는
 *   옛 메모장·뷰어에서 만든 **CP949(EUC-KR)** 가 흔하고, 윈도우 메모장의 "유니코드" 저장은 **UTF-16** 이다.
 *   사용자가 파일을 다시 저장해야 하는 일은 도구의 몫을 떠넘긴 것이다.
 *
 * 순서가 곧 규칙이다 —
 *   1) 머리표(BOM)가 있으면 그것을 믿는다(UTF-8 · UTF-16LE · UTF-16BE).
 *   2) 머리표 없는 UTF-16 — 영문·숫자·줄바꿈 자리마다 0 바이트가 한쪽(짝/홀)에만 몰린다.
 *   3) UTF-8 로 **엄격하게** 읽어 본다. 한 글자라도 틀리면 UTF-8 이 아니다.
 *   4) CP949 로 엄격하게 읽어 본다(브라우저·Node 의 'euc-kr' 은 CP949 확장까지 포함한다).
 *   5) 어느 것도 아니면 읽지 않는다 — **깨진 글을 소리로 읽어 주지 않는다.**
 *
 * ★순수 함수 — 화면·본체 어디서도 같은 답을 낸다. 검사는 `readerDecode.test.ts`.
 */
export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'cp949'

export interface DecodedText {
  text: string
  encoding: TextEncodingName
}

/** 엄격하게 읽는다 — 틀린 바이트가 하나라도 있거나, 읽은 글에 제어 문자가 섞이면 그 방식이 아니다. */
function strict(label: string, bytes: Uint8Array): string | null {
  let t: string
  try { t = new TextDecoder(label, { fatal: true }).decode(bytes) } catch { return null }
  return CONTROL.test(t) ? null : t
}

/** 글에 없어야 할 제어 문자(탭·줄바꿈·쪽 넘김 말고). 있으면 그 방식으로 읽은 것이 틀렸다. */
const CONTROL = /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/

/** 0 바이트와 짝을 이룬 쪽이 **글자로 쓰는 ASCII**(띄어쓰기·줄바꿈·숫자·영문·문장부호)인가. */
const plainAscii = (b: number) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)

/**
 * 머리표 없는 UTF-16 인가 — 앞 4KB 에서 **0 바이트 + ASCII** 짝이 한쪽 순서로만 나오는지 본다.
 * ★0 바이트만 세면 작은 깨진 파일도 UTF-16 으로 읽혔다(8바이트에 0 하나 — 실측). 진짜 UTF-16 글의 0 바이트는
 *   띄어쓰기·줄바꿈·숫자 자리에서 나온다 — 그 짝이 ASCII 여야 한다.
 */
function sniffUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length - (bytes.length % 2), 4096)
  if (n < 8) return null
  let le = 0, be = 0
  for (let i = 0; i < n; i += 2) {
    if (bytes[i + 1] === 0 && plainAscii(bytes[i])) le++
    if (bytes[i] === 0 && plainAscii(bytes[i + 1])) be++
  }
  const pairs = n / 2
  // UTF-8·CP949 글에는 0 바이트가 **아예 없다.** 한국어 글도 띄어쓰기·줄바꿈이 10% 는 넘는다.
  if (le > pairs * 0.1 && be < pairs * 0.01) return 'utf-16le'
  if (be > pairs * 0.1 && le < pairs * 0.01) return 'utf-16be'
  return null
}

export function decodeBookText(bytes: Uint8Array): DecodedText | null {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    const t = strict('utf-8', b.subarray(3))
    return t === null ? null : { text: t, encoding: 'utf-8' }
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    const t = strict('utf-16le', b.subarray(2))
    return t === null ? null : { text: t, encoding: 'utf-16le' }
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const t = strict('utf-16be', b.subarray(2))
    return t === null ? null : { text: t, encoding: 'utf-16be' }
  }
  const u16 = sniffUtf16(b)
  if (u16) {
    const t = strict(u16, b)
    if (t !== null) return { text: t, encoding: u16 }
  }
  const u8 = strict('utf-8', b)
  if (u8 !== null) return { text: u8, encoding: 'utf-8' }
  const cp = strict('euc-kr', b)
  if (cp !== null) return { text: cp, encoding: 'cp949' }
  return null
}

/** 화면·기록에 보일 이름. */
export function encodingLabel(e: TextEncodingName): string {
  return e === 'cp949' ? 'CP949(EUC-KR)' : e.toUpperCase()
}
