import { Component, type ErrorInfo, type ReactNode } from 'react'

// renderer 예외로 React 트리가 통째로 언마운트되어 '검은 화면'이 되는 것을 막는다.
// 원인을 숨기지 않고 오류 메시지·스택을 그대로 보여주고, 복구(다시 시도) 버튼을 제공한다.
// 콘솔에도 error로 남겨 main의 console-message / E2E pageerror가 수집하게 한다.

interface State { error: Error | null; info: string }

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 원인 노출(숨기지 않음) — main/E2E가 수집
    console.error('[renderer][ErrorBoundary]', error?.stack || error, info?.componentStack)
    this.setState({ info: info?.componentStack || '' })
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children
    return (
      <div style={{
        position: 'fixed', inset: 0, overflow: 'auto', zIndex: 99999,
        background: 'var(--bg-base, #0a0a0f)', color: 'var(--text-primary, #e8e8ef)',
        fontFamily: "'Inter', sans-serif", padding: '48px 32px', WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h2 style={{ color: '#f87171', fontSize: 18, marginBottom: 8 }}>화면 오류가 발생했습니다</h2>
          <p style={{ fontSize: 13, color: '#a0a0b0', marginBottom: 16 }}>
            아래 원인을 확인하세요. 이 화면은 검은 화면 대신 오류를 표시하기 위한 것으로, 원인을 숨기지 않습니다.
          </p>
          <pre style={{
            fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
            borderRadius: 8, padding: '12px 14px', color: '#fca5a5',
          }}>{String(error?.stack || error?.message || error)}</pre>
          {info && (
            <pre style={{
              fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: 'var(--bg-card, #14141b)', border: '1px solid var(--border-subtle, #26262f)',
              borderRadius: 8, padding: '12px 14px', color: '#8a8a99', marginTop: 10,
            }}>{info}</pre>
          )}
          <button onClick={() => this.setState({ error: null, info: '' })} style={{
            marginTop: 16, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600, background: '#7c3aed', color: '#fff',
          }}>다시 시도</button>
        </div>
      </div>
    )
  }
}
