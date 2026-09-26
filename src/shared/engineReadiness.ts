/**
 * 엔진이 준비 안 됐을 때 **무엇이 잠기는가** — 한 곳에서 정한다.
 *
 * ★왜 생겼나(2026-09-25 실제 사고)
 *   선택 엔진(GPT-SoVITS) 하나의 설치 지문이 어긋났다고 **앱 전체가 뜨지 않았다.**
 *   그런데 그 엔진은 음성 합성 엔진 다섯 중 하나일 뿐이고, 앱의 다섯 모드 중
 *   넷(음악 분리·대화 분리·텍스트 추출·트랙 분할)은 그 엔진과 아무 상관이 없다.
 *   **음악에서 보컬만 빼려는 사람도 4GiB 설치를 강요받았다.**
 *
 *   더 이상한 것은 실패 문구가 스스로 "이미 정상인 다른 환경의 연결은 그대로입니다"
 *   라고 말한다는 점이다 — 멀쩡한 것을 알면서 앱을 안 띄웠다.
 *
 * ★그래서 바꾼 규칙
 *   앱은 **뜬다.** 대신 **무엇이 잠겼는지 화면이 분명히 말하고**, 설치할 수 있게 한다.
 *   "반쯤 준비된 채로 띄우면 나중에 막힌다" 는 반론은 옳다 — 그래서 막히는 자리를
 *   미리 이름으로 말해 준다. 모르고 쓰다 막히는 것과, 알고 쓰는 것은 다르다.
 *
 * 이 파일은 **판정만** 한다. 설치도, 화면 그리기도 하지 않는다.
 */

/** 설치 상태를 확인하는 부품. 지금은 하나지만 늘어날 수 있다. */
export type EngineKey = 'gptsovits'

export interface EngineStatus {
  key: EngineKey
  ok: boolean
  /** 미비 사유 코드(`FINGERPRINT_MISMATCH` 등). 정상이면 없다. */
  reason?: string
  /** 사람이 읽을 한 줄. 본체가 준다. */
  detail?: string
  /**
   * 다시 설치하지 않고 **기록 갱신만으로** 될 수 있는가.
   * ★이 값이 있어야 "4GiB 받으세요" 대신 "30초면 됩니다" 를 말할 수 있다.
   */
  repairableByRelink?: boolean
}

/** 엔진마다 사람이 아는 이름과, 그것이 없으면 못 하는 일. */
const ENGINE_INFO: Record<EngineKey, { label: string; locks: string[] }> = {
  gptsovits: {
    label: 'GPT-SoVITS 목소리 엔진',
    // ★"합성이 안 된다" 가 아니다 — **이 엔진으로 하는 합성**만 안 된다.
    //   다른 엔진(Qwen3·piper·kokoro·F5)과 나머지 네 모드는 그대로 된다.
    locks: ['GPT-SoVITS 엔진으로 하는 음성 합성'],
  },
}

export function engineLabel(key: EngineKey): string {
  return ENGINE_INFO[key]?.label ?? key
}

/** 이 엔진이 없으면 **못 하는 일**의 목록. 비어 있으면 잠기는 것이 없다. */
export function lockedBy(key: EngineKey): string[] {
  return ENGINE_INFO[key]?.locks ?? []
}

/**
 * 앱을 **띄우지 못하게** 해야 하는 상태인가.
 *
 * ★지금은 언제나 false 다. 선택 엔진이 없다고 앱을 막지 않는다.
 *   막아야 할 것이 생기면 여기에만 더한다 — 판단이 흩어지면 또 전체가 막힌다.
 */
export function blocksAppStart(_s: EngineStatus): boolean {
  return false
}

/** 화면에 띄울 것이 있는가 — 정상이면 아무 말도 하지 않는다. */
export function shouldNotify(s: EngineStatus | null | undefined): boolean {
  return !!s && !s.ok
}

export interface EngineNotice {
  title: string
  /** 무엇이 잠겼는지. **"앱이 고장났다" 로 읽히지 않게** 범위를 좁혀 말한다. */
  body: string
  /** 권하는 행동 — 싼 길이 있으면 그것을 먼저. */
  action: '기록 갱신' | '설치'
  actionHint: string
}

/**
 * 사용자에게 보일 알림.
 *
 * ★사라진 것이 없으면 **재설치가 아니라 기록 갱신**을 권한다.
 *   실제 사고에서 30초면 될 일에 4GiB 내려받기가 시작됐다.
 */
export function engineNotice(s: EngineStatus): EngineNotice {
  const label = engineLabel(s.key)
  const locks = lockedBy(s.key)
  const what = locks.length
    ? `지금 쓸 수 없는 것: ${locks.join(' · ')}.`
    : '지금 쓸 수 없는 기능이 있습니다.'
  const rest = '나머지 기능(음악 분리·대화 분리·텍스트 추출·트랙 분할, 다른 목소리 엔진)은 그대로 씁니다.'
  const why = s.detail ? `\n${s.detail}` : ''
  if (s.repairableByRelink) {
    return {
      title: `${label}가 준비되지 않았습니다`,
      body: `${what} ${rest}${why}`,
      action: '기록 갱신',
      actionHint: '사라진 것이 없어 다시 내려받지 않아도 됩니다 — 수십 초면 끝납니다.',
    }
  }
  return {
    title: `${label}가 준비되지 않았습니다`,
    body: `${what} ${rest}${why}`,
    action: '설치',
    actionHint: '내려받기가 수 GiB, 수십 분 걸릴 수 있습니다.',
  }
}
