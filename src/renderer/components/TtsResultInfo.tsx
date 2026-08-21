import type { CSSProperties } from 'react'
import { useAppStore } from '@/stores/app.store'

// 합성 완료 화면의 재현 정보 — 실제 엔진/장치/참조 방식/구간/속도 후처리/폴백/소요 시간.
// 값의 최종 권위는 metadata(actual_engine/device) — preflight 예상이 아니라 실행 결과.

const ENGINE_LABEL: Record<string, string> = {
  qwen3: 'Qwen3', gptsovits: 'GPT-SoVITS', f5tts: 'F5-TTS', kokoro: 'Kokoro',
}
const PROMPT_LABEL: Record<string, string> = {
  manual: '직접 입력', auto: '자동 전사', 'x-vector-only': '화자 특성만(전사문 없이)',
}
const LANG_LABEL: Record<string, string> = { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' }

function engineName(v: unknown): string {
  const s = String(v ?? '')
  if (!s) return '알 수 없음'
  return s.split(',').map(e => ENGINE_LABEL[e] || e).join(' + ')
}

export default function TtsResultInfo() {
  const { mode, status, resultMetadata: m } = useAppStore()
  if (mode !== 'tts' || status !== 'done' || !m) return null

  const requested = String(m.requested_engine ?? 'auto')
  const actual = String(m.actual_engine ?? '')
  const device = m.device ? String(m.device).toUpperCase().replace('CUDA:0', 'GPU (CUDA)') : null
  const promptMode = PROMPT_LABEL[String(m.prompt_source ?? '')] || (m.prompt_source ? String(m.prompt_source) : null)
  const region = m.reference_region as { start?: number; duration?: number } | null
  const speedPost = m.speed_postprocessed === true
  const fallback = m.fallback === true
  const elapsed = typeof m.elapsed_seconds === 'number' ? m.elapsed_seconds : null
  const sr = typeof m.output_sample_rate === 'number' ? m.output_sample_rate : null
  const tgt = LANG_LABEL[String(m.target_language ?? '')] || null

  // requested 'auto'가 아니고 requested≠actual이면 명확한 폴백/전환 표시
  const requestedIsAuto = requested === 'auto'
  const engineMismatch = !requestedIsAuto && actual && requested !== actual
  const headline = fallback
    ? (requested === 'qwen3' ? 'Qwen3 사용 불가 → GPT-SoVITS로 폴백' : `폴백 발생: ${engineName(actual)} 사용`)
    : requestedIsAuto
      ? `자동 요청 → ${engineName(actual)} 사용`
      : `${engineName(requested)} 요청 → ${engineName(actual)} 사용`

  const card: CSSProperties = {
    borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8,
  }
  const rowWrap: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
  const chip = (accent?: string): CSSProperties => ({
    fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-elevated)',
    borderRadius: 6, padding: '4px 9px', borderLeft: `2px solid ${accent || 'var(--border-subtle)'}`,
  })

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>합성 정보</span>
        {(fallback || engineMismatch) && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: '#fff', background: 'var(--rose)',
            borderRadius: 6, padding: '2px 8px',
          }}>{headline}</span>
        )}
        {!fallback && !engineMismatch && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{headline}</span>
        )}
      </div>
      <div style={rowWrap}>
        <span style={chip('var(--rose)')}>실제 엔진: <strong style={{ color: 'var(--text-primary)' }}>{engineName(actual)}</strong></span>
        {device && <span style={chip('var(--cyan)')}>장치: <strong style={{ color: 'var(--text-primary)' }}>{device}</strong></span>}
        {promptMode && <span style={chip()}>참조 방식: {promptMode}</span>}
        {region && typeof region.start === 'number' && typeof region.duration === 'number' && (
          <span style={chip()}>참조 구간: {region.start.toFixed(1)}~{(region.start + region.duration).toFixed(1)}초 ({region.duration.toFixed(1)}초)</span>
        )}
        {tgt && <span style={chip()}>언어: {tgt}</span>}
        <span style={chip()}>속도 후처리: {speedPost ? '적용됨' : '없음'}</span>
        {sr && <span style={chip()}>{(sr / 1000).toFixed(0)}kHz</span>}
        {elapsed != null && <span style={chip()}>소요: {elapsed < 60 ? `${elapsed.toFixed(1)}초` : `${(elapsed / 60).toFixed(1)}분`}</span>}
      </div>
      {fallback && Boolean(m.fallback_reason) && (
        <div style={{ fontSize: 11, color: 'var(--rose)' }}>⚠ 폴백 사유: {String(m.fallback_reason)}</div>
      )}
    </div>
  )
}
