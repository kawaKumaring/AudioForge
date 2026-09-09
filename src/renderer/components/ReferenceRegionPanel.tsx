import { useState, useEffect, useRef, useCallback, type CSSProperties, type MouseEvent } from 'react'
import {
  IDLE_SESSION, beginRequest, invalidate, applyEvent, decideAsyncResult, previewErrorText,
  type PreviewSession, type PreviewPhase, type PreviewEvent,
} from '../../shared/previewSession'
import {
  policyFromAnalysis, regionSliderBounds, clampDuration, judgeLength, lengthConditionText, regionNeedText,
  tooShortText, outsideRecommendedText, committedMismatchText, blockMessage, phaseForBlocking,
  type ReferencePolicySummary, type RefPhase,
} from '../../shared/referencePolicy'
import { useAppStore } from '../stores/app.store'

// 참조 음성 준비 패널 — 긴 원본을 거부하지 않고 "참조 원본"으로 수용하고,
// 파형에서 구간을 골라 mono/24k 파생 클립을 만든 뒤 그것만 합성/전사에 전달한다.
// 길이 조건(필수/권장)은 워커가 응답에 실어 준 엔진 정책(shared/referencePolicy)에서만 읽는다 — 이 파일에 숫자 없음.
// 원본은 변경하지 않는다. 준비 상태는 onState 콜백으로 상위(store slot)에 반영해 합성 버튼을 게이팅.
//
// clipKey('default'|emotionId)로 기본 참조와 감정별 참조에 공용 재사용된다. 여러 인스턴스가 서로 다른
// clipKey/path를 쓰면 파생 클립 폴더가 key별로 분리돼 상호 간섭하지 않는다.

// 상위(store)로 준비 상태를 올리는 패치 형태 — default(setTtsRefState)/emotion(setEmotionRefState) 공용.
export interface RefStatePatch {
  clip?: string
  ready?: boolean
  message?: string
  region?: { start: number; duration: number } | null
  /** 이 보고를 만든 요청. 상위가 낡은 보고를 버리는 기준이다(패널이 자동으로 붙인다). */
  reqId?: string
  /**
   * 준비 단계 — **문구가 아니라 이 값이 판정 근거다**(2026-09-09 관리자 검수).
   * 이 패널이 유일한 판정자다. 상위는 읽기만 한다.
   */
  phase?: RefPhase
}

interface ReferenceRegionPanelProps {
  path: string                          // 분석/트림 대상 원본 경로
  clipKey: string                       // 'default' | emotionId (파생 클립 식별)
  disabled: boolean                     // 합성 중 등 조작 불가
  onState: (s: RefStatePatch) => void   // 준비 상태 변경을 store slot에 반영
  label?: string                        // 헤더 표시명(감정 label). 기본 참조는 '참조 음성'
  /**
   * 구간 편집 UI 를 펼쳐 보여줄지(PHASE B). false 면 분석·자동 확정은 그대로 돌지만
   * 파형·슬라이더·확정 버튼 같은 내부 도구는 화면에 나오지 않는다(마운트는 유지 — 재분석 금지).
   * 미지정 시 true(기존 동작 그대로).
   */
  open?: boolean
  /**
   * 분석 직후 추천 구간으로 **한 번만** 자동 확정한다(PHASE B — 사용자가 구간을 고르지 않아도 됨).
   * 파일 하나당 1회. 실패하면 재시도하지 않고 사유만 올린다(무한 확정 루프 금지).
   */
  autoConfirm?: boolean
  /**
   * autoConfirm 자동 준비가 **끝났다**는 신호(성공·실패·해당 없음 모두). 한 파일당 한 번만 온다.
   *
   * ★ 이 신호가 필요한 이유: 보이지 않는 자리에서 한 명씩 준비를 돌리는 쪽은 '다음 사람으로 넘어갈
   *   시점'을 알아야 한다. 예전에는 그것을 **준비 상태 문구가 비었는지**로 판단했는데, 패널이 분석을
   *   시작하며 '목소리를 살펴보는 중입니다…'를 올리는 순간 조건이 깨져 드라이버가 스스로 사라졌다.
   *   그러면 이 패널이 언마운트돼 자동 확정이 영영 실행되지 않는다(실측 결함 — 카드가 '목소리 확인 중'
   *   에서 멈추고 사용자가 구간을 손으로 확정해야 했다).
   */
  onAutoConfirmSettled?: () => void
  /**
   * 상태 문구를 기본 화면용 평이한 말로 낸다(요청/실제 구간·확정 같은 내부 용어 숨김).
   * 실제 안전 오류(너무 짧음/길음·말 도중 절단·전사 실패·대사 불일치) 문구는 그대로 간다.
   */
  plainStatus?: boolean
  /**
   * 지금 **사용 중인** 확정 상태(store 슬롯). 있으면 마운트·재분석이 준비 상태를 내리지 않고, 슬라이더는
   * 확정 구간에서 시작하며, 재확정이 실패해도 이 상태를 그대로 둔다(패널은 사유만 말한다).
   * 구간 편집의 권위는 늘 전체 원본(path)이다 — clip 은 편집 대상이 아니다.
   */
  committed?: { clip: string; region: { start: number; duration: number } | null; whole?: boolean } | null
  /**
   * 이 패널이 처리하는 **요청의 식별자**. 올려 보내는 모든 보고에 그대로 붙는다.
   *
   * 왜 필요한가(2026-09-09 관리자 검수): 예전에는 원본 경로만 비교해서 낡은 결과를 걸렀다.
   * 같은 파일을 다시 고르면(다시 준비) 경로가 같아 낡은 결과가 새 요청의 상태를 덮을 수 있었다.
   * 값은 **마운트 시점에 고정**되므로, 요청이 바뀌면 호출부가 key 로 새 인스턴스를 만들어야 한다.
   */
  reqId?: string
}

interface Analysis {
  duration_sec: number
  sample_rate: number
  channels: number
  /** 구간을 추천한다(필수 상한이 있으면 그것, 없으면 권장 상한을 넘었을 때). */
  needs_region: boolean
  /** 필수 상한 초과 — 자르지 않으면 이 엔진이 쓸 수 없다. 없으면 needs_region 은 '권장' 이다. */
  region_required?: boolean
  too_short: boolean
  /** 필수 조건 안이지만 검증된(권장) 길이 밖. 경고만. */
  outside_recommended?: boolean
  valid_whole: boolean
  policy?: ReferencePolicySummary
  errors?: { code: string; message: string }[]
  warnings?: { code: string; message: string }[]
  recommend?: { ok: boolean; start_sec: number; dur_sec: number; whole_file?: boolean }
  peaks?: { peaks: number[]; duration_sec: number }
}

