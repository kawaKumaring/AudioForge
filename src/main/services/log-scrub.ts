/**
 * 로그로 나가는 **남의 문구**에서 폴더를 지운다 — 파일 이름은 남긴다.
 *
 * ★왜 생겼나(2026-09-24 2차 감사)
 *   `app-log.ts` 는 "절대 경로는 적지 않는다, 그 책임은 호출부에 있다" 고 적어 두었다.
 *   그런데 그 계약이 **닿지 않는 통로 둘**이 같은 파일에 연결돼 있었다 —
 *     · `mirrorConsole` : 아무나 부른 `console.error` 를 그대로 받아 적는다.
 *       Electron 자신도 IPC 핸들러가 거부하면 스스로 `console.error` 를 부른다.
 *     · `watchUncaught` : 예외 **스택 전문**을 그대로 받아 적는다.
 *   이 둘이 실어 나르는 것은 우리가 쓴 문장이 아니라 Node 의 fs 오류와 실행 명령줄이다.
 *   그래서 `Command failed: ... E:\작업\더빙\2026\면담_원본.wav` 같은 줄이 로그에 남고,
 *   그 로그가 **진단 묶음에 통째로 실려 밖으로 나갔다.**
 *
 * ★왜 파일 이름은 남기나
 *   전부 지우면 `Command failed: <ffprobe 경로>` 에서 **무엇이 실패했는지**까지 사라진다.
 *   이 저장소가 로그에 허용한 수준이 이미 '이름만'(`fileLabel`)이므로 그것에 맞춘다.
 *   ★남는 한계: 파일 **이름**에 인물 이름을 쓰는 방식이면 이것으로 막지 못한다.
 *     더 막으려면 로그도 지문(`spk_…`)으로 가야 하고, 그것은 별도 결정이다.
 *
 * `python-runner.ts` 의 `stripPaths` 와 **합치지 않는다.** 그쪽은 '파이썬 오류에서 보여 줄
 * 한 줄 고르기' 이고 이쪽은 '밖으로 나갈 파일에서 폴더 지우기' 다. 실패했을 때 잃는 것이
 * 달라서 규칙도 달라야 한다(이쪽은 과하게 지우는 편이 안전하다).
 *
 * ★정규식을 글자로 조립하는 이유: 역슬래시가 소스를 오갈 때 한 겹씩 먹히는 사고를
 *   여러 번 겪었다. 개수를 눈으로 세지 않아도 되게 한 글자씩 이름을 붙여 쓴다.
 */

const BS = String.fromCharCode(92)          // 역슬래시 한 글자
const RE_BS = BS + BS                       // 정규식 안에서 '역슬래시 한 글자' 를 뜻하는 표기
/** 경로 구분자 — `\` 또는 `/`. */
const SEP = '[' + RE_BS + '/]'
/**
 * 경로 한 조각. **공백은 허용한다** — `내 작업` 같은 폴더를 놓치면 안 된다.
 * 대신 `:` 을 금지한다 — 윈도 경로 조각에는 콜론이 올 수 없고, 이것이 없으면
 * `ffprobe.exe -of json E:` 까지 한 조각으로 삼켜 **명령 이름이 사라진다**(실측).
 */
const SEG = '[^' + RE_BS + '/:' + BS + 'r' + BS + 'n' + BS + 't' + "'" + '"<>|*?]+'

/**
 * 폴더를 지우고 마지막 조각만 남기는 규칙들.
 * 순서가 중요하다 — 더 특수한 것(file:// · UNC)을 먼저 본다.
 */
const RULES: Array<[RegExp, string]> = [
  // file:///E:/작업/a.wav · file://서버/공유/a.wav
  // ★드라이브 뒤에는 **구분자가 먼저** 온다(`E:` + `/` + `x`). 그 자리를 비워 두면
  //   `file:///E:/…` 를 통째로 놓치고 `file:///` 껍데기만 남는다(실측).
  [new RegExp('file:' + BS + '/' + BS + '/' + BS + '/?(?:[A-Za-z]:)?' + SEP + '?(?:' + SEG + SEP + ')+(' + SEG + ')', 'gi'), '$1'],
  // UNC — \\서버\공유\폴더\a.wav  (드라이브 문자로 시작하지 않아 예전 규칙이 아예 못 봤다)
  [new RegExp(RE_BS + RE_BS + '(?:' + SEG + SEP + ')+(' + SEG + ')', 'g'), '$1'],
  // 드라이브 — 드라이브 문자 + 폴더 여러 단계 + 파일 이름. 역슬래시·슬래시 양쪽.
  [new RegExp('[A-Za-z]:' + SEP + '(?:' + SEG + SEP + ')*(' + SEG + ')', 'g'), '$1'],
  // 드라이브 뒤에 아무것도 없는 경우 — `E:\` 자체
  [new RegExp('[A-Za-z]:' + SEP + '(?!' + BS + 'S)', 'g'), ''],
  // POSIX 절대 경로 — /home/xxx/a.wav (최소 두 단계여야 경로로 본다)
  [new RegExp('/(?:' + SEG + '/)+(' + SEG + ')', 'g'), '$1'],
]

/** 한 번 훑는다. 아래 `scrubPathsForLog` 가 더 지울 것이 없을 때까지 되돌린다. */
function onePass(text: string): string {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

/** 한 줄에 경로가 여럿일 때 되돌리는 횟수 상한 — 끝나지 않는 일이 없게. */
const MAX_PASSES = 5

/**
 * 한 줄(또는 여러 줄) 문구에서 절대 경로의 **폴더 부분만** 지운다.
 *
 * 공백이 든 폴더 이름도 잡는다 — 예전 규칙은 공백에서 끊겨
 * `E:\내 작업\OOO.wav` 를 `작업\OOO.wav` 로만 줄였다(폴더·인물 이름이 그대로 남았다).
 *
 * ★한 번으로 끝나지 않는다: `… E:\소리\a.wav -of json C:\x\b.wav` 처럼 한 줄에 경로가
 *   둘이면 앞 경로를 지우는 과정에서 뒤 경로의 드라이브 글자가 함께 먹힌다.
 *   **더 지울 것이 없을 때까지** 되돌려야 뒤 경로가 남지 않는다.
 */
export function scrubPathsForLog(text: string): string {
  if (!text) return text
  let out = String(text)
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = onePass(out)
    if (next === out) break
    out = next
  }
  return out
}

/** 경로가 남아 있는지 — 검사와 진단 묶음 세척이 **같은 눈**으로 본다. */
export function hasAbsolutePath(text: string): boolean {
  if (!text) return false
  const drive = new RegExp('[A-Za-z]:' + SEP)
  const unc = new RegExp(RE_BS + RE_BS + '[^' + RE_BS + '/' + BS + 's]')
  const url = new RegExp('file:' + BS + '/' + BS + '/', 'i')
  const posix = new RegExp('(^|' + BS + 's)/(?:[^' + BS + 's/]+/){2,}')
  return drive.test(text) || unc.test(text) || url.test(text) || posix.test(text)
}
