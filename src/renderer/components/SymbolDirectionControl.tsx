import { DIRECTION_SYMBOLS, cardSymbolReading, symbolDisabled, type DirectionSettings } from '../../shared/symbolDirection'
import type { CardVoice } from '../../shared/synthesisCardVoice'
import { row, muted, button } from './kit'

export default function SymbolDirectionControl({ text, settings, voice, disabled, change }: {
  text: string; settings: DirectionSettings; voice: CardVoice; disabled: boolean
  change: (patch: Partial<DirectionSettings>) => void
}) {
  const reading = cardSymbolReading(text, settings, voice)
  const excluded = symbolDisabled(settings.symbolDisabled)
  return <div data-testid="symbol-direction" style={{ marginTop: 8, fontSize: 12 }}>
    <label style={{ ...row, gap: 7, width: 'fit-content', cursor: disabled ? 'default' : 'pointer' }}>
      <input type="checkbox" checked={!!settings.symbolDirection} disabled={disabled}
        onChange={e => change({ symbolDirection: e.target.checked })}/>
      기호 연출 <span style={muted}>원문 유지</span>
    </label>
    {settings.symbolDirection && <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--bg-base)', borderRadius: 9, border: '1px solid var(--border-subtle)' }}>
      <div style={{ ...row, flexWrap: 'wrap', gap: 5 }}>
        {DIRECTION_SYMBOLS.map(symbol => <button key={symbol} type="button" aria-label={`${symbol} 기호 연출`} aria-pressed={!excluded.includes(symbol)} disabled={disabled}
          title="이 기호만 끄면 원문 기호를 그대로 보냅니다"
          onClick={() => change({ symbolDisabled: excluded.includes(symbol) ? excluded.filter(s => s !== symbol) : [...excluded, symbol] })}
          style={{ ...button, minWidth: 32, minHeight: 30, padding: '3px 9px', color: excluded.includes(symbol) ? 'var(--text-muted)' : 'var(--accent-light)' }}>{symbol}</button>)}
      </div>
      <details open style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer' }}>어떻게 읽나요 · {reading.entries.length}곳</summary>
        <div style={{ maxHeight: 170, overflowY: 'auto', marginTop: 6 }}>
          {reading.entries.map((e,i) => <div key={i} style={{ padding: '5px 0', overflowWrap: 'anywhere' }}>
            <span style={{ color: 'var(--text-secondary)' }}>“{text.slice(Math.max(0,e.start-12),Math.min(text.length,e.end+8))}”</span>
            <div style={muted}>{e.label}</div>
          </div>)}
          {!reading.entries.length && <span style={muted}>해석할 기호가 없습니다.</span>}
        </div>
      </details>
      <details style={{ marginTop: 7 }}><summary style={{ cursor: 'pointer' }}>생성에 보낼 대사와 지시</summary>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflowY: 'auto', marginTop: 7 }}>{reading.script}</div>
        <p style={muted}>[쉼]·[감정]은 읽을 글이 아닌 지시입니다. 쉼은 추가 시간이며, 말투 요청의 표현 정도는 생성 후 들어 확인하세요.</p>
      </details>
    </div>}
  </div>
}
