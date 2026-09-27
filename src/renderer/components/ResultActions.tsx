// 결과 도구 줄 — **폴더 열기·내보내기·알림을 화면마다 다르게 만들지 않는다.**
//
// 음악·대화가 같은 모양과 같은 실패 문구를 쓴다. 저장 경로도 하나다
// (`audio.exportTracks` — 원본·결과 위에는 쓰지 않고, 같은 이름이 있으면 덮지 않는다).
//
// ★여기서 하는 일은 **화면에 내는 것**뿐이다. 무엇을 내보낼지는 부르는 쪽이 정한다.
import { useCallback, useState } from 'react'

export interface ExportOutcome {
  text: string
  bad: boolean
}

/**
 * 고른 결과를 내보낸다. 결과 문구를 같은 말로 돌려준다.
 *
 * `null` 이면 사용자가 폴더 고르기를 취소한 것이다 — 알림을 내지 않는다.
 */
export async function exportResults(paths: string[], what: string): Promise<ExportOutcome | null> {
  if (!paths.length) return { text: '내보낼 결과를 고르지 않았습니다.', bad: true }
  try {
    const r = await window.api.audio.exportTracks(paths)
    if (!r) return null
    if (r.ok) return { text: `${what} ${r.copied.length}개를 내보냈습니다.`, bad: false }
    // ★성공과 실패가 화면상 같아 보이지 않게 한다 — 무엇이 왜 안 됐는지 적는다.
    const why = r.failed.map((f) => `${f.name}(${f.why})`).join(', ')
    return {
      text: `${what} ${r.copied.length}개를 내보냈고 ${r.failed.length}개가 실패했습니다 — ${why}`,
      bad: true,
    }
  } catch (e) {
    return { text: `내보내지 못했습니다: ${(e as Error)?.message || e}`, bad: true }
  }
}

export function useResultExport() {
  const [note, setNote] = useState<ExportOutcome | null>(null)
  const run = useCallback(async (paths: string[], what: string) => {
    setNote(null)
    const got = await exportResults(paths, what)
    if (got) setNote(got)
  }, [])
  return { note, setNote, run }
}

const ghost: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border-subtle)',
  background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
}

/**
 * 폴더 열기 + 내보내기 한 줄.
 *
 * `what` 은 **무엇을 내보내는지** 사람이 읽을 말이다('분리 결과', '교정본' …).
 * 그 말이 단추에도 알림에도 그대로 들어간다 — 무엇이 나갔는지 헷갈리지 않게.
 */
export function ResultToolbar({ what, paths, outputDir, disabled, children, note, onExport }: {
  what: string
  paths: string[]
  outputDir?: string | null
  disabled?: boolean
  /** 화면별로 다른 조작(대상 고르기 등)을 왼쪽에 끼워 넣는다. */
  children?: React.ReactNode
  note?: ExportOutcome | null
  onExport: (paths: string[], what: string) => void
}) {
  const off = !!disabled || paths.length === 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {children}
      {outputDir && (
        <button type="button" data-testid="result-open-folder"
          onClick={() => window.api.app.openFolder(outputDir)}
          title="결과가 저장된 폴더를 엽니다" style={ghost}>폴더</button>
      )}
      <button type="button" data-testid="result-export" disabled={off}
        onClick={() => onExport(paths, what)}
        title={off ? '내보낼 결과를 고르세요'
          : '고른 폴더로 복사합니다. 원본이나 결과 파일 위에는 저장하지 않고, 같은 이름이 있으면 덮지 않습니다.'}
        style={{
          ...ghost,
          border: 'none', background: off ? 'var(--bg-elevated)' : 'var(--accent-glow)',
          color: off ? 'var(--text-muted)' : 'var(--accent-light)',
          cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.6 : 1,
        }}>
        {what} 내보내기{paths.length ? ` (${paths.length})` : ''}
      </button>
      {note && (
        <span data-testid="result-export-note" role="status" style={{
          fontSize: 10, color: note.bad ? 'var(--amber, #d98b2b)' : 'var(--text-muted)',
        }}>{note.text}</span>
      )}
    </div>
  )
}
