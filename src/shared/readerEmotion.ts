/**
 * 낭독 — **대사에 감정을 싣는다** (2026-10-01 지시: "낭독에도 감정 표현을 적용하라").
 *
 * 책에는 감정 표시가 없다. 소설에서 감정이 가장 또렷이 적힌 곳은 **대사와 그 앞뒤의 서술**이다 —
 * `"…!" 그가 소리쳤다` · `그녀가 울먹이며 말했다. "…"`. 그래서
 *   · 대사(따옴표가 든 문장)에만 감정을 싣고, 서술은 낭독자 목소리 그대로 둔다(오디오북이 인물만 연기하듯)
 *   · 감정은 그 대사 안, 바로 뒤 서술, 바로 앞 서술의 **단서 낱말**로 정한다(그 순서로 먼저 찾은 것)
 *   · 단서가 없으면 감정 없이(보통으로)
 * ★규칙이라 틀릴 수 있다 — 반어·비꼼은 못 알아본다. 로컬 언어 모델로 판정하는 길은 GPU 를 낭독과 다투고 느려서 쓰지 않았다.
 * ★실측(4-9): 지시로 뚜렷이 달라지는 것은 기쁨·화남이고 슬픔·속삭임은 재는 값으로는 약했다 — 그래도 같은 규칙으로 싣는다(들어 보고 판단).
 * 감정 id 는 파이썬 `qwen_emotions.QWEN_EMOTION_INSTRUCTS` 의 열쇠와 같다.
 */
import type { ReadingPart } from './readerText.ts'