interface RegionMetrics {
  dur_sec: number
  silence_ratio: number
  clipping_ratio: number
  rms_dbfs: number
  in_range: boolean
  warnings: string[]
  /** 승인 불가 사유의 안정 코드. 하나라도 있으면 ready=false. 파이썬 analyze_region 이 만든다. */
  blocking?: string[]
  /** 알리되 막지는 않는 사유 코드. */
  warning_codes?: string[]
  /** 파이썬이 계산한 승인 가능 여부(= blocking 이 비어 있음). */
  ready?: boolean
  head_truncated?: boolean
  tail_truncated?: boolean
  /** 사용자가 처음 고른 구간. 기록용. */
  requested_region?: RegionSpan
  /** 실제 파생 WAV·모델 입력에 쓰인 구간. **확정 region 과 재현 권위는 이쪽이다.** */
  effective_region?: RegionSpan
  /** 자동 스냅 결과(이동량·정책 한도·auto/reconfirm). */
  snap?: { start_shift_sec?: number; end_shift_sec?: number; max_shift_sec?: number
           auto_shift_limit_sec?: number; status?: string; silence_count?: number }
  /** 최종 클립 전사와 manual_text 대조 요약(전사 원문은 담기지 않는다). */
  validation?: { status?: string; reason_code?: string | null; mismatch_where?: string[] }
  /**
   * 낱말 경계 경로를 썼을 때만 담긴다(말이 쉼 없이 이어져 무음 경계가 없는 음원).
   * used=false 면 시도했으나 쓰지 못한 것이고 reason 에 사유가 있다.
   */
  word_boundary?: { used?: boolean; reason?: string; word_count?: number
                    head_pad_sec?: number; tail_pad_sec?: number
                    pad_target_sec?: number; clip_duration_sec?: number }
}

interface RegionSpan {
  start_sec: number
  end_sec: number
  dur_sec: number
}

/** effective_region 이 재현 권위이므로 형식이 어긋나면 승인하지 않는다. */
function validSpan(r: RegionSpan | undefined): r is RegionSpan {
  return !!r && [r.start_sec, r.end_sec, r.dur_sec].every(v => typeof v === 'number' && Number.isFinite(v))
    && r.end_sec > r.start_sec && r.dur_sec > 0
}

// 차단 코드 → 사용자 문구는 shared/referencePolicy.blockMessage(정책 숫자 포함). 여기엔 표가 없다.

function fmt(s: number | undefined | null) {
  return typeof s === 'number' && Number.isFinite(s) ? `${s.toFixed(2)}초` : '-초'
}

// ── 미리듣기 DOM 조작(요소 수명은 컴포넌트가 소유, '적용/폐기' 판정은 shared/previewSession) ──

// 소스 전환은 항상 pause() → src 비우기 → 새 src 순서로만 한다.
// 재생 중인 요소의 src만 갈아끼우면 요소가 이상 상태로 남아(로드 미완·seek 무시) 이후 재생이 무음이 된다.
//
// 단, '진행 중인 로드'는 중간에 끊지 않는다. 끊긴 local-file:// 요청이 수십 개 쌓이면 그 뒤로는
// 어떤 미리듣기도 로드되지 않는다(재현 확인). 로드가 끝났거나 애초에 소스가 없을 때만 src를 비운다.
function detachSource(el: HTMLAudioElement) {
  try { el.pause() } catch { /* noop */ }
  if (el.readyState === 0 && el.networkState === 2 /* NETWORK_LOADING */) return
  el.removeAttribute('src')
  try { el.load() } catch { /* noop */ }
}
function attachSource(el: HTMLAudioElement, url: string) {
  el.src = url
  try { el.load() } catch { /* noop */ }
}

// loadedmetadata/canplay(또는 error/타임아웃)까지 기다린다. true면 재생 위치를 지정해도 안전하다.
// 로드가 끝나기 전 currentTime을 지정하거나 play()를 부르면 위치가 반영되지 않거나 프로미스가 거부된다.
function waitUntilLoaded(el: HTMLAudioElement, timeoutMs = 4000): Promise<boolean> {
  if (el.readyState >= 1 /* HAVE_METADATA */) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const onReady = () => finish(true)
    const onFail = () => finish(false)
    function finish(v: boolean) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      el.removeEventListener('loadedmetadata', onReady)
      el.removeEventListener('canplay', onReady)
      el.removeEventListener('error', onFail)
      resolve(v)
    }
    timer = setTimeout(() => finish(el.readyState >= 1), timeoutMs)
    el.addEventListener('loadedmetadata', onReady)
    el.addEventListener('canplay', onReady)
    el.addEventListener('error', onFail)
  })
}

