import { useEffect, useState, type CSSProperties } from 'react'
import { useAppStore } from '@/stores/app.store'
import { ALL_EMOTIONS } from '@/lib/emotions'
import { parseGenerationSummary } from '../../shared/ttsConfig'

const EMO_LABEL: Record<string, string> = Object.fromEntries(ALL_EMOTIONS.map(e => [e.id, e.label]))

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

const VERDICTS = [
  { id: 'good', label: '좋음' },
  { id: 'fair', label: '보통' },
  { id: 'bad', label: '나쁨' },
] as const

/** 이 결과가 어땠는지를 그 실행의 기록에 남긴다. 한 실행에 한 번, 다시 눌러 바꿀 수 있다. */
function ListeningVerdict({ runId }: { runId: string }) {
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  // 결과가 바뀌면(새 실행) 판정은 처음 상태로 돌아간다.
  useEffect(() => { setSaved(null); setError(null); setNote(''); setNoteOpen(false) }, [runId])
  if (!runId) return null

  const send = async (verdict: string, text: string) => {
    setBusy(true); setError(null)
    try {
      await window.api.audio.recordListening(runId, verdict, text)
      setSaved(verdict)
    } catch (e) {
      setError((e as Error)?.message || '판정을 남기지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="listening-verdict" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>이 소리 어땠나요?</span>
        {VERDICTS.map((v) => (
          <button key={v.id} type="button" data-testid={`listening-${v.id}`}
            disabled={busy}
            aria-pressed={saved === v.id}
            onClick={() => { void send(v.id, note) }}
            title="눌러 두면 이 실행의 설정과 함께 기록에 남습니다. 나중에 어떤 설정이 좋았는지 찾을 때 쓰입니다."
            style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 6, cursor: busy ? 'default' : 'pointer',
              fontFamily: 'inherit',
              border: `1px solid ${saved === v.id ? 'var(--cyan)' : 'var(--border-subtle)'}`,
              background: saved === v.id ? 'var(--cyan)' : 'transparent',
              color: saved === v.id ? '#04212a' : 'var(--text-secondary)',
            }}>{v.label}</button>
        ))}
        <button type="button" data-testid="listening-note-toggle" onClick={() => setNoteOpen((o) => !o)}
          style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: 'transparent', color: 'var(--text-muted)', fontFamily: 'inherit',
          }}>{noteOpen ? '메모 닫기' : '메모'}</button>
        {saved && !busy && !error && (
          <span style={{ fontSize: 11, color: 'var(--cyan)' }}>· 기록에 남았습니다</span>
        )}
      </div>
      {noteOpen && (
        <input type="text" data-testid="listening-note" value={note} maxLength={500}
          placeholder="무엇이 좋았는지·나빴는지 한 줄 (선택)"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if (saved) void send(saved, note) }}
          style={{
            fontSize: 11, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit',
            background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            border: '1px solid var(--border-subtle)',
          }} />
      )}
      {error && <span role="alert" style={{ fontSize: 11, color: 'var(--rose)' }}>{error}</span>}
    </div>
  )
}

