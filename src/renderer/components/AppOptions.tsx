import PlaybackEffectsPanel from './PlaybackEffectsPanel'
import SpeakerQuickSettings from './SpeakerQuickSettings'
/**
 * 앱 설정 — **만든 것을 어디에 둘지**와 **쌓인 것을 비우기.**
 *
 * ★왜 생겼나 (2026-09-28 사용자 지시)
 *   "옵션기능을 구현하면 그곳에 생성할 위치를 정하는 기능과 그아래 설정체크를 둬서
 *    참조 목소리 원본파일 옆에 생성을 구현한뒤 체크를 하면 지금처럼 원본파일 옆에 생성"
 *   "이런 캐쉬나 이전작업 등을 초기화하는 기능도 구현하는게 좋을듯하다"
 *
 *   그 전에는 자리를 바꿀 길이 아예 없었다. 앱이 정한 곳에 쌓였고 사용자는 그것을
 *   고른 적이 없다. 쌓인 것을 비울 길도 없어서 파일 탐색기로 직접 지워야 했다.
 *
 * ★팝업으로 연다 (2026-09-28 지시: "설정은 팝업으로 구현한다").
 *   화면 안에 끼워 넣으면 작업 내용이 아래로 밀려 어디까지가 설정인지 흐려진다.
 *   Esc 로 닫히고, 열려 있는 동안 뒤 화면은 조작되지 않는다.
 *
 * 이 화면이 지키는 것
 *   · 지우기는 **되돌릴 수 없다** — 무엇이 사라지고 무엇이 남는지 먼저 말하고 묻는다.
 *   · 만든 소리 파일과 작업 기록은 **다른 것**이다. 한 단추로 함께 지우지 않는다.
 *   · 상시 설명 문단을 두지 않는다. 사연은 도움말(툴팁)로 간다.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { outputRootNotice, type OutputPlace } from '../../shared/outputLayout'
import { exportDiagnosticsText } from '../../shared/diagnostics'
import { useConsolePanel, setConsoleOpen } from './ConsolePanel'
import { CHECKS, formatReport, type CheckId, type CheckResult } from '../../shared/selfCheck'

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }
const panel: CSSProperties = {
  border: '1px solid var(--border-subtle)', borderRadius: 12,
  background: 'var(--bg-card)', padding: 16, display: 'grid', gap: 12,
}
const button: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', minHeight: 30,
  borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const muted: CSSProperties = { fontSize: 11, color: 'var(--text-muted)' }
const pathBox: CSSProperties = {
  flex: '1 1 260px', minWidth: 0, fontSize: 11, color: 'var(--text-secondary)',
  background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: 8,
  padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

/** 비울 수 있는 것들. **각각 무엇인지 한 줄로 말한다.** */
type WipeKind = 'cache' | 'works' | 'media'
const WIPE: Record<WipeKind, { label: string; what: string; keeps: string }> = {
  cache: {
    label: '캐시 비우기',
    what: '화면·글꼴 같은 임시 자료를 지웁니다.',
    keeps: '작업 기록과 만든 소리 파일은 그대로입니다. 다음에 켤 때 다시 만들어집니다.',
  },
  media: {
    label: '중간 산출물 비우기',
    what: '영상에서 꺼낸 소리, 참조 클립, 미리듣기를 지웁니다. 옛 임시 자리에 남은 것도 함께 치웁니다.',
    keeps: '작업 기록과 최종 결과물은 그대로입니다. 필요할 때 다시 만들어집니다.',
  },
  works: {
    label: '이전 작업 기록 지우기',
    what: '저장된 카드 작업과 옛 화면 기록을 모두 지웁니다.',
    keeps: '★만들어 둔 소리 파일은 지우지 않습니다. 결과 폴더에 그대로 남습니다.',
  },
}

/**
 * ★"결과 폴더에서 되살리기" 는 **뺐다** (2026-09-28 지시: "아무리 봐도 이해가 안간다
 *   사용되지 않을듯하다"). 손으로 결과 폴더를 짚어 되불러오는 길이었다.
 *   파일을 열면 앱이 스스로 이전 결과를 찾아 알려 주므로(원본 카드의 안내),
 *   손으로 짚는 길은 쓰이지 않고 이름만 헷갈렸다.
 */
