import { useAppStore } from '@/stores/app.store'
import DropZone from './DropZone'
import Waveform from './Waveform'

export default function SourceCard({ reference = false }: { reference?: boolean }) {
  const fileInfo = useAppStore(s => s.fileInfo)
  return <section data-testid="source-card" aria-label={reference ? '참조 목소리' : '작업 원본'} style={{ border: '1px solid var(--border-subtle)', borderRadius: 14, overflow: 'hidden', background: 'var(--bg-card)' }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '15px 20px', borderBottom: fileInfo ? '1px solid var(--border-subtle)' : undefined }}>
      <h2 style={{ fontSize: 12, fontWeight: 600 }}>{reference ? '참조 목소리' : '작업 원본'}</h2>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{reference ? '파일 작업과 함께 사용하는 원본입니다.' : '음악 · 대화 · 텍스트 · 분할에서 함께 사용합니다.'}</span>
    </div>
    <div style={fileInfo ? undefined : { padding: '0 18px 18px' }}><DropZone /></div>
    {fileInfo && (reference ? <details style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <summary style={{ padding: '10px 20px', cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)' }}>원본 전체 듣기</summary>
      <Waveform />
    </details> : <Waveform />)}
  </section>
}