/** 단서 — 먼저 적힌 감정이 이긴다(화남 > 공포 > 슬픔 > 놀람 > 속삭임 > 기쁨 > 흥분). */
const CUES: ReadonlyArray<[string, RegExp]> = [
  ['angry', /화(가|를)\s?(나|내|냈|났)|화난|분노|노발대발|버럭|고함|소리를\s?질렀|호통|짜증|성(을|이)\s?(내|냈|났)|노려보|이를\s?갈|씩씩/],
  ['scared', /무서|두려|겁(에|을|이)\s?(질|먹|났)|공포|벌벌|덜덜|떨리는\s?목소리|사색이/],
  ['sad', /슬프|슬퍼|슬픔|눈물|울먹|흐느|울며|울었|훌쩍|서글|비통/],
  ['surprise', /놀라|놀란|깜짝|화들짝|경악/],
  ['whisper', /속삭|귓속말|나지막|작은\s?목소리|목소리를\s?낮추/],
  ['happy', /웃으며|웃었|웃음|미소|기뻐|기쁜|기쁨|신이\s?나|신나|환하게|행복|싱글벙글|깔깔/],
  ['excited', /소리쳤|외쳤|외치|환호/],
]
const QUOTES = /["“”「」『』]/

/** 이 글에서 먼저 걸리는 단서의 감정 — 없으면 ''. */
export function cueEmotion(text: string): string {
  for (const [id, re] of CUES) if (re.test(text)) return id
  return ''
}

/** 단서를 찾을 앞뒤 서술의 길이 상한 — 긴 서술은 그 대사의 말투를 적은 것이 아닐 때가 많다. */
export const NEARBY_MAX = 50

const SENT_END = /[.!?…]+["”’'」』)）]*/
/** 글의 첫 문장(덩이 뒤의 앞뒤 맥락용). */
export function firstSentence(s: string): string {
  const t = s.replace(/^\s+/, '')
  const m = SENT_END.exec(t)
  return (m ? t.slice(0, m.index + m[0].length) : t.split('\n')[0]).trim()
}
/** 글의 마지막 문장. */
export function lastSentence(s: string): string {
  const t = s.trim()
  const pieces = t.split(/(?<=[.!?…]["”’'」』)）]*)\s+|\n+/).map((x) => x.trim()).filter(Boolean)
  return pieces[pieces.length - 1] || ''
}

/**
 * 구절마다 감정 id(없으면 '') — 문장(문장 끝까지의 구절들) 단위로 정하고 그 구절들에 같이 붙인다.
 * @param text 덩이 글(구절 자리의 기준)
 * @param ctx 앞 덩이의 끝·뒤 덩이의 처음 — ★덩이 경계에서 대사와 그 서술이 갈려도 단서를 잃지 않게(2026-10-01 실측:
 *   `"이게 무슨 짓이야!"` 가 덩이 끝, `그가 버럭 소리를 질렀다.` 가 다음 덩이 처음이라 화남을 놓쳤다).
 */
export function partEmotions(text: string, parts: readonly ReadingPart[], ctx: { before?: string; after?: string } = {}): string[] {
  // 문장으로 묶는다 — 문장 끝(strong) 구절에서 끊는다.
  const sentences: Array<{ first: number; last: number; text: string }> = []
  let first = 0
  parts.forEach((p, k) => {
    if (p.strong || k === parts.length - 1) {
      sentences.push({ first, last: k, text: text.slice(parts[first].from, p.to) })
      first = k + 1
    }
  })
  const isDialogue = (t: string) => QUOTES.test(t)
  // 앞뒤 맥락 문장을 가짜 문장으로 붙인다(-1 · n).
  const prevCtx = ctx.before ? lastSentence(ctx.before) : ''
  const nextCtx = ctx.after ? firstSentence(ctx.after) : ''
  const textAt = (i: number): string => i === -1 ? prevCtx : i === sentences.length ? nextCtx : (sentences[i]?.text ?? '')
  const narrationCue = (i: number) => {
    const t = textAt(i)
    return t && !isDialogue(t) && t.length <= NEARBY_MAX ? cueEmotion(t) : ''
  }
  const out: string[] = parts.map(() => '')
  sentences.forEach((s, i) => {
    if (!isDialogue(s.text)) return
    // 뒤 서술 → 앞 서술. ★앞 서술은 **그보다 앞이 대사가 아닐 때만** — 앞 대사의 서술(`"…" 그가 웃으며 말했다.`)을 빌려 오지 않는다
    //   (실측: `"쉿, 누가 들어."` 가 앞 대사의 '웃으며' 를 빌려 기쁨이 됐다).
    const before = isDialogue(textAt(i - 2)) ? '' : narrationCue(i - 1)
    const emo = cueEmotion(s.text) || narrationCue(i + 1) || before
    for (let k = s.first; k <= s.last; k++) out[k] = emo
  })
  return out
}

/**
 * 덩어리의 소리로 보낼 글 — 구절들의 읽을 글을 잇는다(줄이 바뀐 자리는 줄바꿈 수 그대로 — readingPlan 과 같은 규칙).
 */
export function runSay(text: string, parts: readonly ReadingPart[], run: EmotionRun): string {
  let s = ''
  let prevTo = -1
  for (let k = run.from; k <= run.to; k++) {
    const p = parts[k]
    if (!p.spoken) continue
    if (s) {
      const breaks = text.slice(prevTo, p.from).split('\n').length - 1
      s += breaks ? '\n'.repeat(breaks) : ' '
    }
    s += p.spoken
    prevTo = p.to
  }
  return s
}

/** 감정이 같은 이웃 구절들을 한 덩어리로 — 합성은 덩어리마다 한 번(같은 지시). */
export interface EmotionRun { from: number; to: number; emotion: string }
export function emotionRuns(parts: readonly ReadingPart[], emotions: readonly string[]): EmotionRun[] {
  const runs: EmotionRun[] = []
  parts.forEach((p, k) => {
    if (!p.weight) return                                  // 소리 없는 구절(기호뿐)은 앞 덩어리에 붙지 않고 건너뛴다
    const last = runs[runs.length - 1]
    if (last && last.emotion === emotions[k]) last.to = k
    else runs.push({ from: k, to: k, emotion: emotions[k] || '' })
  })
  return runs
}
