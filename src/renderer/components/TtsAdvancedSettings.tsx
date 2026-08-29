// 고급 설정 — 흩어져 있던 표현/세부 표현/엔진 설정을 한 곳으로 모은 컨테이너(PHASE B).
//
// 규칙:
//  · props-only. store import 없음, IPC 없음. 내용은 전부 셸(TTSEditor)이 children 으로 주입한다.
//    (숨기는 것이지 없애는 것이 아니다 — 주입된 패널들은 예전과 똑같은 컴포넌트·계약이다.)
//  · 열림/탭은 셸이 소유한다(controlled). 오류 카드의 '참조 전사 확인' 같은 외부 요청이
//    특정 탭을 열 수 있어야 하기 때문이다.
//  · 기본은 접힘. 접혀 있을 때 보이는 것은 제목 한 줄뿐이다.
//  · 고정 폭 금지 + flexWrap — 좁은 창·고배율에서 가로로 넘치지 않아야 한다.
//  · 레이아웃은 inline style(Electron + Tailwind v4 레이아웃 유틸리티 미동작).
import type { CSSProperties, ReactNode } from 'react'

export const TTS_ADVANCED_TABS = ['voice', 'expression', 'output', 'engine'] as const
export type TtsAdvancedTab = typeof TTS_ADVANCED_TABS[number]

const TAB_LABEL: Record<TtsAdvancedTab, string> = {
  voice: '음성',
  expression: '표현',
  output: '출력',
  engine: '엔진·진단',
}

export interface TtsAdvancedSettingsProps {
  open: boolean
  onToggle: (open: boolean) => void
  tab: TtsAdvancedTab
  onTab: (tab: TtsAdvancedTab) => void
  /** 접혀 있을 때 함께 보이는 한 줄 요약(예: 현재 엔진). 없으면 표시하지 않는다. */
  summary?: string
  /** 전역 '설정 설명 표시' 스위치 — 기본 화면에서 이리로 옮겨 왔다. */
  showSettingHelp: boolean
  onToggleSettingHelp: (v: boolean) => void
  voice: ReactNode
  expression: ReactNode
  output: ReactNode
  engine: ReactNode
}

const BODY_ID = 'tts-advanced-body'

export default function TtsAdvancedSettings({
  open, onToggle, tab, onTab, summary, showSettingHelp, onToggleSettingHelp,
  voice, expression, output, engine,
}: TtsAdvancedSettingsProps) {
  const panel: Record<TtsAdvancedTab, ReactNode> = { voice, expression, output, engine }

  return (
    <section id="tts-advanced-settings" aria-label="고급 설정" style={card}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px', minWidth: 0,
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>고급 설정</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 120 }}>
          {summary || '평소에는 건드리지 않아도 됩니다'}
        </span>
        <button
          type="button"
          onClick={() => onToggle(!open)}
          aria-expanded={open}
          aria-controls={BODY_ID}
          style={btn(open ? 'var(--bg-elevated)' : 'var(--bg-elevated)', 'var(--text-secondary)')}
        >{open ? '닫기' : '열기'}</button>
      </div>

      {open && (
        <div id={BODY_ID} style={{ borderTop: '1px solid var(--border-subtle)', minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', minWidth: 0,
          }}>
            <div role="tablist" aria-label="고급 설정 항목" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
              {TTS_ADVANCED_TABS.map((t) => {
                const active = t === tab
                return (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`tts-advanced-tab-${t}`}
                    aria-selected={active}
                    aria-controls={`tts-advanced-panel-${t}`}
                    onClick={() => onTab(t)}
                    style={{
                      ...btn(active ? 'var(--rose)' : 'var(--bg-elevated)', active ? '#fff' : 'var(--text-secondary)'),
                      fontSize: 12, padding: '6px 14px',
                    }}
                  >{TAB_LABEL[t]}</button>
                )
              })}
            </div>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto',
              fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              <input
                type="checkbox"
                checked={showSettingHelp}
                onChange={(e) => onToggleSettingHelp(e.target.checked)}
              />
              설정 설명 표시
            </label>
          </div>

          <div
            role="tabpanel"
            id={`tts-advanced-panel-${tab}`}
            aria-labelledby={`tts-advanced-tab-${tab}`}
            style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}
          >
            {panel[tab]}
          </div>
        </div>
      )}
    </section>
  )
}

const card: CSSProperties = {
  borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
  overflow: 'hidden', minWidth: 0,
}

function btn(bg: string, color: string, isDisabled = false): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, padding: '5px 12px', borderRadius: 6, border: 'none',
    cursor: isDisabled ? 'not-allowed' : 'pointer', background: bg, color, fontFamily: 'inherit',
    opacity: isDisabled ? 0.5 : 1, whiteSpace: 'nowrap',
  }
}
