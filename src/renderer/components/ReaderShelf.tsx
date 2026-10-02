import { useMemo, useState } from 'react'
import { Icon, button, field, muted, primary, row } from './kit'

export interface LibraryBook { id: string; name: string; paragraphs: string[]; position: number; addedAt?: number; group?: string }
const COLORS = [['#343957', '#aaa7d8'], ['#274443', '#9fc6b0'], ['#4c3439', '#d2a5a0'], ['#3d3b30', '#d1c39a'], ['#283d52', '#99bcd8']]

/** 파일 이름으로 만든 표지. 실제 책 표지나 저자 정보를 추정하지 않는다. */
export function ReaderCover({ name, small = false, compact = false }: { name: string; small?: boolean; compact?: boolean }) {
  const hash = Array.from(name).reduce((n, c) => (n + c.charCodeAt(0)) % COLORS.length, 0)
  const [base, ink] = COLORS[hash]
  return <div aria-hidden="true" style={{ position: 'relative', height: small ? 148 : compact ? 125 : 190, width: small ? 108 : '100%', flexShrink: 0,
    borderRadius: '3px 11px 11px 3px', overflow: 'hidden', background: `linear-gradient(115deg, ${base}, #141920)`, color: ink,
    boxShadow: 'inset 5px 0 0 #ffffff10, inset 7px 0 0 #0005, 0 10px 20px #0003', padding: small || compact ? '14px 12px' : '24px 21px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
    <span style={{ fontSize: compact ? 7 : 9, letterSpacing: '.12em', opacity: .8 }}>AUDIOFORGE</span>
    <span style={{ position: 'absolute', border: '1px solid currentColor', opacity: .13, width: 130, height: 130, borderRadius: '50%', bottom: -48, right: -35 }}/>
    <span style={{ position: 'absolute', border: '1px solid currentColor', opacity: .13, width: 170, height: 170, borderRadius: '50%', bottom: -68, right: -55 }}/>
    <span style={{ fontSize: compact ? 12 : small ? 14 : 19, lineHeight: 1.6, fontWeight: 600, color: '#f1eee7', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: small || compact ? 3 : 4, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>{name}</span>
    <span style={{ width: 22, height: 2, background: ink }}/>
  </div>
}

export default function ReaderShelf({ books, active, busy, error, onAdd, onOpen, onRemove, onDrop, view, grouped, onView, onGrouped, onGroup }: {
  books: LibraryBook[]; active: string; busy: boolean; error: string
  onAdd: () => void; onOpen: (id: string) => void; onRemove: (ids: string[]) => Promise<void>; onDrop: (files: File[]) => void
  view: 'cover' | 'compact' | 'list'; grouped: boolean
  onView: (view: 'cover' | 'compact' | 'list') => void; onGrouped: (grouped: boolean) => void
  onGroup: (ids: string[], name: string) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('added')
  const [managing, setManaging] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [confirm, setConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [inside, setInside] = useState('')
  const [groupName, setGroupName] = useState('')
  const [grouping, setGrouping] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const names = useMemo(() => Array.from(new Set(books.map(b => b.group).filter((g): g is string => !!g))).sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })), [books])
  const currentGroup = names.includes(inside) ? inside : ''
  const duplicateGroupName = renaming && groupName.trim() !== currentGroup && names.includes(groupName.trim())
  const shown = useMemo(() => {
    const found = books.filter(b => (!currentGroup || b.group === currentGroup) && `${b.name} ${b.group || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    return sort === 'name' ? found.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true })) : found.reverse().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
  }, [books, query, sort, currentGroup])
  const picked = selected.filter(id => books.some(b => b.id === id))
  const locked = busy || removing || grouping
  const groupedNames = grouped && !currentGroup && !managing ? names.filter(name => shown.some(b => b.group === name)) : []
  const visibleBooks = groupedNames.length ? shown.filter(b => !b.group) : shown
  const groupAction = async (ids: string[], name: string) => {
    setGrouping(true)
    try {
      if (await onGroup(ids, name)) { setSelected([]); setGroupName(''); setRenaming(false); setConfirm(false); if (renaming) setInside(name.trim()); setManaging(false) }
    } finally { setGrouping(false) }
  }
  const current = books.find(b => b.id === active)
  const add = <button data-testid="reader-add-text" className="reader-add-tile" style={{ ...button, flex: '1 1 170px', flexDirection: 'column', minHeight: current ? 196 : 260, gap: 15,
    background: 'var(--bg-base)', borderStyle: 'dashed', borderColor: dragging ? 'var(--accent-light)' : 'var(--border-subtle)', borderRadius: 16 }} disabled={locked} onClick={onAdd}>
    <span style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', background: 'var(--accent-glow)', color: 'var(--accent-light)', borderRadius: 16 }}><Icon name="plus" size={24}/></span>
    <strong style={{ fontSize: 15, color: 'var(--text-primary)' }}>{busy ? '책을 불러오는 중…' : '새 책 가져오기'}</strong>
    <span style={muted}>TXT 파일을 끌어 놓거나 선택</span>
  </button>
  return <div data-testid="reader-library-dialog" className="reader-view-enter" onDragOver={e => { e.preventDefault(); setDragging(true) }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
    onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); if (!locked) onDrop(Array.from(e.dataTransfer.files)) }}
    style={{ display: 'grid', gap: 28, outline: dragging ? '2px solid var(--accent-light)' : undefined, outlineOffset: 6, borderRadius: 16 }}>
    {error && <div role="alert" style={{ fontSize: 12, color: 'var(--rose)' }}>{error}</div>}
    {!currentGroup && !query && !managing && <div style={{ ...row, alignItems: 'stretch', gap: 16 }}>
      {current && <div style={{ flex: '3 1 360px', display: 'flex', alignItems: 'center', gap: 24, padding: 24, border: '1px solid #ffffff0d', borderRadius: 16, background: 'linear-gradient(120deg, #232431, #171b23)' }}>
        <ReaderCover name={current.name} small/>
        <div style={{ minWidth: 0, display: 'grid', gap: 13 }}>
          <span style={{ ...muted, letterSpacing: '.08em', color: '#c4bba8' }}>열어 둔 책</span>
          <h2 style={{ margin: 0, fontSize: 23, lineHeight: 1.4, letterSpacing: '-.03em', overflowWrap: 'anywhere' }}>{current.name}</h2>
          <span style={muted}>시작 위치 {current.position + 1} / {current.paragraphs.length} 문단</span>
          <button data-testid="reader-resume" style={{ ...primary, justifySelf: 'start', padding: '10px 17px' }} onClick={() => onOpen(current.id)}><Icon name="book"/>이어서 읽기<Icon name="next" size={13}/></button>
        </div>
      </div>}
      {add}
    </div>}
    <section style={{ display: 'grid', gap: 18 }}>
      <div style={{ ...row, gap: 12 }}>
        {currentGroup && <button style={button} aria-label="모든 작품 보기" onClick={() => { setInside(''); setSelected([]); setRenaming(false); setQuery('') }}><Icon name="back"/></button>}
        <h2 style={{ fontSize: 16, margin: 0, overflowWrap: 'anywhere' }}>{currentGroup || '내 책장'} <span style={{ ...muted, marginLeft: 7 }}>{currentGroup ? shown.length : books.length}</span></h2>
        <input aria-label="서재 검색" data-testid="reader-library-search" placeholder="책 제목 검색" value={query}
          onChange={e => { setQuery(e.target.value); setConfirm(false) }} style={{ ...field, marginLeft: 'auto', flex: '0 1 220px', width: 160 }}/>
        <select aria-label="책 정렬" value={sort} onChange={e => setSort(e.target.value)} style={{ ...field, fontSize: 12 }}><option value="added">추가 순</option><option value="name">제목 순</option></select>
        <button style={button} disabled={locked || !books.length} aria-pressed={managing} data-testid="reader-library-manage"
          onClick={() => { setManaging(!managing); setRenaming(false); setSelected([]); setConfirm(false) }}><Icon name={managing ? 'check' : 'settings'}/>{managing ? '완료' : '정리'}</button>
      </div>
      <div style={{ ...row, gap: 6 }}>
        {(['compact', 'cover', 'list'] as const).map(v => <button key={v} data-testid={`reader-view-${v}`} aria-pressed={view === v} style={{ ...button, fontSize: 11, background: view === v ? 'var(--accent-glow)' : 'transparent', color: view === v ? 'var(--accent-light)' : 'var(--text-muted)' }} onClick={() => onView(v)}>
          <Icon name={v === 'list' ? 'list' : 'book'} size={14}/>{v === 'compact' ? '작게 모아보기' : v === 'cover' ? '표지 보기' : '목록 보기'}</button>)}
        <button data-testid="reader-grouped" aria-pressed={grouped} style={{ ...button, marginLeft: 'auto', color: grouped ? 'var(--accent-light)' : 'var(--text-muted)' }} onClick={() => { onGrouped(!grouped); setInside(''); setRenaming(false); setSelected([]) }}><Icon name="folder"/>작품별</button>
        {currentGroup && <button data-testid="reader-group-rename" style={button} disabled={locked} onClick={() => { setRenaming(!renaming); setGroupName(currentGroup) }}>이름 바꾸기</button>}
      </div>
      {renaming && <div style={row}><input data-testid="reader-group-name" aria-label="새 작품 이름" maxLength={120} style={{ ...field, flex: 1 }} value={groupName} onChange={e => setGroupName(e.target.value)}/>
        <button style={button} disabled={locked} onClick={() => setRenaming(false)}>취소</button><button style={primary} title={duplicateGroupName ? '이미 있는 작품 이름입니다' : undefined} disabled={locked || !groupName.trim() || duplicateGroupName} onClick={() => void groupAction(books.filter(b => b.group === currentGroup).map(b => b.id), groupName)}>저장</button></div>}
      {managing && <div style={{ ...row, padding: 12, borderRadius: 10, background: 'var(--bg-elevated)' }}>
        <label style={{ ...row, ...muted, marginRight: 'auto' }}><input type="checkbox" aria-label="검색된 책 모두 선택" disabled={locked}
          checked={!!shown.length && shown.every(b => picked.includes(b.id))}
          onChange={e => { setSelected(e.target.checked ? Array.from(new Set([...picked, ...shown.map(b => b.id)])) : picked.filter(id => !shown.some(b => b.id === id))); setConfirm(false) }}/>{confirm ? `${picked.length}권을 서재에서 뺄까요?` : `${picked.length}권 선택`}</label>
        <button style={button} disabled={locked} onClick={() => { setConfirm(false); setManaging(false); setSelected([]) }}>취소</button>
        <div style={{ ...row, width: '100%' }}>
          <input data-testid="reader-group-name" aria-label="작품 이름" placeholder="작품 이름을 입력하거나 선택" list="reader-group-names" maxLength={120} style={{ ...field, flex: '1 1 160px' }} value={groupName} onChange={e => setGroupName(e.target.value)}/>
          <datalist id="reader-group-names">{names.map(name => <option key={name} value={name}/>)}</datalist>
          <button data-testid="reader-group-apply" style={primary} disabled={locked || !picked.length || !groupName.trim()} onClick={() => void groupAction(picked, groupName)}><Icon name="folder"/>작품으로 묶기</button>
          <button data-testid="reader-group-clear" style={button} disabled={locked || !picked.some(id => books.find(b => b.id === id)?.group)} onClick={() => void groupAction(picked, '')}>묶음에서 꺼내기</button>
        </div>
        <button style={{ ...button, color: 'var(--rose)' }} data-testid="reader-library-remove" title="원본 TXT 파일은 유지합니다" disabled={locked || !picked.length}
          onClick={async () => { if (!confirm) { setConfirm(true); return }; setRemoving(true); try { await onRemove(picked); setSelected([]); setConfirm(false) } finally { setRemoving(false) } }}>
          <Icon name="trash"/>{removing ? '정리 중…' : confirm ? '목록에서 빼기' : '선택 정리'}</button>
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: view === 'list' ? '1fr' : `repeat(auto-fill, minmax(${view === 'compact' ? 100 : 145}px, 1fr))`, gap: view === 'list' ? 8 : view === 'compact' ? '18px 14px' : '24px 20px' }}>
        {groupedNames.map(name => <button key={`group:${name}`} data-testid="reader-book-group" aria-label={`${name} 작품 열기`} className="reader-book-tile" disabled={locked}
          onClick={() => { setInside(name); setQuery(''); setSelected([]) }} style={{ ...button, display: 'flex', flexDirection: view === 'list' ? 'row' : 'column', alignItems: view === 'list' ? 'center' : 'stretch', textAlign: 'left', padding: view === 'list' ? 14 : 10, gap: 10, minWidth: 0, whiteSpace: 'normal', background: '#1b2029', borderColor: '#b5aa9540' }}>
          {view !== 'list' && <ReaderCover name={name} compact={view === 'compact'}/>}
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1 }}><Icon name="folder" size={15}/><span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span></span>
          <span style={muted}>{books.filter(b => b.group === name).length}권 묶음</span>
        </button>)}
        {visibleBooks.map(b => <button key={b.id} className="reader-book-tile" data-testid="reader-library-book" disabled={locked}
          aria-current={active === b.id ? 'true' : undefined} aria-pressed={managing ? picked.includes(b.id) : undefined} aria-label={b.name}
          onClick={() => managing ? (setSelected(picked.includes(b.id) ? picked.filter(id => id !== b.id) : [...picked, b.id]), setConfirm(false)) : onOpen(b.id)}
          title={b.name} style={{ position: 'relative', display: view === 'list' ? 'flex' : 'grid', alignItems: 'center', gap: 11, minWidth: 0, textAlign: 'left', background: view === 'list' ? 'var(--bg-card)' : 'transparent', border: 'none', padding: view === 'list' ? '13px 14px' : 0, font: 'inherit', cursor: 'pointer', borderRadius: 10,
            outline: managing && picked.includes(b.id) ? '2px solid var(--accent-light)' : undefined, outlineOffset: 5 }}>
          {view === 'list' ? <><Icon name="book"/><span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span></> : <ReaderCover name={b.name} compact={view === 'compact'}/>}
          {managing && <span style={{ position: 'absolute', right: 9, top: 9, width: 23, height: 23, borderRadius: '50%', background: picked.includes(b.id) ? 'var(--accent)' : '#13161f', display: 'grid', placeItems: 'center', color: '#fff', border: '1px solid #ffffff50' }}>{picked.includes(b.id) && <Icon name="check" size={14}/>}</span>}
          <span style={{ ...muted, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 5 }}><span>{active === b.id ? '열어 둔 책' : b.group || 'TXT'}</span><span>{b.paragraphs.length.toLocaleString()} 문단</span></span>
        </button>)}
      </div>
      {!shown.length && <div style={{ ...muted, textAlign: 'center', padding: '22px 0' }}>{query ? '검색한 책이 없습니다' : '아직 책장이 비어 있습니다'}</div>}
    </section>
  </div>
}
