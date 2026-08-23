// ⚠️ PROTOTYPE / TEST-ONLY — 프로덕션 코드 아님. src/·python/ 어디서도 import 하지 않는다.
// 목적: Phase 1(설계) 산출물. 다중 감정 문법(줄 안에 여러 [태그])을 파싱하는 PURE 함수의
//       레퍼런스 구현. 통합 담당이 계약 확정 후 이 로직을 emotions.ts로 이식할 때의 기준.
//
// 순수성 계약:
//   - 부작용 없음. DOM/store/네트워크/파일 접근 없음. (text) → 구조체.
//   - LABEL_TO_ID는 여기서 최소 미러(테스트에 쓰는 라벨만)로 들고 있다. 프로덕션 이식 시엔
//     emotions.ts의 ALL_EMOTIONS에서 파생된 LABEL_TO_ID를 주입받아야 한다(단일 소스 유지).
//   - 문법이 바뀌면 python/tts_worker.py의 _parse_line 도 반드시 동형으로 갱신(현재는 줄당 1태그).
//
// ── 문법(BNF-ish, v2 다중 감정) ─────────────────────────────────────────────
//   document := line ( '\n' line )*
//   line     := segment*                         ; 감정 스코프는 줄 안에서만(line-local)
//   segment  := ( emotionTag | pauseTag )? text
//   emotionTag := '[' tagname ']'                ; tagname = 알려진 감정 라벨/영문 id → 그 id로 전환
//                                                ;          알 수 없으면 'default'로 귀결(현행 동형)
//   pauseTag := '[' pauseWord (sep number)? ']'  ; pauseWord ∈ {쉼, pause}; sep ∈ {공백, '='}
//   text     := 다음 태그 전까지 / 줄 끝까지의 문자열
// 태그 정규식: /\[\s*([^\[\]]+?)\s*\]/g  (닫히지 않은 '['·중첩은 매칭 실패 → 리터럴 텍스트)

// 프로토타입용 최소 라벨 맵(테스트에서 쓰는 것만). 프로덕션은 emotions.ts에서 파생.
const PROTO_LABEL_TO_ID = {
  '기본': 'default', default: 'default',
  '기쁨': 'happy', happy: 'happy',
  '명랑': 'cheerful', cheerful: 'cheerful',
  '슬픔': 'sad', sad: 'sad',
  '놀람': 'surprise', surprise: 'surprise',
  '속삭임': 'whisper', whisper: 'whisper',
}

const PAUSE_WORDS = new Set(['쉼', 'pause'])
const DEFAULT_PAUSE_SEC = 0.5

const TAG_RE = /\[\s*([^\[\]]+?)\s*\]/g

// 태그 inner를 감정/쉼으로 분류. labelToId 주입 가능(기본은 프로토타입 미러).
function classifyTag(inner, labelToId) {
  const trimmed = inner.trim()
  // pause: 첫 토큰이 쉼/pause 이면 pause. 뒤에 '=0.5' 또는 ' 0.5' 형태의 초 지정 허용.
  const pm = /^(\S+?)(?:\s*=\s*|\s+)?([0-9]*\.?[0-9]+)?$/.exec(trimmed)
  const head = (pm ? pm[1] : trimmed).toLowerCase()
  if (PAUSE_WORDS.has(head)) {
    const sec = pm && pm[2] != null ? parseFloat(pm[2]) : DEFAULT_PAUSE_SEC
    return { kind: 'pause', durationSec: Number.isFinite(sec) && sec >= 0 ? sec : DEFAULT_PAUSE_SEC }
  }
  const id = labelToId[trimmed] || 'default'
  return { kind: 'emotion', emotionId: id, tagKnown: Object.prototype.hasOwnProperty.call(labelToId, trimmed) }
}

/**
 * 다중 감정 파서(PURE). 원본 텍스트를 세그먼트 배열로 분해한다.
 * 각 세그먼트는 색상 오버레이(§7)에 쓸 원본 오프셋(textStart/textEnd)을 갖는다.
 *
 * @param {string} text
 * @param {Record<string,string>} [labelToId]  라벨/영문id → emotionId (기본: 프로토타입 미러)
 * @returns {Array<
 *   | { kind:'emotion', emotionId:string, tagKnown:boolean, text:string, textStart:number, textEnd:number, line:number }
 *   | { kind:'pause', durationSec:number, at:number, line:number }
 * >}
 */
export function parseEmotionSegments(text, labelToId = PROTO_LABEL_TO_ID) {
  const out = []
  const src = text || ''
  let lineStart = 0
  let lineNo = 0
  // 줄 단위(line-local): '\n' 기준으로 나누되 원본 오프셋을 유지한다.
  const lines = src.split('\n')
  for (const line of lines) {
    parseLine(line, lineStart, lineNo, labelToId, out)
    lineStart += line.length + 1 // +1 = '\n'
    lineNo += 1
  }
  return out
}

function parseLine(line, base, lineNo, labelToId, out) {
  TAG_RE.lastIndex = 0
  let cursor = 0
  let active = 'default'
  let activeKnown = true
  let m
  const pushText = (from, to, emotionId, tagKnown) => {
    if (to <= from) return // 빈 텍스트 세그먼트는 만들지 않는다(태그만 있는 줄 → 무텍스트)
    out.push({
      kind: 'emotion', emotionId, tagKnown,
      text: line.slice(from, to),
      textStart: base + from, textEnd: base + to, line: lineNo,
    })
  }
  while ((m = TAG_RE.exec(line)) !== null) {
    // 태그 앞의 텍스트를 현재 active 감정으로 닫는다.
    pushText(cursor, m.index, active, activeKnown)
    const cls = classifyTag(m[1], labelToId)
    if (cls.kind === 'pause') {
      out.push({ kind: 'pause', durationSec: cls.durationSec, at: base + m.index, line: lineNo })
      // pause는 감정을 바꾸지 않는다(뒤 텍스트는 이전 감정 유지).
    } else {
      active = cls.emotionId
      activeKnown = cls.tagKnown
    }
    cursor = m.index + m[0].length
  }
  // 마지막 태그 뒤 ~ 줄 끝
  pushText(cursor, line.length, active, activeKnown)
}

/**
 * 기존 parseUsedEmotionIds 계약을 다중 감정 파서 위에서 재현(PURE).
 * - 본문(trim) 비어있지 않은 emotion 세그먼트만 '사용'으로 센다(태그만 있는 줄 제외 — 현행 동형).
 * - 'default' 및 알 수 없는 태그(→default)는 결과에서 제외.
 * @returns {Set<string>}
 */
export function parseUsedEmotionIdsV2(text, labelToId = PROTO_LABEL_TO_ID) {
  const used = new Set()
  for (const seg of parseEmotionSegments(text, labelToId)) {
    if (seg.kind !== 'emotion') continue
    if (seg.emotionId === 'default') continue
    if (!seg.text.trim()) continue
    used.add(seg.emotionId)
  }
  return used
}