export default function AppOptions({ close, initialTab = 'general' }: { close: () => void; initialTab?: 'general' | 'sound' }) {
  const [place, setPlace] = useState<OutputPlace>('app')
  const [chosen, setChosen] = useState('')
  const [appRoot, setAppRoot] = useState('')
  const [notice, setNotice] = useState('')
  const [fault, setFault] = useState('')
  const [ask, setAsk] = useState<WipeKind | null>(null)
  const [busy, setBusy] = useState(false)
  // 임시 자리 — 앱 안이어야 한다. 화면에 내보이면 조용히 새는 것이 눈에 띈다.
  const [tempDir, setTempDir] = useState('')
  const [stray, setStray] = useState(0)
  // ── 탭 (2026-09-30 지시: "설정에서 기능 검사 탭을 따로 만든 뒤 각 기능별 검사 버튼") ──
  const [tab, setTab] = useState<'general' | 'checks' | 'sound'>(initialTab)
  const [checks, setChecks] = useState<Partial<Record<CheckId, CheckResult>>>({})
  const [runningIds, setRunningIds] = useState<CheckId[]>([])
  const [reportNote, setReportNote] = useState('')
  useEffect(() => {
    if (tab !== 'checks') return
    void window.api.selfcheck.results().then((list) => {
      const m: Partial<Record<CheckId, CheckResult>> = {}
      for (const x of list) m[x.id as CheckId] = x as CheckResult
      setChecks(m)
    }).catch(() => {})
  }, [tab])
  const runCheck = async (id: CheckId) => {
    setRunningIds((cur) => cur.includes(id) ? cur : [...cur, id])
    try {
      const got = await window.api.selfcheck.run(id)
      if ('error' in got) setChecks((m) => ({ ...m, [id]: { id, ok: false, reason: got.error, ms: 0, at: new Date().toISOString() } }))
      else setChecks((m) => ({ ...m, [id]: got as CheckResult }))
    } finally {
      setRunningIds((cur) => cur.filter((x) => x !== id))
    }
  }
  // ★문제 보고용 복사 — 검사 결과와 최근 동작 기록을 **한 번에.** 이것 하나만 붙여 넣으면 된다.
  const copyReport = async () => {
    try {
      const [lines, info] = await Promise.all([window.api.logs.recent(), window.api.app.getBuildInfo().catch(() => null)])
      const head = `AudioForge ${(info as { version?: string } | null)?.version ?? ''} · 문제 보고`.trim()
      const text = formatReport(Object.values(checks) as CheckResult[], lines.slice(-400), head)
      await window.api.utils.copyToClipboard(text)
      setReportNote(`복사했습니다 — 검사 ${Object.keys(checks).length}개 · 동작 기록 ${Math.min(400, lines.length)}건`)
    } catch { setReportNote('복사하지 못했습니다') }
  }
  // ── 문제 확인 (2026-09-30 지시: 콘솔 창 켜기 · 진단 묶음을 설정 안으로) ──
  const consoleOpen = useConsolePanel((s) => s.open)
  const toggleConsole = async (on: boolean) => {
    if (!(await setConsoleOpen(on))) setFault('콘솔 창 설정을 저장하지 못했습니다 — 다시 켜면 예전 값으로 돌아갑니다.')
  }
  // 진단 묶음 — 결과는 한 줄 글로만 말한다. 경로는 화면에 오지 않는다(폴더 이름만).
  const [diag, setDiag] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null })
  const exportDiagnostics = async () => {
    if (diag.busy) return
    setDiag({ busy: true, text: null })
    try {
      const r = await window.api.app.exportDiagnostics()
      if (r.ok) setDiag({ busy: false, text: `진단 묶음을 만들었습니다: ${r.name} (로그 ${r.logCount}개)` })
      else if (r.reason === 'cancelled') setDiag({ busy: false, text: null })
      // ★원문 대신 코드→문구. 예전에는 fs 오류 원문(절대 경로 포함)을 그대로 찍었다.
      else setDiag({ busy: false, text: exportDiagnosticsText(r.code) })
    } catch (e) {
      setDiag({ busy: false, text: `진단 묶음을 만들지 못했습니다: ${(e as Error)?.message || '알 수 없는 이유'}` })
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const got = await window.api.options.get()
        setChosen(got.chosenRoot || '')
        setAppRoot(got.appRoot || '')
        setPlace(got.beside ? 'beside' : (got.chosenRoot ? 'chosen' : 'app'))
        setTempDir(got.tempDir || '')
        setStray(got.strayTemp || 0)
      } catch { setFault('설정을 읽지 못했습니다.') }
    })()
  }, [])

  const save = async (next: { chosenRoot?: string; beside?: boolean }) => {
    setFault(''); setNotice('')
    try {
      const got = await window.api.options.set(next)
      setChosen(got.chosenRoot || '')
      setPlace(got.beside ? 'beside' : (got.chosenRoot ? 'chosen' : 'app'))
      setNotice('저장했습니다.')
    } catch { setFault('저장하지 못했습니다.') }
  }

  const pickFolder = async () => {
    setFault('')
    try {
      const picked = await window.api.options.pickRoot()
      if (!picked) return                       // 취소는 실패가 아니다
      if (picked.error) { setFault(picked.error); return }
      await save({ chosenRoot: picked.path })
    } catch { setFault('폴더를 고르지 못했습니다.') }
  }

  const wipe = async (kind: WipeKind) => {
    setBusy(true); setFault(''); setNotice('')
    try {
      const r = await window.api.options.wipe(kind)
      setAsk(null)
      setNotice(r.removed
        ? `${WIPE[kind].label} — ${r.removed}개, 약 ${r.freedMb}MB 를 비웠습니다.`
        : '비울 것이 없었습니다.')
      // 비운 뒤 다시 읽는다 — 옛 자리가 0이 됐는데 안내가 남아 있으면 거짓말이 된다.
      try { const again = await window.api.options.get(); setStray(again.strayTemp || 0) } catch { /* 안내만 못 고친다 */ }
    } catch { setFault('비우지 못했습니다.') } finally { setBusy(false) }
  }

  const effectiveRoot = place === 'chosen' && chosen ? chosen : appRoot

  // 팝업은 열릴 때 스스로 뜬다. 떠날 때 반드시 닫는다 — 남으면 뒤 화면이 잠긴다.
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close() }, [])

  return (
    <dialog ref={ref} data-testid="app-options" aria-label="설정"
      onCancel={(e) => { e.preventDefault(); close() }}
      style={{
        margin: 'auto', width: 620, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)',
        padding: 20, border: '1px solid var(--border-subtle)', borderRadius: 16,
        background: 'var(--bg-card)', color: 'var(--text-primary)',
        boxShadow: '0 24px 100px rgba(0,0,0,.5)', overflowY: 'auto',
      }}>
    <section style={{ display: 'grid', gap: 16 }}>
      <div style={{ ...row }}>
        <h2 style={{ margin: 0, fontSize: 17, flex: 1 }}>설정</h2>
        <button type="button" data-testid="options-close" style={button} onClick={close}>닫기</button>
      </div>
      <div role="tablist" aria-label="설정 갈래" style={{ ...row, gap: 6 }}>
        {([['general', '일반'], ['sound', '소리 다듬기'], ['checks', '기능 검사']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`options-tab-${k}`}
            onClick={() => setTab(k)}
            style={{ ...button, borderColor: tab === k ? 'var(--accent-light)' : undefined, color: tab === k ? 'var(--accent-light)' : undefined }}>
            {label}
          </button>
        ))}
      </div>

      {fault && <div role="alert" data-testid="options-fault" style={{ fontSize: 12, color: 'var(--rose)' }}>{fault}</div>}
      {notice && <div role="status" data-testid="options-notice" style={{ fontSize: 12, color: 'var(--accent-light)' }}>{notice}</div>}

      {tab === 'sound' && <><SpeakerQuickSettings basicsOnly/><PlaybackEffectsPanel embedded/></>}
      {tab === 'general' && <>
      {/* ── 만든 것을 둘 자리 ───────────────────────────────────────────── */}
      <div style={panel}>
        <div style={{ ...row }}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>만든 것을 둘 자리</span>
          <span data-testid="options-place-notice" style={muted}>{outputRootNotice(place, `${effectiveRoot}/AudioForge_output`)}</span>
        </div>

        <div style={row}>
          <span data-testid="options-root" title={effectiveRoot} style={pathBox}>{effectiveRoot || '(아직 모름)'}</span>
          <button type="button" data-testid="options-pick-root" style={button}
            title="새로 만드는 결과물이 쌓일 폴더를 고릅니다. 이미 만든 것은 있던 자리에 그대로 둡니다."
            disabled={place === 'beside'} onClick={() => void pickFolder()}>폴더 고르기</button>
          {chosen && <button type="button" data-testid="options-clear-root" style={button}
            title="고른 자리를 지우고 앱 자리로 되돌립니다"
            disabled={place === 'beside'} onClick={() => void save({ chosenRoot: '' })}>앱 자리로</button>}
        </div>

        <label style={{ ...row, gap: 8, cursor: 'pointer', fontSize: 12 }}
          title="켜면 예전 방식대로 원본 파일이 있는 폴더 옆에 만듭니다. 기본 목소리처럼 원본이 없으면 앱 자리에 만듭니다.">
          <input type="checkbox" data-testid="options-beside" checked={place === 'beside'}
            onChange={(e) => void save({ beside: e.target.checked })}/>
          <span>참조 목소리 원본 파일 옆에 만들기</span>
        </label>
      </div>

      {/* ── 앱이 쓰는 임시 자리 ─────────────────────────────────────────────
          ★고르는 자리가 아니라 **보여 주는 자리**다 (2026-09-28).
            예전에는 시스템 드라이브에 쌓였고 사용자는 그것을 볼 길이 없었다.
            여기 적어 두면 잘못된 자리로 새는 것이 한눈에 보인다. */}
      <div style={panel}>
        <div style={row}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>앱이 쓰는 임시 자리</span>
          <span data-testid="options-temp-inside" style={muted}>
            {tempDir ? (tempDir.startsWith(appRoot) && appRoot ? '앱 안' : '앱 밖') : ''}
          </span>
        </div>
        <span data-testid="options-temp" title={tempDir} style={pathBox}>{tempDir || '(아직 모름)'}</span>
        <span style={{ ...muted, fontSize: 11 }}>
          만드는 중에만 쓰는 자리입니다. 작업이 끝나면 스스로 지웁니다.
        </span>
      </div>

      <div style={panel}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>쌓인 것 비우기</span>
        {stray > 0 && (
          <span data-testid="options-stray-temp" style={{ ...muted, fontSize: 11 }}>
            자리를 옮기기 전에 시스템 폴더에 쌓인 것이 {stray}개 남아 있습니다 —
            중간 산출물을 비울 때 함께 치웁니다.
          </span>
        )}
        {(Object.keys(WIPE) as WipeKind[]).map((kind) => (
          <div key={kind} style={{ ...row }}>
            <span style={{ flex: '1 1 200px', fontSize: 12 }} title={`${WIPE[kind].what} ${WIPE[kind].keeps}`}>
              {WIPE[kind].label}
            </span>
            <button type="button" data-testid={`options-wipe-${kind}`} style={button}
              disabled={busy} onClick={() => setAsk(kind)}>비우기</button>
          </div>
        ))}
        {ask && (
          <div data-testid="options-wipe-ask" role="alert" style={{
            ...row, gap: 8, fontSize: 12, color: 'var(--rose)', background: 'var(--bg-base)',
            border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '10px 12px',
          }}>
            <span style={{ flex: '1 1 220px' }}>{WIPE[ask].what} {WIPE[ask].keeps}</span>
            <button type="button" data-testid="options-wipe-cancel" style={button}
              disabled={busy} onClick={() => setAsk(null)}>그대로 두기</button>
            <button type="button" data-testid="options-wipe-yes" style={{ ...button, color: 'var(--rose)' }}
              disabled={busy} onClick={() => void wipe(ask)}>{busy ? '비우는 중…' : '비우기'}</button>
          </div>
        )}
      </div>

      </>}

      {/* ── 기능 검사 ─────────────────────────────────────────────────────
          ★기능별로 눌러 **그 기능만** 확인한다. 전체를 한 번에 돌리는 단추는 두지 않는다(지시).
          ★통과는 초록, 문제는 붉은 아이콘. 결과는 동작 기록에도 남는다. */}
      {tab === 'checks' && <>
      <div style={panel} data-testid="options-checks">
        <div style={row}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>기능 검사</span>
          <span style={muted}>안 되는 기능만 눌러 보세요</span>
        </div>
        {CHECKS.map((c) => {
          const res = checks[c.id]
          const busy = runningIds.includes(c.id)
          const state = busy ? 'running' : res ? (res.ok ? 'ok' : 'fail') : 'idle'
          const dot = state === 'ok' ? '#4ade80' : state === 'fail' ? 'var(--rose, #fb7185)' : state === 'running' ? 'var(--accent-light)' : 'transparent'
          return <div key={c.id} data-testid={`check-${c.id}`} data-state={state}
            style={{ ...row, gap: 12, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
            <span aria-label={state === 'ok' ? '통과' : state === 'fail' ? '문제 있음' : state === 'running' ? '검사 중' : '아직 안 함'}
              style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                background: dot, border: state === 'idle' ? '1.5px solid var(--border-subtle)' : 'none',
                color: '#0b0c10', fontSize: 12, fontWeight: 700 }}>{state === 'ok' ? '✓' : state === 'fail' ? '✕' : state === 'running' ? '…' : ''}</span>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>{c.label}{c.slow && <span style={muted}> · {c.slow}</span>}</div>
              <div data-testid={`check-note-${c.id}`} style={{ ...muted, color: state === 'fail' ? 'var(--rose, #fb7185)' : 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                {busy ? '검사 중입니다…' : res ? `${res.reason} · ${(res.ms / 1000).toFixed(1)}초 · ${new Date(res.at).toLocaleTimeString()}` : c.what}
              </div>
            </div>
            <button type="button" data-testid={`check-run-${c.id}`} style={button} disabled={busy}
              onClick={() => { void runCheck(c.id) }}>{busy ? '검사 중…' : res ? '다시 검사' : '검사'}</button>
          </div>
        })}
      </div>

      {/* ── 문제 보고 ─ 검사 결과 + 동작 기록 복사 · 콘솔 · 진단 묶음(보조) ── */}
      <div style={panel} data-testid="options-trouble">
        <div style={row}>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>문제 보고</span>
        </div>
        <div style={row}>
          <button type="button" data-testid="check-report-copy" style={{ ...button, color: 'var(--accent-light)' }}
            onClick={() => { void copyReport() }}>문제 보고용 복사</button>
          <span data-testid="check-report-note" style={muted}>{reportNote || '검사 결과와 최근 동작 기록을 한 번에 복사합니다 — 이것만 붙여 주시면 됩니다'}</span>
        </div>
        <label style={{ ...row, gap: 8, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" data-testid="options-console" checked={consoleOpen}
            onChange={(e) => { void toggleConsole(e.target.checked) }} />
          <span>콘솔 켜기 — 앱 밖에 콘솔 창이 따로 뜹니다. 작업 화면은 그대로이고, 다른 모니터에 둘 수 있습니다</span>
        </label>
        <span style={muted}>켜지 않아도 기록은 남습니다. 글 내용과 폴더 경로는 적지 않습니다.</span>
        <div style={row}>
          <button type="button" data-testid="export-diagnostics" style={button}
            onClick={() => { void exportDiagnostics() }} disabled={diag.busy}
            title="여러 날 치 로그·검사 결과·설정의 모양(값 없음)을 폴더 하나로 묶어 저장합니다. 대사·음원은 들어가지 않습니다.">
            {diag.busy ? '진단 묶음 만드는 중…' : '진단 묶음 내보내기'}
          </button>
          {diag.text ? <span data-testid="export-diagnostics-result" role="status" style={muted}>{diag.text}</span>
            : <span style={muted}>며칠 전 일을 볼 때 — 날짜별 로그를 폴더로 묶습니다</span>}
        </div>
      </div>
      </>}
    </section>
    </dialog>
  )
}