export default function TtsResultInfo() {
  const { mode, status, resultMetadata: m } = useAppStore()
  if (mode !== 'tts' || status !== 'done' || !m) return null

  const gen = parseGenerationSummary(m)   // 생성 안전장치 요약(계약 A/B) — 안전 파싱, 구 session이면 null
  const requested = String(m.requested_engine ?? 'auto')
  const actual = String(m.actual_engine ?? '')
  const device = m.device ? String(m.device).toUpperCase().replace('CUDA:0', 'GPU (CUDA)') : null
  const promptMode = PROMPT_LABEL[String(m.prompt_source ?? '')] || (m.prompt_source ? String(m.prompt_source) : null)
  const region = m.reference_region as { start?: number; duration?: number } | null
  const speedPost = m.speed_postprocessed === true
  const pitchPost = m.pitch_postprocessed === true
  const pitchSt = typeof m.pitch_semitones === 'number' ? m.pitch_semitones : 0
  const pitchMethod = m.pitch_method ? String(m.pitch_method) : null
  // 감정별 참조: basename + 구간(전체 경로 아님, 추가정합1). source_names 키가 이번 합성에 실제 쓰인 감정.
  const emoNames = (m.emotion_reference_source_names as Record<string, string> | null) || null
  const emoRegions = (m.emotion_reference_regions as Record<string, { start?: number; duration?: number }> | null) || null
  const fallback = m.fallback === true
  const elapsed = typeof m.elapsed_seconds === 'number' ? m.elapsed_seconds : null
  const sr = typeof m.output_sample_rate === 'number' ? m.output_sample_rate : null
  const tgt = LANG_LABEL[String(m.target_language ?? '')] || null
  // I4 재현 필드(비민감: 수치·모드·해시8만). 구 session은 이 값들이 없어 표시하지 않는다.
  const tailMode = m.tail_mode === 'auto' || m.tail_mode === 'off' ? m.tail_mode : null
  const tailPad = typeof m.tail_pad_ms === 'number' ? m.tail_pad_ms : null
  const tailFadeApplied = m.tail_fade_applied === true
  const parserVer = typeof m.parser_version === 'number' ? m.parser_version : null
  const planSha8 = typeof m.parsed_plan_sha8 === 'string' ? m.parsed_plan_sha8 : null
  const segCount = typeof m.segment_count === 'number' ? m.segment_count : null
  const explicitPauses = typeof m.explicit_pause_count === 'number' ? m.explicit_pause_count : 0
  const emoBoundary = m.emotion_boundary_mode === 'immediate' || m.emotion_boundary_mode === 'pause'
    ? m.emotion_boundary_mode : null
  const hasExprMeta = tailMode != null || parserVer != null
  // 참조 사용 방식(자동 모드) — 사용자에게 보이는 것은 Python 이 정한 **문구 하나**뿐이다.
  // 내부 code(ICL_BOUNDARY_ALIGNMENT_FAILED 등)와 requested→effective 는 접힌 상세 진단에서만 본다.
  const rcNotice = typeof m.reference_conditioning_notice === 'string' && m.reference_conditioning_notice
    ? m.reference_conditioning_notice : null
  const rcFailureCode = typeof m.reference_conditioning_failure_code === 'string'
    ? m.reference_conditioning_failure_code : null
  const rcRequested = typeof m.reference_conditioning_mode_requested === 'string'
    ? m.reference_conditioning_mode_requested : null
  const rcEffective = typeof m.reference_conditioning_mode_effective === 'string'
    ? m.reference_conditioning_mode_effective : null
  const rcSwitched = m.reference_conditioning_auto_fallback === true

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
      {/* 이 소리가 어땠는지 — 눌러 두면 이 실행의 기록에 남는다.
          왜 있는가(2026-09-08 조사): 설정은 기록에 다 남는데 **그 소리가 어땠는지**가 없어서
          "어떤 설정이 좋은 소리를 만드나" 를 기록만으로 답할 수 없었다. 한 번의 클릭이 그 빈칸을 메운다.
          run_id 가 없으면(기록이 꺼진 실행) 아예 보이지 않는다 — 누를 수 없는 단추를 두지 않는다. */}
      <ListeningVerdict runId={m.run_id ? String(m.run_id) : ''} />

      {/* 자동 모드가 안정 방식으로 바꿔 만들었을 때의 **유일한** 사용자 문구(권위는 Python metadata).
          여기에 내부 code 를 덧붙이지 않는다 — code 는 아래 '상세 정보' 안에만 있다. */}
      {rcNotice && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{rcNotice}</div>
      )}
      {fallback && Boolean(m.fallback_reason) && (
        <div style={{ fontSize: 11, color: 'var(--rose)' }}>⚠ 폴백 사유: {String(m.fallback_reason)}</div>
      )}
      {/* 구현 상세(접기) — PHASE B 에서 합성 정보 배지 전체가 이 안으로 들어왔다.
          기본 화면에는 '무슨 일이 있었는가'(headline·전환 안내)만 남고, 수치·기술명은 펼쳐야 보인다.
          문장·전사·전체 경로는 담지 않는다(스키마상 없음). */}
      <details style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', width: 'fit-content' }}>상세 정보</summary>
        <div style={{ marginTop: 6, ...rowWrap }}>
        <span style={chip('var(--rose)')}>실제 엔진: <strong style={{ color: 'var(--text-primary)' }}>{engineName(actual)}</strong></span>
        {device && <span style={chip('var(--cyan)')}>장치: <strong style={{ color: 'var(--text-primary)' }}>{device}</strong></span>}
        {promptMode && <span style={chip()}>참조 방식: {promptMode}</span>}
        {region && typeof region.start === 'number' && typeof region.duration === 'number' && (
          <span style={chip()}>참조 구간: {region.start.toFixed(1)}~{(region.start + region.duration).toFixed(1)}초 ({region.duration.toFixed(1)}초)</span>
        )}
        {tgt && <span style={chip()}>언어: {tgt}</span>}
        <span style={chip()}>속도 후처리: {speedPost ? '적용됨' : '없음'}</span>
        <span style={chip(pitchPost ? 'var(--accent)' : undefined)}>
          음높이: {pitchPost ? `${pitchSt > 0 ? '+' : ''}${pitchSt.toFixed(1)}반음` : '원본'}
        </span>
        {sr && <span style={chip()}>{(sr / 1000).toFixed(0)}kHz</span>}
        {elapsed != null && <span style={chip()}>소요: {elapsed < 60 ? `${elapsed.toFixed(1)}초` : `${(elapsed / 60).toFixed(1)}분`}</span>}
        {gen && gen.termination === 'completed_before_limit' && (
          <span style={chip('var(--cyan)')} title="생성 안전장치: 동적 상한 전에 자연히 끝났습니다(계약 A/B).">
            생성: 안전 범위 내 완료
            {gen.iters != null && gen.limit != null && ` (반복 ${gen.iters}/${gen.limit})`}
            {gen.chunks.length > 0 && ` · 조각 ${gen.chunks.length}`}
          </span>
        )}
      </div>
      {emoNames && Object.keys(emoNames).length > 0 && (
          <div style={rowWrap}>
            {Object.entries(emoNames).map(([id, name]) => {
              const r = emoRegions?.[id]
              const hasR = r && typeof r.start === 'number' && typeof r.duration === 'number'
              return (
                <span key={id} style={chip('var(--accent)')}>
                  감정 참조 [{EMO_LABEL[id] || id}]: {name}
                  {hasR && ` (${r!.start!.toFixed(1)}~${(r!.start! + r!.duration!).toFixed(1)}초)`}
                </span>
              )
            })}
          </div>
        )}
        {/* 구현 상세 — 기술 구현명·자동분할 조각별 수치. 구 session(기술 필드 없음)은 이 줄들이 비어 있다. */}
        {((pitchPost && pitchMethod) || hasExprMeta || rcSwitched) && (
          <div style={{ marginTop: 6, ...rowWrap }}>
            {pitchPost && pitchMethod && <span style={chip()}>음높이 구현: {pitchMethod}</span>}
            {tailMode && <span style={chip()}>말끝 다듬기: {tailMode === 'auto' ? `자동${tailPad != null ? ` (여백 ${tailPad}ms${tailFadeApplied ? ', 페이드' : ''})` : ''}` : '끔'}</span>}
            {emoBoundary && <span style={chip()}>감정 전환: {emoBoundary === 'pause' ? '쉼 후' : '즉시'}</span>}
            {explicitPauses > 0 && <span style={chip()}>명시적 쉼 {explicitPauses}회</span>}
            {segCount != null && <span style={chip()}>문장 {segCount}개</span>}
            {parserVer != null && planSha8 && <span style={chip()}>파서 v{parserVer} · {planSha8}</span>}
            {rcSwitched && rcRequested && rcEffective && (
              <span style={chip()}>참조 사용 방식: {rcRequested} → {rcEffective}</span>
            )}
            {rcSwitched && rcFailureCode && <span style={chip()}>전환 사유 코드: {rcFailureCode}</span>}
          </div>
        )}
        {gen && gen.chunks.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, overflowX: 'auto' }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>자동 분할 조각 ({gen.chunks.length})</span>
            {gen.chunks.map((c, i) => (
              <div key={`${c.original_segment_index}-${c.chunk_index}-${i}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <span style={chip()}>문장 {c.original_segment_index + 1} · 조각 {c.chunk_index + 1}/{c.chunk_count}</span>
                {c.production_tokens != null && <span style={chip()}>토큰 {c.production_tokens}</span>}
                {c.generated_iterations != null && c.generation_limit != null && (
                  <span style={chip()}>반복 {c.generated_iterations}/{c.generation_limit}</span>
                )}
                <span style={chip(c.termination_reason === 'generation_limit' ? 'var(--rose)' : undefined)}>
                  {c.termination_reason === 'generation_limit' ? '상한 도달' : '상한 전 완료'}
                </span>
                {c.emotion_id && c.emotion_id !== 'default' && (
                  <span style={chip('var(--accent)')}>감정 {EMO_LABEL[c.emotion_id] || c.emotion_id}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </details>
    </div>
  )
}
