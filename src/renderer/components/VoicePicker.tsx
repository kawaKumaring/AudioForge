import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Icon, Modal, button, primary, muted, row } from './kit'
import { onPreviewState, playPreview, previewState, stopPreview, type PreviewMaker, type PreviewState } from '../lib/voicePreview'
import type { BuiltinVoiceRef } from '../../shared/synthesisCardVoice'
import { groupVoices } from '../../shared/voiceGroups'

/**
 * **목소리 고르기** — 낭독과 음성 합성이 같이 쓴다 (2026-10-01 지시: 낭독의 UX 가 주먹구구식이고,
 * 목소리들이 길게 나열되어 보기가 좋지 않다).
 *
 * ★예전: 목소리 11개가 한 줄씩(줄마다 '들어 보기' 단추 — 단추 22개), 같은 이름 "Supertonic" 이 열 번.
 *   화면마다 모양도 달랐다(낭독은 제 팝업, 합성은 공용 팝업).
 * ★지금: 묶음(빠른 기본 목소리 · 고품질 · 느림 · 내 목소리 파일)마다 짧은 칩. 칩을 누르면 **고르기만** 하고,
 *   아래에서 '들어 보기' 와 확정 단추 하나로 끝낸다 — 들어 보는 소리가 무엇인지 늘 한 자리에서 보인다.
 *   칩을 두 번 누르면 곧바로 확정한다(익숙한 사람의 지름길).
 * ★쓸 수 없는 목소리는 **목록에 넣지 않는다**(본체가 설치·구동을 확인한 것만 온다).
 */
export interface RecentVoice { path: string; label: string }

