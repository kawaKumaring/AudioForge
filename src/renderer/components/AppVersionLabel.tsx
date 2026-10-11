import { useEffect, useState } from 'react'
import { exportDiagnosticsText } from '../../shared/diagnostics'
import {
  buildDetailLines, buildDetailText, versionLabel, type AppBuildInfo,
} from '../../shared/buildMetadata'

/**
 * 작업 메뉴 하단의 버전 표시. `이전 결과 폴더 열기` 버튼 아래에 있고
 * 상단 로고 옆에는 두지 않는다.
 *
 * 강조하지 않는다 — 배경·테두리·pill·badge 없이 보조 설명보다 한 단계 어두운 회색이다.
 * `AudioForge` 를 반복하지 않고 `v` + 실행 중 version 만 보인다. 상세(커밋·날짜·채널)는
 * hover 와 **keyboard focus** 양쪽에서 열리고, 같은 문자열이 `aria-label` 로도 붙어
 * 마우스 없이 스크린리더로도 읽힌다.
 */
export default function AppVersionLabel() {
  const [info, setInfo] = useState<AppBuildInfo | null>(null)
  const [open, setOpen] = useState(false)
  // 진단 묶음 내보내기 — 결과는 한 줄 글로만 말한다. 경로는 화면에 오지 않는다(폴더 이름만).
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
    let alive = true
    // 버전 문자열을 renderer 에 하드코딩하지 않는다 — main 의 app.getVersion() 이 권위다.
    window.api.app
      .getBuildInfo()
      .then((v) => {
        if (alive) setInfo(v)
      })
      .catch(() => {
        // metadata 를 못 읽어도 화면이 깨지지 않는다. 아무것도 표시하지 않을 뿐이다.
      })
    return () => {
      alive = false
    }
  }, [])

  if (!info) return null

  const lines = buildDetailLines(info)
  const description = buildDetailText(info)

  return (
    <div style={{ position: 'relative', marginTop: 14, textAlign: 'center' }}>
      <span
        tabIndex={0}
        role="note"
        aria-label={description}
        title={description}
        data-testid="app-version"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        style={{
          display: 'inline-block', maxWidth: '100%',
          fontSize: 11, lineHeight: 1.4, letterSpacing: '0.02em',
          color: 'var(--text-faint, var(--text-muted))', opacity: 0.75,
          cursor: 'default', outlineOffset: 3, verticalAlign: 'top',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}
      >
        {versionLabel(info)}
      </span>
      {/* 진단 묶음 — 문제가 났을 때 화면 캡처 대신 건네는 폴더(로그 복사본 + 설정의 모양, 값 없음) */}
      <div style={{ marginTop: 6 }}>
        <button
          type="button"
          data-testid="export-diagnostics"
          onClick={exportDiagnostics}
          disabled={diag.busy}
          title="최근 로그와 설정의 모양(값 없음)을 폴더 하나로 묶어 저장합니다. 대사·음원은 들어가지 않습니다."
          style={{
            background: 'transparent', border: 'none', padding: '2px 6px', cursor: diag.busy ? 'default' : 'pointer',
            fontFamily: 'inherit', fontSize: 11, color: 'var(--text-faint, var(--text-muted))', opacity: 0.75,
            textDecoration: 'underline', textUnderlineOffset: 3,
          }}
        >
          {diag.busy ? '진단 묶음 만드는 중…' : '진단 묶음 내보내기'}
        </button>
        {diag.text && (
          <div data-testid="export-diagnostics-result" role="status"
            style={{ marginTop: 4, fontSize: 11, lineHeight: 1.4, color: 'var(--text-muted)' }}>
            {diag.text}
          </div>
        )}
      </div>
      {open && lines.length > 1 && (
        <div
          role="tooltip"
          data-testid="app-version-tooltip"
          style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            bottom: 'calc(100% + 6px)', zIndex: 5, pointerEvents: 'none',
            padding: '6px 10px', borderRadius: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            fontSize: 11, lineHeight: 1.5, textAlign: 'left',
            color: 'var(--text-muted)', background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            width: 160, maxWidth: '90vw'
          }}
        >
          {lines.join('\n')}
        </div>
      )}
    </div>
  )
}
