/**
 * 외부 전송 금지 — **장치로** 지킨다.
 *
 * ★사용자 원칙(최우선): "무조건 외부로 보내지 않는다. 이런저런 자료를 가져와도 외부로 보내야 한다면
 *   명확하게 지적한 뒤 막아야 한다."
 * ★2026-09-30 재조사에서 찾은 바깥 통로: 구글 번역(받아 적은 문장이 구글로), 노래 변환기가 실행마다
 *   허깅페이스에 확인 요청, 크롬 맞춤법 검사기가 구글에서 사전을 내려받음(앱 데이터에 ko-3-0.bdic).
 *   그때까지 금지는 **관례로만** 지켜지고 있었다 — 막는 장치가 없었다.
 *
 * 세 겹
 *   1) 파이썬 — 본체 환경에 오프라인 설정을 한 번 켜 모든 자식이 물려받는다(`applyOfflineEnv`).
 *   2) 화면·본체의 웹 요청 — 로컬이 아닌 주소는 막고 기록한다(`isLocalUrl`).
 *   3) 화면 — 보안 정책(CSP)이 바깥 주소로의 연결·불러오기를 막는다(index.html).
 */

/** 모든 파이썬 자식이 물려받을 오프라인 설정. 받아 둔 모델만 쓰고, 확인 요청·원격 통계를 보내지 않는다. */
export const OFFLINE_ENV: Readonly<Record<string, string>> = {
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HF_DATASETS_OFFLINE: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
  HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
  DO_NOT_TRACK: '1',
}

/** 환경에 오프라인 설정을 **덮어쓴다**(바깥에서 0 으로 켜 두었어도 되돌린다). 바꾼 열쇠를 돌려준다. */
export function applyOfflineEnv(env: Record<string, string | undefined>): string[] {
  const changed: string[] = []
  for (const [k, v] of Object.entries(OFFLINE_ENV)) {
    if (env[k] !== v) changed.push(k)
    env[k] = v
  }
  return changed
}

/** 바깥으로 나가는 번역 — 받지 않는다. 옛 저장값·다른 화면이 보내도 로컬로 돌린다. */
export const BLOCKED_TRANSLATE_MODELS: readonly string[] = ['google']

export function localTranslateModel(v: unknown): string {
  const s = typeof v === 'string' && v ? v : '600m'
  return BLOCKED_TRANSLATE_MODELS.includes(s.toLowerCase()) ? '600m' : s
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * 이 요청이 **이 컴퓨터 안**에서 끝나는가. 웹 주소(http·https·ws·wss)만 따진다 —
 * 파일·앱 전용 주소(file·local-file·devtools·data·blob)는 원래 바깥으로 나가지 않는다.
 * 판단할 수 없는 주소는 바깥으로 본다(막는 쪽으로 틀린다).
 */
export function isLocalUrl(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase()
  if (!['http', 'https', 'ws', 'wss'].includes(scheme)) return true
  return LOCAL_HOSTS.has(u.hostname.toLowerCase())
}
