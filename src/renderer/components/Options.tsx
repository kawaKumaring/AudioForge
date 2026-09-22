import { useState } from 'react'
import { useAppStore } from '@/stores/app.store'

// Whisper 모델 크기별 의미 (툴팁) — 클수록 정확하지만 느리고 무겁다
const WHISPER_HINTS: Record<string, string> = {
  'small': '가장 빠르고 가벼움. 정확도는 낮아 짧고 또렷한 음성에 적합',
  'medium': '속도와 정확도의 중간 균형 — 무난한 선택',
  'large-v3': '가장 정확하지만 느리고 무거움. 잡음·다국어에 강함 (기본)',
  'large-v3-turbo': 'Large 대비 약 8배 빠름. 정확도는 조금 낮음 (한/일은 Large가 근소 우위)',
}

// 출력 파일 형식 (툴팁) — 품질/용량 트레이드오프
const OUTPUT_HINTS: Record<string, string> = {
  'wav': '무손실 원본 품질. 용량이 큼 (기본)',
  'mp3': '손실 압축. 용량이 작아 공유·재생에 편리',
  'flac': '무손실 압축. WAV 품질을 유지하며 용량 절감',
}

export default function Options() {
  const { mode, trimSilence, silenceGap, transcribe, translate, exportSrt, outputFormat, whisperModel, asrEngine, setAsrEngine, asrSeparate, setAsrSeparate, diarizeEngine, setDiarizeEngine, whisperLang, translateModel, demucsModel, nSpeakers,
    setTrimSilence, setSilenceGap, setTranscribe, setTranslate, setExportSrt, setOutputFormat, setWhisperModel, setWhisperLang, setTranslateModel, setDemucsModel, setNSpeakers, status } = useAppStore()
  const disabled = status === 'processing'
  const [open, setOpen] = useState(false)

  const isTranscribeMode = mode === 'transcribe'
  const isSplitMode = mode === 'split'

  const chip = (checked: boolean, color: string, label: string, onChange: (v: boolean) => void, tooltip?: string) => (
    <label title={tooltip || ''} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
      borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
      background: checked ? `${color}18` : 'var(--bg-elevated)',
      border: `1px solid ${checked ? color : 'var(--border-subtle)'}`,
      opacity: disabled ? 0.5 : 1, fontSize: 11, fontWeight: 500,
      color: checked ? color : 'var(--text-muted)', transition: 'all 0.15s'
    }}>
      <input type="checkbox" checked={checked} onChange={(e) => !disabled && onChange(e.target.checked)}
        disabled={disabled} style={{ display: 'none' }} />
      {label}
    </label>
  )

  return (
    <div style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
      {/* Toggle header */}
      <button onClick={() => setOpen(!open)} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer',
        background: 'transparent', fontFamily: 'inherit', outline: 'none'
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>옵션</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Active options preview (when collapsed) */}
          {!open && (
            <div style={{ display: 'flex', gap: 4 }}>
              {!isTranscribeMode && trimSilence && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--accent-glow)', color: 'var(--accent)' }}>무음제거</span>}
              {!isTranscribeMode && transcribe && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--cyan-glow)', color: 'var(--cyan)' }}>텍스트</span>}
              {translate && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--emerald-glow)', color: 'var(--emerald)' }}>번역</span>}
              {exportSrt && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(251,191,36,0.15)', color: 'var(--amber)' }}>SRT</span>}
              {!isTranscribeMode && outputFormat !== 'wav' && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>{outputFormat.toUpperCase()}</span>}
            </div>
          )}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {/* Expandable content */}
      {open && (
        <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Chips row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {!isTranscribeMode && !isSplitMode && chip(trimSilence, 'var(--accent)', '무음 구간 제거', setTrimSilence, '중간의 긴 무음 구간을 잘라내 전체 길이를 줄입니다')}
            {!isTranscribeMode && !isSplitMode && chip(transcribe, 'var(--cyan)', '텍스트 변환', setTranscribe, '음성을 글자(대본/자막)로 받아쓰기합니다')}
            {isSplitMode && chip(transcribe, 'var(--cyan)', '트랙별 가사 추출', setTranscribe, '분할된 각 트랙의 음성을 글자로 받아쓰기합니다')}
            {chip(translate, 'var(--emerald)', '한국어 번역', setTranslate, '받아쓴 텍스트를 한국어로 번역합니다')}
            {chip(exportSrt, 'var(--amber)', 'SRT 자막', setExportSrt, '영상 편집기에서 쓰는 시간 동기화 자막 파일(.srt)을 함께 생성합니다')}
          </div>

          {/* Sub-options: 각 컨트롤을 한 줄씩 세로로 쌓아 서로 간섭·밀림 없게(사용자 요청).
              컨트롤은 자기 너비만 차지하도록 왼쪽 정렬(pill 리스트 느낌). */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            {/* 출력 (앵커) */}
            {!isTranscribeMode && !isSplitMode && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>출력</span>
                {(['wav', 'mp3', 'flac'] as const).map((fmt) => (
                  <button key={fmt} onClick={() => !disabled && setOutputFormat(fmt)} disabled={disabled} title={OUTPUT_HINTS[fmt] || ''} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, textTransform: 'uppercase', fontFamily: 'inherit',
                    background: outputFormat === fmt ? 'var(--accent)' : 'transparent',
                    color: outputFormat === fmt ? '#fff' : 'var(--text-muted)'
                  }}>{fmt}</button>
                ))}
              </div>
            )}
            {/* 화자 수 (앵커, conversation mode) */}
            {mode === 'conversation' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>화자 수</span>
                {[2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => !disabled && setNSpeakers(n)} disabled={disabled} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                    background: nSpeakers === n ? 'var(--cyan)' : 'transparent',
                    color: nSpeakers === n ? '#fff' : 'var(--text-muted)'
                  }}>{n}명</button>
                ))}
              </div>
            )}
            {/* 분리 (앵커, music mode) */}
            {mode === 'music' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>분리</span>
                {([
                  ['htdemucs', '기본 4트랙', '보컬·드럼·베이스·기타 4개로 분리 (표준·빠름)'],
                  ['htdemucs_ft', '고품질 4트랙', '4개로 분리, 더 정밀하지만 느림'],
                  ['roformer', '보컬 2트랙', '보컬 / 반주 2개로만 분리 (BS-RoFormer, 노래 커버·MR용, 보컬 품질 우수)'],
                  ['roformer_melband', '보컬 Mel-Band', 'Mel-Band(bleedless) 단일 — 악기 잔음이 특히 적고 roformer만큼 빠름'],
                  ['roformer_ensemble', '보컬 앙상블', 'BS + Mel-Band 2모델 평균 — 절충. 가장 느림(2배). 소스마다 유불리 다름'],
                ] as const).map(([m, label, hint]) => (
                  <button key={m} onClick={() => !disabled && setDemucsModel(m)} disabled={disabled} title={hint} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                    background: demucsModel === m ? 'var(--accent)' : 'transparent',
                    color: demucsModel === m ? '#fff' : 'var(--text-muted)'
                  }}>{label}</button>
                ))}
              </div>
            )}
            {/* 무음 간격 (trimSilence on) — 고정 폭. 라벨은 부모 '무음 구간 제거'와 어휘 일관.
                의미(감지가 아니라 '제거 후 남길 간격')는 라벨이 아니라 툴팁으로 설명. */}
            {trimSilence && !isTranscribeMode && !isSplitMode && (
              <div title="무음을 제거한 뒤 말과 말 사이에 남겨둘 무음 길이입니다. 어디를 무음으로 감지할지는 바꾸지 않습니다 (0초=딱 붙임, 클수록 쉼이 김)"
                style={{ width: 240, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>무음 간격</span>
                <input type="range" min="0" max="2" step="0.1" value={silenceGap}
                  onChange={(e) => setSilenceGap(parseFloat(e.target.value))} disabled={disabled}
                  style={{ flex: 1, accentColor: 'var(--accent)', cursor: 'pointer', height: 4 }} />
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-light)', fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>{silenceGap.toFixed(1)}초</span>
              </div>
            )}
            {/* Whisper model */}
            {(transcribe || isTranscribeMode || isSplitMode) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Whisper</span>
                {(['small', 'medium', 'large-v3', 'large-v3-turbo'] as const).map((m) => (
                  <button key={m} onClick={() => !disabled && setWhisperModel(m)} disabled={disabled}
                    title={WHISPER_HINTS[m] || ''}
                    style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                    background: whisperModel === m ? 'var(--cyan)' : 'transparent',
                    color: whisperModel === m ? '#fff' : 'var(--text-muted)'
                  }}>{m === 'large-v3' ? 'Large' : m === 'large-v3-turbo' ? 'Turbo' : m.charAt(0).toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            )}
            {/* 대화 분석 엔진 — **대화 모드에서만.** 기본은 기존 엔진이다.
                Community-1 은 준비돼 있지 않으면 실패를 그대로 알린다(몰래 바꾸지 않는다). */}
            {mode === 'conversation' && (
              <div data-testid="diarize-engine-row" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>분석 방식</span>
                {([['builtin', '기본'], ['community-1', 'Community-1']] as const).map(([id, label]) => (
                  <button key={id} data-testid={`diarize-engine-${id}`}
                    onClick={() => !disabled && setDiarizeEngine(id)} disabled={disabled}
                    title={id === 'builtin'
                      ? "지금까지 쓰던 화자 분석입니다."
                      : "pyannote Community-1 로 분석합니다. 이용 조건 수락과 모델 준비가 필요하며, 준비돼 있지 않으면 실패를 그대로 알립니다. 음원은 이 컴퓨터 밖으로 나가지 않습니다."}
                    style={{
                      padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                      background: diarizeEngine === id ? 'var(--cyan)' : 'transparent',
                      color: diarizeEngine === id ? '#fff' : 'var(--text-muted)',
                    }}>{label}</button>
                ))}
              </div>
            )}
            {/* 실행 엔진 — **텍스트 추출 모드에서만.** 기본은 기존 경로다.
                분리 모드의 후처리 전사와 합성의 참조 전사는 이 선택을 따르지 않는다. */}
            {isTranscribeMode && (
              <div data-testid="asr-engine-row" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>실행 방식</span>
                {([['whisper', '기본'], ['faster-whisper', '빠른 실행']] as const).map(([id, label]) => (
                  <button key={id} data-testid={`asr-engine-${id}`}
                    onClick={() => !disabled && setAsrEngine(id)} disabled={disabled}
                    title={id === 'whisper'
                      ? "지금까지 쓰던 실행 경로입니다."
                      : "같은 Whisper 모델을 CTranslate2 로 돌립니다. 결과 형식은 같습니다. 준비돼 있지 않으면 실패를 그대로 알립니다."}
                    style={{
                      padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                      background: asrEngine === id ? 'var(--cyan)' : 'transparent',
                      color: asrEngine === id ? '#fff' : 'var(--text-muted)',
                    }}>{label}</button>
                ))}
              </div>
            )}
            {/* 배경음 걷어내기 — **텍스트 추출 모드에서만.** 기본은 안 함(기존 동작).
                왜 내놓는가: 반주·소음이 깔린 소리에서 알아듣기가 눈에 띄게 좋아진다.
                실측(2026-09-21, 일본어 노래 1곡): 68.5% → 74.3%.
                공짜가 아니다 — 한 번 더 갈라내는 시간을 치른다. 그래서 기본은 꺼 둔다. */}
            {isTranscribeMode && (
              <div data-testid="asr-separate-row" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>배경음</span>
                {([['never', '그대로'], ['auto', '자동'], ['always', '걷어냄']] as const).map(([id, label]) => (
                  <button key={id} data-testid={`asr-separate-${id}`}
                    onClick={() => !disabled && setAsrSeparate(id)} disabled={disabled}
                    title={id === 'never'
                      ? '소리를 그대로 넣습니다(기본). 지금까지와 같습니다.'
                      : id === 'auto'
                        ? '먼저 목소리와 배경음을 갈라내 크기를 재고, 배경음이 클 때만 걷어낸 소리를 넣습니다. 조용한 녹음이면 원본을 그대로 씁니다. 갈라내는 시간이 한 번 듭니다.'
                        : '언제나 목소리만 뽑아 넣습니다. 반주나 소음이 늘 깔려 있는 소리에 쓰세요. 실측으로 알아듣기가 68.5%에서 74.3%로 올랐습니다. 갈라내는 시간이 한 번 듭니다.'}
                    style={{
                      padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                      background: asrSeparate === id ? 'var(--cyan)' : 'transparent',
                      color: asrSeparate === id ? '#fff' : 'var(--text-muted)',
                    }}>{label}</button>
                ))}
              </div>
            )}
            {/* Whisper language (auto-detect vs forced) */}
            {(transcribe || isTranscribeMode || isSplitMode) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>언어</span>
                {([['auto', '자동'], ['ko', '한국어'], ['en', '영어'], ['ja', '일본어'], ['zh', '중국어']] as const).map(([code, label]) => (
                  <button key={code} onClick={() => !disabled && setWhisperLang(code)} disabled={disabled}
                    title={code === 'auto' ? '언어를 자동 감지 (기본). 언어를 잘못 잡거나 엉뚱한 자막이 나오면 특정 언어로 강제하세요' : `${label}로 강제 인식 — 자동 감지 오류 방지`}
                    style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                    background: whisperLang === code ? 'var(--cyan)' : 'transparent',
                    color: whisperLang === code ? '#fff' : 'var(--text-muted)'
                  }}>{label}</button>
                ))}
              </div>
            )}
            {/* Translation model (shown when translate on) */}
            {translate && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>번역</span>
                {([
                  ['600m', '600M', 'NLLB-600M — 가볍고 빠름 (기본, 로컬)'],
                  ['1.3b', '1.3B', 'NLLB-1.3B — 더 큼 (효과 제한적, 로컬)'],
                  ['llm', 'LLM', 'Qwen2.5-3B 로컬 LLM — 구어체·문맥 번역, 느림·VRAM↑ (최초 1회 ~6GB 다운로드)'],
                  ['google', '구글', '구글 번역 — 품질 좋음. 단 네트워크 필요·텍스트가 구글로 전송됨(비공식 엔드포인트, 막힐 수 있음)'],
                ] as const).map(([v, label, hint]) => (
                  <button key={v} onClick={() => !disabled && setTranslateModel(v)} disabled={disabled} title={hint} style={{
                    padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                    fontSize: 10, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                    background: translateModel === v ? 'var(--emerald)' : 'transparent',
                    color: translateModel === v ? '#fff' : 'var(--text-muted)'
                  }}>{label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
