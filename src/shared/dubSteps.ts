/**
 * 더빙 화면의 **순서**를 한 곳에서 정한다.
 *
 * ★왜 생겼나 (2026-09-26 신고)
 *   "구조적으로 이게 대체 뭘 하려는건지 근본없이 누더기처럼 붙여놨다."
 *   화면에 단추가 평평하게 깔려 있어 **무엇부터 해야 하는지 화면이 말하지 않았다.**
 *   그래서 사용자는 잠긴 단추를 고장으로 읽었다("영상 속 목소리 쓰기를 하지 못한다").
 *
 * ★순서는 줄 세우기가 아니라 **실제로 무엇이 무엇을 필요로 하는가**이다.
 *   목소리 고르기와 말 꺼내기는 서로를 기다리지 않는다 — 둘을 한 줄로 세우면
 *   할 수 있는 일을 못 하게 막는 거짓 순서가 된다.
 *   다만 '영상 속 목소리' 만은 말을 꺼낸 뒤라야 한다(꺼낸 소리에서 목소리를 가져온다).
 *   이것이 그 단추가 잠겨 있던 진짜 이유였고, 화면은 그 이유를 말한 적이 없다.
 *
 * 이 파일은 **말하기만** 한다. 잠그는 것은 화면이 이미 하고 있다.
 */

/** 지금까지 무엇이 되었는가. */
export interface DubProgress {
  /** 영상을 골랐다. */
  video: boolean
  /** 목소리가 준비되었다. */
  voice: boolean
  /** 말을 꺼내고 옮겼다(앞단). */
  front: boolean
  /** 소리를 만든 줄 수. */
  made: number
  /** 전체 줄 수. */
  lines: number
}

export interface DubStep {
  key: 'video' | 'front' | 'voice' | 'synth' | 'render'
  /** 화면에 보일 번호. */
  no: number
  title: string
  /** 끝났다. */
  done: boolean
  /** 지금 할 차례. **한 번에 하나만** 켜진다. */
  active: boolean
  /** 아직 못 한다 — 그 이유. 비면 할 수 있다. */
  blocked: string
}

/**
 * 다섯 단계의 지금 상태.
 *
 * '지금 할 차례' 는 **막히지 않았으면서 안 끝난 첫 단계**다.
 * 막힌 것을 차례라고 부르면 화면이 거짓말을 한다.
 */
export function dubSteps(p: DubProgress): DubStep[] {
  const madeAny = p.made > 0
  const allMade = p.lines > 0 && p.made >= p.lines
  const raw: Array<Omit<DubStep, 'no' | 'active'>> = [
    { key: 'video', title: '영상 고르기', done: p.video, blocked: '' },
    {
      key: 'front', title: '말 꺼내고 옮기기', done: p.front,
      blocked: p.video ? '' : '먼저 영상을 고르세요',
    },
    {
      key: 'voice', title: '목소리 정하기', done: p.voice,
      // ★파일에서 고르는 길은 언제든 열려 있다 — 여기를 막으면 거짓 순서가 된다.
      blocked: '',
    },
    {
      key: 'synth', title: '줄마다 소리 만들기', done: allMade,
      blocked: !p.front ? '먼저 말을 꺼내세요'
        : !p.voice ? '먼저 목소리를 정하세요' : '',
    },
    {
      key: 'render', title: '영상 만들기', done: false,
      blocked: madeAny ? '' : '소리를 만든 줄이 아직 없습니다',
    },
  ]
  const at = raw.findIndex((s) => !s.done && !s.blocked)
  return raw.map((s, i) => ({ ...s, no: i + 1, active: i === at }))
}

/**
 * '영상 속 목소리' 를 아직 못 쓰는 이유를 **사람 말로** 바꾼다.
 * 잠긴 단추 옆에 이 말이 없으면 사용자는 고장으로 읽는다.
 */
export const DUB_ORIGINAL_VOICE_WHY =
  '이 영상에서 꺼낸 소리로 목소리를 만듭니다 — 말을 꺼낸 뒤에 쓸 수 있습니다.'

/** '다른 목소리' 길의 한 줄 설명. 두 길이 무엇이 다른지 화면이 말해야 한다. */
export const DUB_PICKED_VOICE_WHY =
  '가지고 있는 소리 파일의 목소리로 바꿉니다.'
