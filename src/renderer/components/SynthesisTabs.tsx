// 합성 진입점 — **일반 / 고급** 두 자리.
//
// 예전에는 상위 메뉴에 '합성' 과 '테스트개발' 이 따로 있었다. 둘 다 "목소리로 말을 만드는 일"
// 이라 들어가는 문이 둘일 이유가 없다. 그래서 문은 '합성' 하나로 두고 그 안에서 나눈다.
//   · 일반 — 대본을 쓰고 문장마다 만들어 고르고 이어 붙인다(예전 작업실 그대로).
//   · 고급 — 예전 합성 화면 그대로. 세부 설정과 인물 배정이 여기 있다.
//
// ★기능과 저장은 합치지 않았다. 둘은 **각자의 작업**을 그대로 들고 있고, 전환은 그저 보고 있는
//   자리를 바꾸는 것이다. 대사·목소리·설정·생성본을 베끼거나 맞추거나 지우지 않는다.
import { useAppStore } from '@/stores/app.store'
import type { SynthesisTab } from '@/stores/app.store'
import LabWorkspace from '@/components/LabWorkspace'
import TTSEditor from '@/components/TTSEditor'
import DropZone from '@/components/DropZone'

const LABEL: Record<SynthesisTab, string> = { basic: '일반', advanced: '고급' }
const HINT: Record<SynthesisTab, string> = {
  basic: '대본을 쓰고 문장마다 음성을 만들어 고릅니다',
  advanced: '기존 합성 화면 — 세부 설정과 인물 배정',
}

export default function SynthesisTabs() {
  const tab = useAppStore((s) => s.synthesisTab)
  const setTab = useAppStore((s) => s.setSynthesisTab)
  // 합성이 도는 중에는 자리를 옮기지 않는다 — 진행 상태와 취소 단추를 놓치지 않기 위해서다.
  const disabled = useAppStore((s) => s.status) === 'processing'
  const fileInfo = useAppStore((s) => s.fileInfo)
  // 고급은 예전처럼 **원본 파일이 있어야** 한다. 그 조건은 그대로 두되, 파일이 없다고 탭 줄까지
  // 사라지면 일반으로 돌아올 길이 없어진다 — 그래서 이 자리 안에서 기존 불러오기를 보여 준다.
  const needFile = tab === 'advanced' && !fileInfo

  const seg = (active: boolean) => ({
    flex: '1 1 0', minWidth: 0, padding: '10px 12px', border: 'none', fontFamily: 'inherit',
    fontSize: 13, fontWeight: active ? 700 : 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    opacity: disabled ? 0.5 : 1,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div role="tablist" aria-label="합성 방식" data-testid="synthesis-tabs"
        style={{
          display: 'flex', width: '100%', borderRadius: 10, overflow: 'hidden',
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
        }}>
        {(['basic', 'advanced'] as SynthesisTab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            data-testid={`synthesis-tab-${t}`} disabled={disabled} title={HINT[t]}
            onClick={() => { if (!disabled) setTab(t) }}
            style={seg(tab === t)}>
            {LABEL[t]}
          </button>
        ))}
      </div>

      {/* 둘이 서로의 작업을 건드리지 않는다는 것을 **한 줄로** 알린다.
          전환하면 지워지는 줄 알고 망설이는 것을 막기 위해서다. */}
      <div data-testid="synthesis-scope-note"
        style={{ fontSize: 11, color: 'var(--text-muted)', padding: '0 2px' }}>
        일반과 고급의 작업은 각각 저장됩니다.
      </div>

      {tab === 'basic' ? <LabWorkspace />
        : needFile ? (
          <div data-testid="synthesis-need-file" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              고급 합성은 목소리로 쓸 원본 파일을 먼저 불러와야 합니다.
            </div>
            <DropZone />
          </div>
        ) : <TTSEditor />}
    </div>
  )
}
