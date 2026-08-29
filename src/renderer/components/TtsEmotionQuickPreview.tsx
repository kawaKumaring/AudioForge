// 감정 미리듣기(기본 화면용) — 기쁨·화남·슬픔 셋만 짧게 들어보는 자리.
//
// 규칙:
//  · props-only. store/IPC 없음 — 생성·재생은 전부 셸(TTSEditor) 콜백.
//  · **자동으로 만들지 않는다.** 사용자가 '미리듣기 3개 만들기'를 눌러야 시작한다
//    (GPU 작업을 화면 진입만으로 시작하지 않는다).
//  · 만드는 순서는 **직렬** — 셸이 하나씩 끝내고 다음으로 간다. 여기서는 지금 만드는 것을 보여 줄 뿐이다.
//  · 만들어진 것은 캐시로 남아, 다음에는 재생 버튼으로 바로 들을 수 있다.
//  · 미지원·미검증 표현과 엔진 capability 상태는 여기 늘어놓지 않는다 — 그건 고급 설정 > 표현의
//    전체 목록(EmotionSamplerPanel)이 그대로 갖고 있다.
//  · 고정 폭 금지 + flexWrap(좁은 창·고배율 대비). 레이아웃은 inline style.
import type { CSSProperties } from 'react'

export interface EmotionQuickRow {
  rowId: string
  label: string
  /** 이 감정의 샘플이 이미 만들어져 바로 들을 수 있는가. */
  ready: boolean
}

export interface TtsEmotionQuickPreviewProps {
  rows: readonly EmotionQuickRow[]
  /** 목소리가 준비돼 만들기를 시작할 수 있는가. */
  enabled: boolean
  /** 목소리를 미리듣기에 쓸 수 있게 준비하는 중(저장·확인). */
  preparing: boolean
  /** 지금 만들고 있는 감정. 없으면 null. */
  busyRowId: string | null
  /** 마지막 시도의 안내 문장(실패 사유 등). 경로·전사는 담기지 않는다. */
  notice: string | null
  /** 목소리가 아직 준비되지 않았을 때 보여 줄 한 줄. */
  disabledNotice?: string | null
  onGenerate: () => void
  onPlay: (rowId: string) => void
}

export default function TtsEmotionQuickPreview({
  rows, enabled, preparing, busyRowId, notice, disabledNotice = null, onGenerate, onPlay,
}: TtsEmotionQuickPreviewProps) {
  const readyCount = rows.filter((r) => r.ready).length
  const running = preparing || busyRowId !== null
  const allReady = rows.length > 0 && readyCount === rows.length
  const busyLabel = preparing
    ? '목소리 준비 중…'
    : busyRowId
      ? `${rows.find((r) => r.rowId === busyRowId)?.label ?? ''} 만드는 중… (${readyCount + 1}/${rows.length})`
      : ''

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
      borderTop: '1px solid var(--border-subtle)', paddingTop: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>감정 미리듣기</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 140 }}>
          {running ? busyLabel
            : allReady ? '아래 버튼으로 들어보세요'
              : readyCount > 0 ? `${readyCount}개 만들어짐`
                : '기쁨 · 화남 · 슬픔을 짧은 대사로 만들어 들어봅니다'}
        </span>
        <button
          type="button"
          onClick={onGenerate}
          disabled={!enabled || running}
          aria-label={allReady ? '감정 미리듣기 다시 만들기' : '감정 미리듣기 3개 만들기'}
          style={btn(
            allReady ? 'var(--bg-elevated)' : 'var(--rose)',
            allReady ? 'var(--text-secondary)' : '#fff',
            !enabled || running,
          )}
        >{running ? '만드는 중…' : allReady ? '다시 만들기' : '미리듣기 3개 만들기'}</button>
      </div>

      <div role="group" aria-label="감정 미리듣기 재생" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        {rows.map((r) => {
          const isBusy = busyRowId === r.rowId
          return (
            <button
              key={r.rowId}
              type="button"
              onClick={() => onPlay(r.rowId)}
              disabled={!r.ready || running}
              aria-label={`${r.label} 미리듣기 재생`}
              style={btn('var(--bg-elevated)', r.ready ? 'var(--cyan)' : 'var(--text-muted)', !r.ready || running)}
            >{isBusy ? `${r.label} 만드는 중…` : `▶ ${r.label}`}</button>
          )
        })}
      </div>

      {!enabled && disabledNotice && (
        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, overflowWrap: 'anywhere' }}>{disabledNotice}</p>
      )}
      {notice && (
        <p role="status" style={{ fontSize: 11, color: 'var(--rose)', margin: 0, overflowWrap: 'anywhere' }}>{notice}</p>
      )}
    </div>
  )
}

function btn(bg: string, color: string, isDisabled = false): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, padding: '5px 12px', borderRadius: 6, border: 'none',
    cursor: isDisabled ? 'not-allowed' : 'pointer', background: bg, color, fontFamily: 'inherit',
    opacity: isDisabled ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}