export default function ReferenceRegionPanel({
  path, clipKey, disabled, onState, label = '참조 음성',
  open = true, autoConfirm = false, onAutoConfirmSettled, plainStatus = false, committed = null,
  reqId,
}: ReferenceRegionPanelProps) {
  // 확정 클립이 살아 있는가 — 재분석·재확정 실패가 이것을 내리지 않는다(사용 중인 목소리 보존).
  // whole = 원본 전체를 그대로 참조로 쓰는 준비 상태(클립·구간 없음). 이것도 '사용 중' 이므로 재분석이 준비를 내리지 않는다.
  const hasCommitted = !!(committed && (committed.clip || committed.region || committed.whole))
  // ★분석은 비동기다. **결과가 도착한 시점의** 사용 중 상태를 봐야 한다(2026-09-09 관리자 검수).
  //   예전에는 요청을 시작한 시점의 값을 붙잡고 있었다. 그 사이 이 목소리가 준비되면(자동 준비
  //   드라이버·이어받기·작업 복원 중 무엇이든) 낡은 값이 '아직 미준비' 라 판단해 준비된 상태를
  //   되돌렸다 — 실측: 이어받은 인물이 '구간 선택 필요' 로 내려앉아 준비가 끝나지 않았다.
  const committedRef = useRef(committed)
  committedRef.current = committed
  const hasCommittedNow = () => {
    const c = committedRef.current
    return !!(c && (c.clip || c.region || c.whole))
  }
  // 엔진 선택이 바뀌면 같은 원본을 그 엔진의 정책으로 다시 판정한다(사용 중 구간은 지우지 않는다).
  const ttsEngine = useAppStore((s) => s.ttsEngine)
  // 고급 설정의 '참조 목표 길이'. 0 = 엔진 권장 상한. 값이 바뀌면 추천도 다시 받아야 하므로
  // runAnalyze 의 의존성에 들어간다(설정만 바꾸고 예전 추천을 보고 있으면 안 된다).
  const ttsRefTargetSec = useAppStore((s) => s.ttsRefTargetSec)
  const setTtsReferencePolicy = useAppStore((s) => s.setTtsReferencePolicy)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  // 기본 화면(plainStatus)에서는 같은 사실을 쉬운 말로 낸다. 안전 오류 문구는 어느 쪽에서도 바꾸지 않는다.
  // ref 로 읽는 이유: runAnalyze(useCallback)에 잡힌 옛 closure 도 지금 값을 봐야 한다(재분석 유발 금지).
  const plainRef = useRef(plainStatus)
  plainRef.current = plainStatus
  const say = useCallback((expert: string, plain: string) => (plainRef.current ? plain : expert), [])
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  // 이 패널의 길이 정책 = 마지막 분석 응답의 policy(없으면 예전 표시로 폴백). ref 는 옛 closure(runAnalyze/confirm)용.
  const policy = policyFromAnalysis(analysis)
  const policyRef = useRef<ReferencePolicySummary>(policy)
  policyRef.current = policy
  const [loading, setLoading] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [start, setStart] = useState(0)      // 구간 시작(초)
  // 프로그램이 심은 슬라이더 값(추천 구간·사용 중 구간). 사용자가 움직인 것이 아니므로 '구간 변경' 으로 보지 않는다.
  // 예전에는 분석이 끝나 사용 중 구간을 슬라이더에 심는 순간 '구간을 변경했습니다 — 다시 확정' 로 준비를 내렸다(재확정 요구 결함).
  const seededRegion = useRef<{ start: number; dur: number } | null>(null)
  const [dur, setDur] = useState(7)          // 구간 길이(초)
  const [confirming, setConfirming] = useState(false)
  const [metrics, setMetrics] = useState<RegionMetrics | null>(null)
  const [confirmedClip, setConfirmedClip] = useState<string>('')
  // 실제로 잘려 나간 구간(재현 권위). 요청 구간과 다를 수 있어 사용자에게 그대로 보여 준다.
  const [effective, setEffective] = useState<RegionSpan | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // 구간 종료 타이머는 '어느 세대의 재생을 멈추려던 것인지'를 함께 들고 다닌다 — 옛 세대 타이머는 no-op.
  const stopTimer = useRef<{ id: ReturnType<typeof setTimeout>; gen: number } | null>(null)
  const sessionRef = useRef<PreviewSession>(IDLE_SESSION)
  const [previewPhase, setPreviewPhase] = useState<PreviewPhase>('idle')
  const [previewError, setPreviewError] = useState<string | null>(null)
  // audio ref 콜백은 stable해야 매 렌더 detach/attach가 일어나지 않는다 → fileUrl은 ref로 읽는다.
  const fileUrlRef = useRef<string | null>(fileUrl)
  fileUrlRef.current = fileUrl

  // onState는 상위에서 인라인 화살표로 올 수 있어 매 렌더 새 참조 → runAnalyze useCallback/effect가
  // 매 렌더 재실행되면 무한 재분석이 된다. ref로 최신 함수만 참조해 identity 의존을 끊는다.
  // 이 인스턴스가 맡은 요청 — **마운트 때 한 번 굳는다.** 늦게 도착한 보고도 이 값을 달고 나가므로
  // store 가 "그 사이 다른 목소리를 골랐다" 를 알아보고 버릴 수 있다.
  const ownReq = useRef(reqId)
  const rawOnState = useRef(onState)
  useEffect(() => { rawOnState.current = onState })
  // 모든 보고에 요청 식별자를 붙이는 한 겹. 보고하는 자리(14곳)를 각각 고치지 않기 위해서다.
  const onStateRef = useRef<(p: RefStatePatch) => void>(() => {})
  onStateRef.current = (patch: RefStatePatch) => rawOnState.current({ ...patch, reqId: ownReq.current })

  // 원본 재생용 URL — path에서 자체 취득(기본/감정 공용, 상위가 넘겨줄 필요 없음).
  useEffect(() => {
    let cancelled = false
    if (!path) { setFileUrl(null); return }
    Promise.resolve(window.api.audio.getFileUrl(path))
      .then((u) => { if (!cancelled) setFileUrl(u as string) })
      .catch(() => { if (!cancelled) setFileUrl(null) })
    return () => { cancelled = true }
  }, [path])

  // 분석 실행(재사용 — 파일 변경 시 + '다시 분석' 재시도). single-flight는 main IPC에서 보장.
  const runAnalyze = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!path) return
    setAnalysis(null); setMetrics(null); setAnalyzeError(null); setConfirmError(null)
    if (!hasCommitted) setConfirmedClip('')
    setLoading(true)
    // 확정된 구간이 있으면 재분석(편집기 다시 열기)이 준비 상태를 내리지 않는다 — 원본을 다시 살펴볼 뿐이다.
    if (!hasCommitted) {
      onStateRef.current({ phase: 'preparing', clip: '', message: say('참조 음성을 분석 중입니다...', '목소리를 살펴보는 중입니다…'), region: null })
    }
    try {
      const a = await window.api.audio.analyzeReference(path, clipKey, { ttsEngine, regionTargetSec: ttsRefTargetSec }) as Analysis & { error_message?: string; reason?: string }
      if (signal?.cancelled) return
      // 방어: 분석 payload가 올바르지 않으면(예: IPC 유실/실패) 검은 화면 대신 오류 처리 → "다시 분석"
      if (!a || typeof a.duration_sec !== 'number') {
        throw new Error(a?.error_message || a?.reason || '참조 분석 결과가 올바르지 않습니다')
      }
      setAnalysis(a)
      const committedThen = hasCommittedNow()   // 결과가 도착한 지금의 사용 중 상태
      const cNow = committedRef.current
      const pol = policyFromAnalysis(a)
      setTtsReferencePolicy(pol)            // 카드·자산 판정이 같은 정책을 본다
      if (a.too_short) {
        onStateRef.current({ phase: 'failed', clip: '', message: tooShortText(pol, a.duration_sec), region: null })
      } else if (a.needs_region) {
        const r = a.recommend
        if (committedThen && cNow?.region) {
          // 슬라이더는 사용 중인 구간에서 시작한다. 전체 원본 범위 안에서 자유롭게 넓힐 수 있다.
          const committed = { ...cNow, region: cNow.region }
          const cd = clampDuration(pol, a.duration_sec, committed.region.duration)
          seededRegion.current = { start: committed.region.start, dur: cd }
          setStart(committed.region.start); setDur(cd)
          setEffective({ start_sec: committed.region.start, dur_sec: committed.region.duration } as RegionSpan)
          if (committed.clip) setConfirmedClip(committed.clip)
          // 엔진 전환 재판정: 사용 중 구간이 새 엔진의 **필수** 조건 밖이면 준비를 내리고 사유·수정만 안내한다.
          // 클립·구간은 그대로 둔다(다른 목소리로 바꾸거나 다시 자르지 않는다). 권장 밖은 경고만(준비 유지).
          const j = judgeLength(pol, committed.region.duration)
          if (j === 'blocked_short' || j === 'blocked_long') {
            onStateRef.current({ phase: 'needs_region', clip: committed.clip, region: committed.region,
              message: committedMismatchText(pol, committed.region.duration) })
          }
        } else if (r && r.ok) {
          const rd = clampDuration(pol, a.duration_sec, r.dur_sec)
          seededRegion.current = { start: r.start_sec, dur: rd }
          setStart(r.start_sec); setDur(rd)
        }
        if (committedThen && cNow?.whole && a.region_required) {
          // 원본 전체를 쓰던 상태인데 새 엔진 정책이 구간을 필수로 요구한다 — 사유와 구간 수정만 안내(교체·삭제 없음).
          onStateRef.current({ phase: 'needs_region', clip: '', region: null, message: regionNeedText(pol, a.duration_sec, true) })
        }
        if (!committedThen) {
          onStateRef.current({
            // 자동 확정이 뒤따르면 이것은 '진행 중' 이다. 자동 확정이 없으면 사용자가 골라야 한다.
            phase: autoConfirm ? 'preparing' : 'needs_region', clip: '',
            message: say(regionNeedText(pol, a.duration_sec, !!a.region_required), '목소리에서 쓸 부분을 고르는 중입니다…'),
            region: null,
          })
        }
      } else if (a.valid_whole) {
        // 필수 조건 통과 + 구간 추천 불필요 → 원본을 그대로 참조로 사용(파생 클립 불필요, effective==원본).
        // 사용 중 구간이 있으면(이전 엔진에서 잘랐던 것) 그대로 둔다 — 필수 조건 밖이면 사유만 알린다.
        if (committedThen && cNow?.region) {
          const committed = { ...cNow, region: cNow.region }
          const j = judgeLength(pol, committed.region.duration)
          if (j === 'blocked_short' || j === 'blocked_long') {
            onStateRef.current({ phase: 'needs_region', clip: committed.clip, region: committed.region,
              message: committedMismatchText(pol, committed.region.duration) })
          }
        } else {
          onStateRef.current({ phase: 'ready', clip: '', message: '', region: null })
        }
      } else {
        const why = (a.errors || []).map(e => e.message).join(' / ') || '참조 음성 품질 오류'
        onStateRef.current({ phase: 'failed', clip: '', message: why, region: null })
      }
    } catch (e) {
      if (signal?.cancelled) return
      const msg = (e as Error)?.message || '참조 분석 실패'
      setAnalyzeError(msg)
      onStateRef.current({
        phase: 'failed', clip: '',
        message: say(`참조 분석 실패: ${msg}`, '이 파일에서 목소리를 확인하지 못했습니다.'),
        region: null,
      })
    } finally {
      if (!signal?.cancelled) setLoading(false)
    }
  }, [path, clipKey, say, ttsEngine, ttsRefTargetSec, setTtsReferencePolicy])

  // 파일이 바뀌면(그리고 엔진·목표 길이가 바뀌면) 분석
  // (StrictMode 중복 setup에도 main single-flight로 subprocess 1회).
  //
  // ★ 합성 중에는 분석을 부르지 않는다. 워커는 한 번에 하나만 돌기 때문에 main 이
  //   '처리 중에는 참조 분석을 실행할 수 없습니다' 로 거절하고, 그 거절이 화면에서
  //   처리되지 않은 오류로 튀어나온다(2026-09-08 실사용 보고).
  //   합성이 끝나 조작이 풀리면 그때 미뤄 둔 분석을 한다.
  //   무엇이 바뀌었을 때 다시 볼지는 아래 키가 정한다. 함수 신원(runAnalyze)에 맡기면
  //   문구 모드(plainStatus) 같은 무관한 변화에도 다시 돌고, 합성이 끝날 때마다 헛돈다.
  //   ★ '이미 한 번 시작했다'를 ref 로 기억하면 안 된다. StrictMode 는 효과를 실행 → 정리 →
  //     재실행하는데, 그러면 첫 실행이 정리에서 취소된 뒤 재실행이 ref 에 막혀 **분석이 영영
  //     끝나지 않는다**(실측: 이 방식으로 바꾸자마자 앱 검사 19건 중 7건이 무너졌다).
  //     중복 호출은 main 의 single-flight 가 이미 하나로 합친다 — 여기서 막을 일이 아니다.
  const analyzeKey = [path, clipKey, ttsEngine, String(ttsRefTargetSec)].join('|#|')
  useEffect(() => {
    if (!path || disabled) return          // 합성 중에는 미룬다 — 조작이 풀리면 이 효과가 다시 온다
    const signal = { cancelled: false }
    runAnalyze(signal)
    return () => { signal.cancelled = true }
    // runAnalyze 는 의존성에 넣지 않는다 — 위 키가 '다시 볼 이유' 의 권위다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzeKey, disabled, path])

  // 구간(start/dur)이 바뀌면 이전 확정은 무효 → 재확정 필요
  useEffect(() => {
    if (!analysis?.needs_region) return
    const seeded = seededRegion.current
    if (seeded && Math.abs(seeded.start - start) < 1e-6 && Math.abs(seeded.dur - dur) < 1e-6) return   // 심은 값 — 사용자의 변경이 아니다
    {
      setConfirmedClip(''); setMetrics(null)
      onStateRef.current({
        phase: 'needs_region', clip: '',
        message: say('구간을 변경했습니다 — 다시 확정하세요', '목소리에서 쓸 부분을 고르는 중입니다…'),
        region: null,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, dur])

  // ── 미리듣기(세대 기반) ────────────────────────────────────────────────────
  const commitSession = (next: PreviewSession) => {
    sessionRef.current = next
    setPreviewPhase(next.phase)
    setPreviewError(next.errorMessage)
  }
  // 비동기 결과를 세션에 반영한다. 옛 세대/불법 전이는 여기서 걸러져 아무 일도 하지 않는다.
  const dispatchPreview = (gen: number, event: PreviewEvent): boolean => {
    const v = applyEvent(sessionRef.current, gen, event)
    if (v.apply) commitSession(v.next)
    return v.apply
  }
  const clearRegionTimer = () => {
    if (stopTimer.current) { clearTimeout(stopTimer.current.id); stopTimer.current = null }
  }

  // audio 요소의 src는 React가 아니라 이 콜백이 소유한다 — 교체/해제 시 pause + src 비우기를 보장하기 위해.
  const setAudioEl = useCallback((el: HTMLAudioElement | null) => {
    const prev = audioRef.current
    if (prev === el) return
    if (stopTimer.current) { clearTimeout(stopTimer.current.id); stopTimer.current = null }
    if (prev) {
      detachSource(prev)
      // 요소가 교체/해제되면 진행 중이던 세대를 무효화 — 늦게 오는 로드/재생 결과가 새 요소를 건드리지 못하게.
      sessionRef.current = invalidate(sessionRef.current)
      setPreviewPhase('idle'); setPreviewError(null)
    }
    audioRef.current = el
    const url = fileUrlRef.current
    if (el && url) attachSource(el, url)
  }, [])

  // 소스가 바뀌면(파일 교체) 이전 재생을 끝내고 src를 비운 뒤 새 소스를 건다 + 세대 무효화.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (el.getAttribute('src') === (fileUrl || '')) return
    clearRegionTimer()
    detachSource(el)
    commitSession(invalidate(sessionRef.current))
    if (fileUrl) attachSource(el, fileUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl])

  const stopPlay = () => {
    clearRegionTimer()
    const el = audioRef.current
    if (el) { try { el.pause() } catch { /* noop */ } }
    // 정지도 세대를 올린다 — 아직 돌아오지 않은 로드/재생 결과가 다시 재생을 시작하지 못하게.
    commitSession(invalidate(sessionRef.current, 'stopped'))
  }

  // 언마운트(모드 전환·행 접기) 시 재생 정지 + 타이머 해제 — 잔여 재생 방지.
  useEffect(() => () => {
    if (stopTimer.current) { clearTimeout(stopTimer.current.id); stopTimer.current = null }
    const el = audioRef.current
    if (el) { try { el.pause() } catch { /* noop */ } }
  }, [])

  const playRegion = () => {
    const el = audioRef.current
    if (!el) return
    // (1) 이전 재생을 확실히 끝낸다 — 구간 종료 타이머 해제 + pause.
    clearRegionTimer()
    try { el.pause() } catch { /* noop */ }
    // (2) 새 세대. 이후 도착하는 이전 세대의 로드 완료·play 결과·구간 종료 타이머는 전부 폐기된다.
    const session = beginRequest(sessionRef.current)
    commitSession(session)
    const gen = session.gen
    const startSec = start
    const durSec = dur
    void (async () => {
      // (3) loadedmetadata/canplay 이전에는 seek·play 하지 않는다(위치 미반영·프로미스 거부의 원인).
      const loaded = await waitUntilLoaded(el)
      if (decideAsyncResult(sessionRef.current, gen) === 'discard') return
      if (!loaded) { dispatchPreview(gen, { kind: 'error', message: previewErrorText('load') }); return }
      if (!dispatchPreview(gen, { kind: 'ready' })) return
      try { el.currentTime = startSec } catch { /* noop */ }
      // play() 프로미스는 정착하지 않을 수도 있다(로드가 멈춘 요소) → 타임아웃과 경주시켜 '준비 중'에 갇히지 않게.
      const result = await Promise.race([
        el.play().then(() => 'ok', (e: unknown) => 'rejected:' + ((e as Error)?.name || '')),
        new Promise<string>((r) => setTimeout(() => r('timeout'), 4000)),
      ])
      // stale이면 그냥 물러난다 — 요소는 하나뿐이라 여기서 pause() 하면 이미 시작된 '새' 재생을 죽인다.
      // 정지 책임은 무효화한 쪽(stopPlay·소스 교체·언마운트·새 요청)이 이미 졌다.
      if (decideAsyncResult(sessionRef.current, gen) === 'discard') return
      if (result !== 'ok') {
        // 새 요청이 이 재생을 끊어서 생긴 거부(AbortError)는 옛 세대 → 위 stale 검사에서 이미 폐기된다.
        // 여기까지 온 실패는 삼키지 않고 사용자 언어 오류로 노출한다(자동 재시도 없음).
        const kind = el.error || result.includes('NotSupportedError') ? 'load' : 'play'
        dispatchPreview(gen, { kind: 'error', message: previewErrorText(kind) })
        return
      }
      if (!dispatchPreview(gen, { kind: 'play' })) return
      // (4) 구간 종료 타이머는 '실제 재생이 시작된 뒤'에 건다. 클릭 시각 기준이면 로드 시간만큼
      //     들리는 구간이 잘려 무음처럼 느껴진다. 세대를 함께 들고 있어 옛 타이머는 새 재생을 멈추지 못한다.
      const id = setTimeout(() => {
        if (decideAsyncResult(sessionRef.current, gen) === 'discard') return
        try { el.pause() } catch { /* noop */ }
        dispatchPreview(gen, { kind: 'region-end' })
      }, Math.max(100, durSec * 1000))
      stopTimer.current = { id, gen }
    })()
  }

  // startOverride/durOverride: 자동 확정이 '분석이 방금 추천한 값'을 그대로 쓰기 위한 통로.
  // (state 는 같은 커밋에서 아직 갱신 전일 수 있어 값을 인자로 받는다. 사용자 확정은 인자 없이 state 사용.)
  // 시작·길이를 한 곳에서 정리한다. 규칙은 둘뿐이다:
  //  · 길이는 정책 범위 안으로 맞춘다(엔진이 못 받는 길이를 손으로 만들 수 없게).
  //  · 원본 끝을 넘으면 **시작을 되돌리지 않고 길이를 줄인다.** 예전에는 시작 슬라이더의 상한이
  //    남은 길이였어서, 뒤쪽 구간을 보려면 먼저 길이를 줄여야 했다(사용자가 번거롭다고 지적한 지점).
  const applyRegion = (nextStart: number, nextDur: number) => {
    const total = durTotal
    const b = regionSliderBounds(policyRef.current, total)
    let d = Math.min(b.max, Math.max(b.min, Number.isFinite(nextDur) ? nextDur : b.min))
    const s = Math.max(0, Math.min(Number.isFinite(nextStart) ? nextStart : 0, Math.max(0, total - b.min)))
    if (s + d > total) d = Math.max(b.min, total - s)
    setStart(Math.round(s * 100) / 100)
    setDur(Math.round(d * 100) / 100)
  }

  const confirmRegion = async (startOverride?: number, durOverride?: number) => {
    if (!path || confirming) return
    const startSec = startOverride ?? start
    const durSec = durOverride ?? dur
    setConfirming(true)
    try {
      const raw = await window.api.audio.trimReference(path, startSec, durSec, clipKey, { ttsEngine }) as Record<string, unknown>
      // 실패 응답을 먼저 판정한다. 예전에는 성공 형태로 단언하고 res.metrics 를 읽어서,
      // Python 이 구조화 차단(REFERENCE_REGION_BLOCKED + blocking)을 보내도 metrics 가 없으니
      // 실제 사유 대신 '형식 불일치'만 떴다 — 사용자는 무엇을 고쳐야 하는지 알 수 없었다.
      const failed = raw?.status === 'failed' || typeof raw?.code === 'string'
      if (failed) {
        const codes = Array.isArray(raw.blocking)
          ? (raw.blocking as unknown[]).filter((c): c is string => typeof c === 'string')
          : []
        const msg = raw.code === 'REFERENCE_REGION_BLOCKED' && codes.length > 0
          ? codes.map(c => blockMessage(c, policyRef.current)).join(' · ')
          : (typeof raw.error_message === 'string' && raw.error_message
              ? raw.error_message
              : '구간을 확정하지 못했습니다.')
        if (hasCommitted || confirmedClip) {
          // 이전에 확정한 구간은 그대로 사용 중이다(main 도 이전 클립을 지우지 않았다). 사유만 말한다.
          setConfirmError(msg + ' — 이전에 확정한 구간을 그대로 사용합니다.')
          return
        }
        setConfirmedClip('')
        setEffective(null)
        setMetrics(null)
        onStateRef.current({ phase: 'failed', clip: '', message: msg, region: null })
        return
      }
      const res = raw as unknown as { clip_path: string; metrics: RegionMetrics }
      setMetrics(res.metrics)
      // 승인 여부는 구조화된 blocking 코드로만 정한다. 예전에는 경고 '문구'에 특정 낱말이
      // 들어 있는지로 판단해서, 새로 생긴 '말 도중 절단' 경고가 그 낱말을 안 가져 조용히
      // 승인됐다 — 그 클립이 그대로 ICL 프롬프트가 되어 참조 대사가 섞였다.
      // 승인 권위는 Python(analyze_region) 하나다. renderer 는 그 계약을 '해석'하지 않는다.
      // blocking 누락·타입 오류·ready 와의 모순은 전부 승인 거부로 떨어뜨린다(fail-closed).
      const m = res.metrics
      const blocking = Array.isArray(m?.blocking) ? m.blocking.filter(c => typeof c === 'string') : null
      // effective_region 이 확정 region 의 권위다. 형식이 어긋나면 fail-closed.
      const eff = m?.effective_region
      const contractOk = blocking !== null && typeof m?.ready === 'boolean'
        && m.ready === (blocking.length === 0) && validSpan(eff)
      const ok = contractOk && m.ready === true
      if (ok) {
        setConfirmedClip(res.clip_path)
        // 요청 구간이 아니라 **실제로 잘려 나간 구간**을 저장한다. 자동 스냅으로 옮겨졌을 때
        // 요청값을 저장하면 재현이 어긋난다.
        const span = eff as RegionSpan
        setEffective(span)
        setConfirmError(null)
        onStateRef.current({
          phase: 'ready', clip: res.clip_path, message: '',
          region: { start: span.start_sec, duration: span.dur_sec }
        })
      } else {
        setConfirmedClip('')
        setEffective(null)
        const msg = !contractOk
          ? say('구간 검사 결과를 읽지 못했습니다(형식 불일치). 다시 시도하세요.', '목소리 구간을 확인하지 못했습니다. 다시 시도해 주세요.')
          : (blocking as string[]).map(c => blockMessage(c, policyRef.current)).join(' · ')
        // 차단이 '구간을 다시 고르면 되는 일' 인지 '이 파일로는 안 되는 일' 인지는 코드로 정한다.
        onStateRef.current({ phase: contractOk ? phaseForBlocking(blocking as string[]) : 'failed',
          clip: '', message: msg || '구간 품질이 부적합합니다', region: null })
      }
    } catch (e) {
      if (hasCommitted || confirmedClip) {
        setConfirmError('목소리 구간을 준비하지 못했습니다. 이전에 확정한 구간을 그대로 사용합니다.')
      } else {
        onStateRef.current({
          phase: 'failed', clip: '',
          message: say(`파생 참조 생성 실패: ${(e as Error)?.message || ''}`, '목소리 구간을 준비하지 못했습니다. 다시 시도해 주세요.'),
          region: null,
        })
      }
    } finally {
      setConfirming(false)
    }
  }

  // ── 자동 구간 확정(PHASE B) ──────────────────────────────────────────────
  // 10초를 넘는 파일에서 사용자가 파형을 붙들고 있지 않아도 되게, 분석이 추천한 안전 구간으로
  // **파일당 정확히 1회** 확정을 시도한다. 실패하면 사유(BLOCK_MESSAGE)가 그대로 상위로 올라가고
  // 여기서 다시 시도하지 않는다 — 확정 실패 → 재시도 → 실패의 순환을 만들지 않기 위해서다.
  // 사용자가 '사용 구간 바꾸기'로 직접 조정한 뒤에는 기존대로 본인이 확정한다(자동 개입 없음).
  //
  // 그리고 **끝났다는 사실을 반드시 한 번 알린다**(onAutoConfirmSettled). 성공·실패·해당 없음을
  // 구분하지 않는다 — 부르는 쪽이 알아야 하는 것은 '이 인물은 더 기다릴 필요가 없다' 하나뿐이다.
  // 알리지 않으면 드라이버가 이 인물을 붙잡은 채 다음 사람으로 넘어가지 못한다.
  const autoConfirmedKey = useRef<string>('')
  const settledRef = useRef(onAutoConfirmSettled)
  settledRef.current = onAutoConfirmSettled
  const settledKey = useRef<string>('')
  const settleAuto = useCallback((key: string) => {
    if (settledKey.current === key) return        // 한 파일당 한 번만 알린다
    settledKey.current = key
    settledRef.current?.()
  }, [])
  useEffect(() => {
    if (!autoConfirm || !path) return
    const key = `${clipKey}\u0000${path}`
    if (hasCommitted) { settleAuto(key); return }        // 이미 쓰고 있는 구간이 있다 → 준비는 끝난 것
    if (analyzeError) { settleAuto(key); return }        // 분석 실패 — 사유는 이미 상위로 올렸다
    if (!analysis) return                                 // 아직 분석 중이다. **종료가 아니다.**
    if (autoConfirmedKey.current === key) return
    autoConfirmedKey.current = key
    if (!analysis.needs_region) { settleAuto(key); return }   // 원본을 그대로 쓸 수 있다/못 쓴다 — 분석이 이미 판정했다
    const r = analysis.recommend
    if (!r || !r.ok) { settleAuto(key); return }              // 추천이 없으면 임의로 고르지 않는다
    void confirmRegion(r.start_sec, clampDuration(policyRef.current, analysis.duration_sec, r.dur_sec))
      .finally(() => settleAuto(key))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConfirm, path, clipKey, analysis, analyzeError, hasCommitted, settleAuto])

  if (!path) return null

  // 접힌 상태(기본 화면): 분석·자동 확정은 계속 돌지만 내부 도구는 그리지 않는다.
  // 단 '분석 자체가 실패'한 것은 사용자가 손쓸 수 있는 실제 오류이므로 재시도 경로를 남긴다.
  if (!open) {
    if (!analyzeError) return null
    return (
      <div role="alert" style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        borderRadius: 8, background: 'var(--bg-elevated)', padding: '8px 12px',
      }}>
        <span style={{ fontSize: 11, color: 'var(--rose)', flex: 1, minWidth: 160 }}>
          이 파일에서 목소리를 확인하지 못했습니다.
        </span>
        <button onClick={() => runAnalyze()} disabled={disabled || loading} aria-label="목소리 다시 확인"
          style={btn('var(--rose)', '#fff')}>다시 시도</button>
      </div>
    )
  }

  const card: CSSProperties = {
    borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8
  }
  const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
  const numBox: CSSProperties = {
  width: 74, fontSize: 11, padding: '3px 6px', borderRadius: 6, textAlign: 'right',
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
}

const sub: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }

  if (loading) {
    return <div style={card}><span role="status" aria-live="polite" aria-busy="true" style={sub}>참조 음성 분석 중...</span></div>
  }
  if (analyzeError) {
    return (
      <div style={card} role="alert">
        <span style={{ ...sub, color: 'var(--rose)' }}>참조 분석 실패: {analyzeError}</span>
        <div>
          <button onClick={() => runAnalyze()} disabled={disabled || loading} aria-label="참조 음성 다시 분석" style={{
            padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
            fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
            background: 'var(--rose)', color: '#fff', opacity: (disabled || loading) ? 0.5 : 1,
          }}>다시 분석</button>
          <span style={{ ...sub, marginLeft: 8 }}>일시적 오류일 수 있습니다 — 파일을 다시 올릴 필요 없이 재시도하세요.</span>
        </div>
      </div>
    )
  }
  if (!analysis) return null

  const durTotal = analysis.duration_sec
  const sliderBounds = regionSliderBounds(policy, durTotal)
  const lengthJudgement = judgeLength(policy, dur)
  // 자동으로 찾아 준 구간 — 되돌리기의 목적지. 정책 길이로 다듬어 두어야 슬라이더와 같은 값이 된다.
  const recommended = analysis.recommend?.ok
    ? { start: analysis.recommend.start_sec,
        dur: clampDuration(policy, durTotal, analysis.recommend.dur_sec) }
    : null
  const atRecommended = !!recommended
    && Math.abs(start - recommended.start) < 0.005 && Math.abs(dur - recommended.dur) < 0.005

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={labelStyle}>{label}</span>
        <span style={sub}>
          길이 {fmt(durTotal)} · {analysis.sample_rate.toLocaleString()}Hz · {analysis.channels === 1 ? '모노' : `${analysis.channels}채널`} · {lengthConditionText(policy)}
        </span>
      </div>

      {/* 필수 하한 미달 → 다른 파일 요청 */}
      {analysis.too_short && (
        <div style={{ ...sub, color: 'var(--rose)' }}>
          {tooShortText(policy, durTotal)}
        </div>
      )}

      {/* 필수 조건 통과 + 구간 추천 불필요 → 원본 그대로 사용 */}
      {!analysis.too_short && !analysis.needs_region && analysis.valid_whole && (
        <div style={{ ...sub, color: 'var(--cyan)' }}>
          길이·품질 조건을 만족합니다. 이 파일을 참조로 사용합니다.
          {analysis.outside_recommended && (
            <span data-testid="whole-outside-recommended" style={{ color: 'var(--amber, #d08700)' }}> · {outsideRecommendedText(policy, durTotal)}</span>
          )}
          {(analysis.warnings || []).length > 0 && (
            <span style={{ color: 'var(--text-muted)' }}> · 참고: {(analysis.warnings || []).map(w => w.message).join(', ')}</span>
          )}
        </div>
      )}

      {/* 길이는 통과했지만 품질 오류 */}
      {!analysis.too_short && !analysis.needs_region && !analysis.valid_whole && (
        <div style={{ ...sub, color: 'var(--rose)' }}>
          {(analysis.errors || []).map(e => e.message).join(' / ') || '참조 음성 품질이 합성에 부적합합니다.'}
        </div>
      )}

      {/* 구간 추천(필수 상한 초과 또는 권장 상한 초과) → 구간 선택 */}
      {analysis.needs_region && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 정책이 말하는 사실만 남긴다. '어떻게 조정하는가'는 도구에 붙은 설명(tooltip)으로 옮겼다 —
              화면마다 방법을 적어 두면 읽히지 않고 자리만 차지한다. */}
          <div style={sub} data-testid="region-need" data-required={analysis.region_required ? 'true' : 'false'}
            title="선택한 구간만 참조로 쓰입니다. 원본 파일은 변경되지 않습니다.">
            {regionNeedText(policy, durTotal, !!analysis.region_required)}
          </div>

          {/* 파형 + 구간 하이라이트 (클릭으로 시작 위치 이동) */}
          <Waveform peaks={analysis.peaks?.peaks || []} durTotal={durTotal} start={start} dur={dur}
            disabled={disabled}
            onSeek={(s) => setStart(Math.max(0, Math.min(s, durTotal - dur)))}
            onSelect={(s, d) => applyRegion(s, d)} />

          {/* 시작/길이 — 슬라이더로 훑고, 숫자로 정확히 넣는다.
              시작을 뒤로 밀면 길이를 막지 않고 남은 만큼으로 줄인다(위치가 길이에 갇히지 않게). */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 220 }}>
              <span style={sub} aria-hidden="true">시작</span>
              <input type="range" min={0} max={Math.max(0, durTotal - sliderBounds.min)} step={0.01} value={start} disabled={disabled}
                aria-label="참조 구간 시작 위치(초)"
                aria-valuetext={`${start.toFixed(2)}초`}
                onChange={(e) => applyRegion(parseFloat(e.target.value), dur)} style={{ flex: 1, accentColor: 'var(--rose)' }} />
              <input type="number" data-testid="region-start-number" min={0} max={durTotal} step={0.01} value={Number(start.toFixed(2))}
                disabled={disabled} aria-label="참조 구간 시작 위치 직접 입력(초)"
                onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) applyRegion(v, dur) }}
                style={numBox} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 220 }}>
              <span style={sub} aria-hidden="true">길이</span>
              <input type="range" min={sliderBounds.min} max={sliderBounds.max} step={0.01} value={dur} disabled={disabled}
                aria-label="참조 구간 길이(초)"
                aria-valuetext={`${dur.toFixed(2)}초`}
                onChange={(e) => applyRegion(start, parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--rose)' }} />
              <input type="number" data-testid="region-dur-number" min={sliderBounds.min} max={sliderBounds.max} step={0.01} value={Number(dur.toFixed(2))}
                disabled={disabled} aria-label="참조 구간 길이 직접 입력(초)"
                onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) applyRegion(start, v) }}
                style={numBox} />
            </div>
          </div>
          {/* 지금 구간 + 되돌리기.
              왜 필요한가: 추천 구간에 한 번 손을 대면 그 추천으로 돌아갈 길이 없었다. 돌아가려면
              목소리를 다시 등록해 분석을 처음부터 시키는 수밖에 없었다(사용자 지적, 2026-09-08).
              추천값은 분석 결과에 그대로 남아 있으므로 다시 부르기만 하면 된다.
              버튼은 숨기지 않고 **비활성**으로 둔다 — 슬라이더를 만질 때마다 버튼이 나타났다
              사라지면 화면이 움직여 조작을 방해한다(카드 깜빡임 때 겪은 것과 같은 문제). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={sub} title="파형을 끌어 구간을 잡거나, 숫자 칸에 0.01초 단위로 직접 넣을 수 있습니다.">
              지금 구간 {start.toFixed(2)}~{(start + dur).toFixed(2)}초
            </span>
            {recommended && (
              <button data-testid="region-reset-recommend"
                onClick={() => applyRegion(recommended.start, recommended.dur)}
                disabled={disabled || atRecommended}
                title={atRecommended
                  ? '지금이 자동으로 찾아 준 구간입니다.'
                  : `자동으로 찾아 준 구간(${recommended.start.toFixed(2)}~${(recommended.start + recommended.dur).toFixed(2)}초)으로 되돌립니다. 되돌린 뒤 '이 구간으로 확정'을 눌러야 실제로 바뀝니다.`}
                style={{
                  ...btn('transparent', atRecommended ? 'var(--text-muted)' : 'var(--cyan)'),
                  border: `1px solid ${atRecommended ? 'var(--border-subtle)' : 'var(--cyan)'}`,
                  padding: '2px 8px', fontSize: 11,
                }}>
                {atRecommended ? '자동으로 찾은 구간' : '자동으로 찾은 구간으로'}
              </button>
            )}
          </div>

          {/* 권장(검증) 범위 밖 길이 — 막지 않고 알린다 */}
          {lengthJudgement === 'outside_recommended' && (
            <div role="status" aria-live="polite" data-testid="region-outside-recommended" style={{ ...sub, color: 'var(--amber, #d08700)' }}>
              {outsideRecommendedText(policy, dur)}
            </div>
          )}
          {/* 재생 · 확정 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={playRegion} disabled={disabled} data-af-preview-phase={previewPhase}
              style={btn('var(--bg-elevated)', 'var(--text-secondary)')}>▶ 구간 미리듣기</button>
            <button onClick={stopPlay} disabled={disabled} style={btn('var(--bg-elevated)', 'var(--text-muted)')}>■ 정지</button>
            <button onClick={() => { void confirmRegion() }} disabled={disabled || confirming}
              style={btn(confirmedClip ? 'var(--bg-elevated)' : 'var(--rose)', confirmedClip ? 'var(--cyan)' : '#fff')}>
              {confirming ? '생성 중...' : confirmedClip ? '✓ 확정됨 (다시 확정)' : '이 구간으로 확정'}
            </button>
            {/* 재생 상태를 눈에 보이게 — '눌렀는데 아무 반응 없음'을 없앤다 */}
            <span role="status" aria-live="polite" style={{ ...sub, minWidth: 44 }}>
              {previewPhase === 'playing' ? '재생 중' : previewPhase === 'loading' ? '준비 중' : ''}
            </span>
            <span style={{ ...sub, marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>선택 {fmt(dur)}</span>
          </div>
          {confirmError && (
            <div role="status" aria-live="polite" data-testid="region-confirm-kept" style={{ ...sub, color: 'var(--amber, #d4a017)' }}>
              {confirmError}
            </div>
          )}
          <div style={{ display: 'none' }}>
          </div>

          {/* 미리듣기 실패는 삼키지 않고 보여준다(사용자 언어·경로 미노출·자동 재시도 없음) */}
          {previewError && (
            <div role="alert" style={{ ...sub, color: 'var(--rose)' }}>{previewError}</div>
          )}

          {/* 확정 후 구간 품질 지표 */}
          {metrics && (
            <div role="status" aria-live="polite" style={{ ...sub, borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
              구간 품질 — 길이 {fmt(metrics.dur_sec)} · 무음 {(metrics.silence_ratio * 100).toFixed(0)}% ·
              클리핑 {(metrics.clipping_ratio * 100).toFixed(2)}% · RMS {metrics.rms_dbfs.toFixed(1)}dBFS
              {metrics.warnings.length > 0 && (
                <div style={{ color: 'var(--rose)', marginTop: 2 }}>⚠ {metrics.warnings.join(' · ')}</div>
              )}
              {effective && metrics.effective_region && metrics.requested_region
                && Math.abs(effective.start_sec - metrics.requested_region.start_sec) > 0.005 && (
                <div style={{ color: 'var(--amber, #d08700)', marginTop: 2 }}>
                  구간이 자동 조정됐습니다: {metrics.requested_region.start_sec.toFixed(2)}~
                  {metrics.requested_region.end_sec.toFixed(2)}초 →{' '}
                  {effective.start_sec.toFixed(2)}~{effective.end_sec.toFixed(2)}초
                  {' '}(아래 확정 클립이 실제로 쓰일 소리입니다)
                </div>
              )}
              {metrics.word_boundary?.used && (
                <div style={{ marginTop: 2 }}
                  title={'말이 쉼 없이 이어지는 음원은 0.2초 이상의 무음이 없어서 예전에는 구간을 만들 수 없었습니다. '
                    + '이제는 낱말 사이(여백 '
                    + `${((metrics.word_boundary.head_pad_sec ?? 0) * 1000).toFixed(0)}ms · `
                    + `${((metrics.word_boundary.tail_pad_sec ?? 0) * 1000).toFixed(0)}ms)에서 자르고, `
                    + `양 끝에 ${((metrics.word_boundary.pad_target_sec ?? 0) * 1000).toFixed(0)}ms 무음을 넣어 `
                    + '경계를 부드럽게 만듭니다. 자른 자리가 말 도중이 아닌지는 무음을 넣기 전에 검사합니다.'}>
                  낱말 사이에서 잘랐고 양 끝에 짧은 무음을 넣었습니다
                </div>
              )}
              {confirmedClip && metrics.warnings.length === 0 && (
                <span style={{ color: 'var(--cyan)' }}> · 참조 준비 완료</span>
              )}
            </div>
          )}

          {/* 원본 재생용(숨김 오디오). src는 setAudioEl/fileUrl effect가 소유한다 — 재생 중 src만 갈아끼우지 않기 위해. */}
          {fileUrl && <audio ref={setAudioEl} preload="auto" style={{ display: 'none' }} />}
        </div>
      )}
    </div>
  )
}

