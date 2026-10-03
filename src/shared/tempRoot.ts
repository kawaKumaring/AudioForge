/**
 * 임시 자리 — **앱이 도는 자리 안에 둔다.**
 *
 * ★왜 생겼나 (2026-09-28 지시)
 * > "가장 중요한건 6번이다. C 드라이브로 가지 않아야한다."
 *
 *   앱 데이터는 앱 폴더로 옮겼지만(`AudioForge_data`), **임시 파일은 그대로**
 *   시스템 임시 폴더에 쌓이고 있었다. 실측으로 세 갈래였다:
 *     · 본체가 만드는 설정 JSON·중간 폴더 — 15자리
 *     · 파이썬 자식이 `tempfile` 로 만드는 것 — 음원 분리 중간물은 **기가 단위**
 *     · 검사가 만드는 격리 폴더 — 60개 넘는 파일에서
 *   전부 사용자가 고른 적 없는 시스템 드라이브였다.
 *
 * ★한 점으로 막는 이유 (실측 2026-09-28)
 *   Node 의 `os.tmpdir()` 은 **부를 때마다 `TEMP`/`TMP` 를 다시 읽는다.**
 *   그리고 파이썬 자식은 `...process.env` 를 그대로 물려받는다.
 *   그래서 **환경 변수 한 번**이 세 갈래를 모두 돌린다 — 75자리를 각각 고치면
 *   반드시 하나를 빠뜨리고, 새로 쓰는 코드가 다시 옛 자리로 간다.
 *
 * 이 파일은 **규칙만** 갖는다. 실제로 폴더를 만들고 돌리는 것은 본체다.
 */

/** `<userData>/temp` — 앱이 관리하는 것이므로 데이터 자리 안에 둔다. */
export const TEMP_DIR_NAME = 'temp'

/**
 * 임시 자리를 정하는 환경 변수. **셋 다** 써야 한다.
 * `TEMP`/`TMP` 는 윈도우와 Node 가 보고, `TMPDIR` 은 파이썬과 POSIX 도구가 먼저 본다.
 * 하나라도 빠지면 그것을 읽는 쪽만 조용히 옛 자리로 간다.
 */
export const TEMP_ENV_KEYS = ['TEMP', 'TMP', 'TMPDIR'] as const

/** 옛 임시 자리를 적어 두는 우리 변수. 남은 잔해를 치울 때만 쓴다. */
export const LEGACY_TEMP_ENV_KEY = 'AF_LEGACY_TEMP'

/** 임시 자리는 데이터 자리 아래다. 데이터 자리가 옮겨가면 임시도 함께 따라간다. */
export function planTempRoot(userDataDir: string): string {
  const base = (userDataDir ?? '').trim()
  if (!base) return ''
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + TEMP_DIR_NAME
}

/**
 * 임시 자리를 `target` 으로 돌린다. **바꾼 자리를 돌려준다.**
 *
 * 빈 값이면 아무것도 바꾸지 않고 `''` 을 돌려준다 — 자리를 모르면서 옛 자리를
 * 지워 버리면, 임시 파일이 현재 폴더에 쏟아진다.
 */
export function redirectTemp(
  target: string,
  env: Record<string, string | undefined>,
): string {
  const next = (target ?? '').trim()
  if (!next) return ''
  for (const key of TEMP_ENV_KEYS) env[key] = next
  return next
}

/**
 * 우리가 만드는 임시 이름의 **접두 전부.**
 *
 * ★짧은 접두는 쓰지 않는다. `af-` 로 싸잡으면 `affinity-…` 같은 남의 폴더를 지운다.
 *   그래서 2026-09-28 에 흩어져 있던 짧은 이름(`af_ens_`·`af_mp_`·`af_words_`·
 *   `af-dubspeak-`·`af-pitch-`·`diarize_`)을 전부 `audioforge_` 아래로 옮겼다.
 *   **이름을 바꾼 것이지 검사를 낮춘 것이 아니다** — 이제 두 접두로 우리 것이 다 덮인다.
 *
 * ★새 임시 이름을 만들 때는 반드시 `audioforge_` 로 시작한다.
 *   그러지 않으면 비우기가 그것을 못 찾고, 옛 자리에 영원히 남는다.
 */
export const OUR_TEMP_PREFIXES = [
  'audioforge_',            // 본체 설정 JSON · 분리 중간 폴더 · 파이썬 전부 · 검사 입력물
  'audioforge-',            // 검사 격리 userData(audioforge-e2e-userdata-…)
] as const

/** 옛 자리의 목록에서 **우리 것만** 고른다. 나머지는 이름조차 돌려주지 않는다. */
export function ourTempNames(names: readonly string[]): string[] {
  return names.filter((n) => OUR_TEMP_PREFIXES.some((p) => n.startsWith(p)))
}