export default function VoicePicker({
  close, builtins, why, current, onChoose, onFile, recent, onRecent, confirmLabel, fileLabel = '음성·영상 파일에서',
  make, disabled = false, ids,
}: {
  close: () => void
  /** null 이면 아직 확인 중. */
  builtins: BuiltinVoiceRef[] | null
  why?: string
  /** 지금 쓰는 목소리 — 처음에 골라져 있다. */
  current?: { kind: 'builtin' | 'reference'; path: string } | null
  onChoose: (v: BuiltinVoiceRef) => void
  onFile: () => void
  /** 전에 쓴 내 목소리 파일(낭독). 없으면 묶음을 보이지 않는다. */
  recent?: RecentVoice[]
  onRecent?: (r: RecentVoice) => void
  confirmLabel: string
  fileLabel?: string
  /** 들어 볼 소리를 만드는 길. 없으면 음성 합성의 미리듣기. */
  make?: PreviewMaker
  disabled?: boolean
  /** 검사용 이름표 — 화면마다 예전 이름을 지킨다. */
  ids: { chip: string; confirm: string; file: string; preview: string; recent?: string }
}) {
  const groups = useMemo(() => groupVoices(builtins || []), [builtins])
  const [sel, setSel] = useState<string>(() => current?.kind === 'builtin' ? current.path : '')
  const [pv, setPv] = useState<PreviewState>(() => previewState())
  useEffect(() => onPreviewState(setPv), [])
  useEffect(() => () => stopPreview(), [])
  // 목록이 오면 — 지금 쓰는 것, 없으면 **첫 묶음의 첫 목소리**를 골라 둔다(열자마자 들어 보기·확정이 된다 — 누르는 수를 줄인다).
  useEffect(() => {
    if (!builtins?.length) return
    const first = groups[0]?.voices[0]?.voice.path || ''
    setSel((s) => builtins.some((b) => b.path === s) ? s
      : (current?.kind === 'builtin' && builtins.some((b) => b.path === current.path) ? current.path : first))
  }, [builtins, groups])
  const chosen = (builtins || []).find((b) => b.path === sel) || null
  const mine = !!chosen && pv.modelPath === chosen.path
  const phase = mine ? pv.phase : 'idle'
  const choose = (v: BuiltinVoiceRef) => { stopPreview(); close(); onChoose(v) }

  const chip = (on: boolean): CSSProperties => ({
    ...button, justifyContent: 'center', minHeight: 40, padding: '8px 10px', fontSize: 13,
    borderColor: on ? 'var(--accent-light)' : 'var(--border-subtle)',
    background: on ? 'var(--accent-glow)' : 'var(--bg-elevated)',
    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
  })
  const heading: CSSProperties = { ...row, justifyContent: 'space-between', margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }

  return <Modal title="목소리 고르기" subtitle={chosen ? `고른 목소리 · ${chosen.label}` : undefined} close={() => { stopPreview(); close() }}
    footer={<>
      <button type="button" data-testid={ids.preview} disabled={disabled || !chosen}
        aria-label={chosen ? `${chosen.label} 들어 보기` : '들어 보기'}
        title={phase === 'failed' ? (pv.message || '들어 보지 못했습니다. 다시 눌러 보세요.') : chosen ? `${chosen.label} 로 짧은 문장을 읽어 들려줍니다` : '먼저 목소리를 고르세요'}
        onClick={() => { if (chosen) void playPreview(chosen.path, chosen.engineId, make) }}
        style={{ ...button, marginRight: 'auto', color: phase === 'failed' ? 'var(--rose)' : phase === 'playing' ? 'var(--accent-light)' : 'var(--text-secondary)' }}>
        <Icon name={phase === 'playing' || phase === 'preparing' ? 'stop' : 'play'}/>
        {phase === 'preparing' ? '만드는 중' : phase === 'playing' ? '멈춤' : phase === 'failed' ? '다시 듣기' : '들어 보기'}
      </button>
      <button type="button" style={button} onClick={() => { stopPreview(); close() }}>취소</button>
      <button type="button" data-testid={ids.confirm} disabled={disabled || !chosen}
        title={chosen ? `${chosen.label}` : '먼저 목소리를 고르세요'}
        style={{ ...primary, opacity: disabled || !chosen ? .45 : 1 }} onClick={() => { if (chosen) choose(chosen) }}>
        <Icon name="check"/>{confirmLabel}
      </button>
    </>}>
    <div style={{ display: 'grid', gap: 18 }}>
      {builtins === null && <span style={muted}>기본 목소리 확인 중…</span>}
      {builtins !== null && !builtins.length && <span style={{ ...muted, color: 'var(--amber)' }} title={why}>쓸 수 있는 기본 목소리가 없습니다</span>}
      {groups.map((g) => <section key={g.key} aria-label={g.title}>
        <h3 style={heading}><span>{g.title}</span><span style={{ ...muted, fontWeight: 400 }}>{g.note}</span></h3>
        <div role="radiogroup" aria-label={g.title} style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${g.wide ? 180 : 88}px, 1fr))`, gap: 6 }}>
          {g.voices.map(({ voice: v, short, tag }) => <button key={`${v.engineId}:${v.modelId}`} type="button" role="radio"
            data-testid={ids.chip} aria-checked={sel === v.path} aria-label={v.label} disabled={disabled}
            title={`${v.label} · 누르면 고르고, 두 번 누르면 바로 씁니다`}
            onClick={() => { if (sel !== v.path) { stopPreview(); setSel(v.path) } }}
            onDoubleClick={() => choose(v)}
            style={chip(sel === v.path)}>
            {sel === v.path && <Icon name="check" size={14}/>}
            {/* 설명(모델 카드)은 이름 아래 둘째 줄 — 길어도 잘리지 않게 줄을 바꾼다(2026-10-01 목소리 추가) */}
            <span style={{ display: 'grid', gap: 2, minWidth: 0, textAlign: g.wide ? 'left' : 'center', flex: g.wide ? 1 : undefined }}>
              <span>{short}</span>
              {tag && <span style={{ ...muted, fontSize: 11, whiteSpace: 'normal', lineHeight: 1.35 }}>{tag}</span>}
            </span>
          </button>)}
        </div>
      </section>)}
      <section aria-label="내 목소리 파일">
        <h3 style={heading}><span>내 목소리 파일</span><span style={{ ...muted, fontWeight: 400 }}>가진 소리·영상의 목소리로 · 느림</span></h3>
        <div style={{ display: 'grid', gap: 6 }}>
          {(recent || []).map((r) => <button key={r.path} type="button" data-testid={ids.recent} disabled={disabled}
            aria-pressed={current?.kind === 'reference' && current.path === r.path}
            title={`${r.label} — 전에 쓴 목소리 파일`} onClick={() => { stopPreview(); close(); onRecent?.(r) }}
            style={{ ...chip(current?.kind === 'reference' && current.path === r.path), justifyContent: 'flex-start' }}>
            <Icon name="voice" size={15}/><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          </button>)}
          <button type="button" data-testid={ids.file} disabled={disabled} title="가지고 있는 소리·영상 파일의 목소리를 따라 만듭니다"
            onClick={() => { stopPreview(); close(); onFile() }} style={{ ...button, justifyContent: 'flex-start', padding: '10px 12px' }}>
            <Icon name="plus"/>{fileLabel}
          </button>
        </div>
      </section>
    </div>
  </Modal>
}
