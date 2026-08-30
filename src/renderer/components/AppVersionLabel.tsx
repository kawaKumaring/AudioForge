import { useEffect, useState } from 'react'
import {
  buildDetailLines, buildDetailText, versionLabel, type AppBuildInfo,
} from '../../shared/buildMetadata'

/**
 * 시작 화면 중앙 축의 맨 아래 한 줄. `이전 결과 폴더 열기` 버튼 **아래**에 있고
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
      {open && lines.length > 1 && (
        <div
          role="tooltip"
          data-testid="app-version-tooltip"
          style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            bottom: 'calc(100% + 6px)', zIndex: 5, pointerEvents: 'none',
            padding: '6px 10px', borderRadius: 8, whiteSpace: 'pre',
            fontSize: 11, lineHeight: 1.5, textAlign: 'left',
            color: 'var(--text-muted)', background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            maxWidth: 'min(280px, 90vw)'
          }}
        >
          {lines.join('\n')}
        </div>
      )}
    </div>
  )
}
