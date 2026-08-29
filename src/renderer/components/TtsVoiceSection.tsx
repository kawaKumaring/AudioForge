// [1] 목소리 섹션 (C 소유). 4-flow 정보구조의 첫 흐름 — 화자 정체성(기본 참조/전사/구간/감정 참조 관리)의
// 컨테이너 + 전역 '설정 설명 표시' 스위치. 실제 참조 패널/감정 관리자는 셸(I5, 통합 담당)이 children으로 주입한다.
// ⚠️ 이 파일은 TTSEditor 셸에 스스로 연결하지 않는다(셸 조립은 I5). 여기선 패널만 만든다.
// props 계약: src/renderer/types/ttsExpression.ts TtsVoiceSectionProps (children은 셸 주입용 로컬 확장).
import type { ReactNode, CSSProperties } from 'react'
import type { TtsVoiceSectionProps } from '../types/ttsExpression'

// 계약(ttsExpression.ts)을 수정하지 않고 셸 주입 슬롯을 로컬로 확장(A의 EmotionScriptEditorLocalProps 선례와 동일 패턴).
export interface TtsVoiceSectionLocalProps extends TtsVoiceSectionProps {
  /** 셸이 주입하는 기본 참조 패널(ReferenceRegionPanel 등). */
  children?: ReactNode
  /** 셸이 주입하는 감정 참조 관리자(EmotionReferenceManager). */
  emotionManager?: ReactNode
  /**
   * 헤더의 '설정 설명 표시' 스위치를 이 자리에 그릴지(PHASE B). 기본 화면에서는 고급 설정 헤더로
   * 옮겼기 때문에 false 로 온다. 계약(onToggleSettingHelp)은 그대로 살아 있다.
   */
  showHelpToggle?: boolean
  /** 헤더 상태줄을 셸이 직접 그릴 때(기본 화면). 미지정이면 기존 referenceReady/Message 문구. */
  statusSlot?: ReactNode
}

const card: CSSProperties = {
  borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden',
}

export default function TtsVoiceSection({
  referenceReady,
  referenceMessage,
  showSettingHelp,
  onToggleSettingHelp,
  children,
  emotionManager,
  showHelpToggle = true,
  statusSlot,
}: TtsVoiceSectionLocalProps) {
  const statusText = referenceReady
    ? '참조 음성 준비됨'
    : (referenceMessage || '참조 음성을 준비하세요')

  return (
    <section className="tts-flow-card" aria-label="목소리" style={card}>
      <header className="tts-flow-head" style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)',
      }}>
        <span aria-hidden="true" className="tts-flow-num" style={flowNum}>1</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>목소리</span>
        {statusSlot ?? (
          <span
            role="status"
            aria-live="polite"
            style={{ fontSize: 11, color: referenceReady ? 'var(--cyan)' : 'var(--text-muted)', flex: 1, minWidth: 120 }}
          >
            {statusText}
          </span>
        )}
        {/* 전역 '설정 설명 표시' — 모든 ⓘ 한 문장 설명을 기본 펼침(입문자)/접힘(숙련자)으로 전환.
            PHASE B: 기본 화면에서는 고급 설정 헤더로 옮겨 여기서는 그리지 않는다(스위치 자체는 그대로). */}
        {showHelpToggle && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={showSettingHelp}
              onChange={(e) => onToggleSettingHelp(e.target.checked)}
            />
            설정 설명 표시
          </label>
        )}
      </header>

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 기본 참조 음성 패널(셸 주입). 미주입 시 안내만. */}
        {children ?? (
          <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            기본 참조 음성 패널은 셸 조립(I5) 후 이 위치에 표시됩니다.
          </p>
        )}
        {/* 감정 참조 관리자(셸 주입). */}
        {emotionManager}
      </div>
    </section>
  )
}

const flowNum: CSSProperties = {
  width: 22, height: 22, borderRadius: 6, background: 'var(--bg-elevated)',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11, fontWeight: 700, color: 'var(--accent)', flexShrink: 0,
}