function btn(bg: string, color: string): CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
    fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: bg, color
  }
}

// 파형: coarse peaks를 막대로, 선택 구간을 하이라이트. 클릭으로 시작 위치 이동.
function Waveform({ peaks, durTotal, start, dur, disabled, onSeek, onSelect }: {
  peaks: number[]; durTotal: number; start: number; dur: number; disabled: boolean
  onSeek: (s: number) => void
  /** 파형에서 끌어 고른 구간(초). 짧게 끌면(클릭에 가까움) 선택으로 보지 않는다. */
  onSelect?: (startSec: number, durSec: number) => void
}) {
  const W = 100, H = 100  // viewBox 단위(%). preserveAspectRatio none으로 늘림.
  const n = peaks.length || 1
  const regA = durTotal > 0 ? (start / durTotal) * W : 0
  const regB = durTotal > 0 ? ((start + dur) / durTotal) * W : 0
  // 끌어서 구간 잡기 — 슬라이더 둘을 번갈아 만지지 않고 위치와 길이를 한 번에 정한다.
  // 누른 지점과 뗀 지점이 구간의 양 끝이다. 끄는 동안에는 그 자리를 옅게 보여 준다.
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const secAt = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    return frac * durTotal
  }
  const DRAG_MIN_SEC = 0.15   // 이보다 짧으면 '끌었다'가 아니라 클릭이다
  const handleDown = (e: MouseEvent<SVGSVGElement>) => {
    if (disabled || durTotal <= 0 || !onSelect) return
    const s = secAt(e)
    setDrag({ a: s, b: s })
  }
  const handleMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!drag) return
    setDrag({ a: drag.a, b: secAt(e) })
  }
  const handleUp = (e: MouseEvent<SVGSVGElement>) => {
    if (!drag) return
    const b = secAt(e)
    const lo = Math.min(drag.a, b)
    const hi = Math.max(drag.a, b)
    setDrag(null)
    if (hi - lo >= DRAG_MIN_SEC) onSelect?.(lo, hi - lo)
    else onSeek(lo - dur / 2)          // 클릭은 예전처럼 그 지점을 구간 중앙으로
  }
  const handleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (disabled || durTotal <= 0) return
    if (onSelect) return               // 끌기 경로가 클릭까지 처리한다(중복 처리 금지)
    onSeek(secAt(e) - dur / 2)
  }
  const dragA = drag && durTotal > 0 ? (Math.min(drag.a, drag.b) / durTotal) * W : 0
  const dragB = drag && durTotal > 0 ? (Math.max(drag.a, drag.b) / durTotal) * W : 0
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onClick={handleClick}
      onMouseDown={handleDown} onMouseMove={handleMove} onMouseUp={handleUp}
      onMouseLeave={() => setDrag(null)}
      role="img"
      aria-label={`참조 파형 미리보기 — 전체 ${durTotal.toFixed(1)}초 중 ${start.toFixed(1)}~${(start + dur).toFixed(1)}초 선택됨. 파형을 끌어 구간을 잡거나 아래 슬라이더·숫자로 조정하세요.`}
      style={{ width: '100%', height: 72, background: 'var(--bg-elevated)', borderRadius: 8, cursor: disabled ? 'default' : (onSelect ? 'ew-resize' : 'pointer'), display: 'block', userSelect: 'none' }}>
      {drag && (
        <rect x={dragA} y={0} width={Math.max(0, dragB - dragA)} height={H} fill="rgba(34,211,238,0.20)" />
      )}
      {/* 선택 구간 하이라이트 */}
      <rect x={regA} y={0} width={Math.max(0, regB - regA)} height={H} fill="rgba(251,113,133,0.18)" />
      <line x1={regA} y1={0} x2={regA} y2={H} stroke="var(--rose)" strokeWidth={0.4} />
      <line x1={regB} y1={0} x2={regB} y2={H} stroke="var(--rose)" strokeWidth={0.4} />
      {/* 파형 막대 */}
      {peaks.map((p, i) => {
        const x = (i / n) * W
        const h = Math.max(0.5, p * H * 0.9)
        const inReg = x >= regA && x <= regB
        return <rect key={i} x={x} y={(H - h) / 2} width={W / n} height={h}
          fill={inReg ? 'var(--rose)' : 'var(--text-muted)'} opacity={inReg ? 0.9 : 0.4} />
      })}
    </svg>
  )
}
