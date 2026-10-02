import { useMemo, useState } from 'react'
import { Icon, button, field, muted, primary, row } from './kit'
import { sortGroup, groupResume, type LibBook } from '../../shared/readerLibrary'

/** 서재의 책 — 규칙은 shared/readerLibrary(묶음 차례·이어 읽기·원본 기록). */
export type LibraryBook = LibBook
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

/** 작품 묶음의 표지 — 책 2~3장이 살짝 겹친 모양. 맨 앞은 묶음 이름, 뒤 장은 그 묶음의 책 이름 색. */
export function ReaderStack({ name, books, compact = false }: { name: string; books: readonly LibraryBook[]; compact?: boolean }) {
  const back = sortGroup(books).slice(0, 2).map(b => b.name)
  return <div aria-hidden="true" style={{ position: 'relative', paddingTop: compact ? 7 : 10, paddingRight: compact ? 7 : 10 }}>
    {back.slice(0, books.length > 2 ? 2 : 1).map((n, i, all) => <div key={i} style={{ position: 'absolute', inset: 0, transform: `translate(${(all.length - i) * (compact ? 4 : 6)}px, ${-(all.length - i) * (compact ? 4 : 6) + (compact ? 7 : 10)}px) rotate(${(all.length - i) * 2}deg)`, opacity: .55 - i * .12, pointerEvents: 'none' }}>
      <ReaderCover name={n} compact={compact}/></div>)}
    <div style={{ position: 'relative' }}><ReaderCover name={name} compact={compact}/></div>
  </div>
}

export default function ReaderShelf({ books, active, busy, error, onAdd, onAddFolder, onOpen, onRemove, onDrop, view, grouped, onView, onGrouped, onGroup, onReorder, onUngroup, onCheckNew }: {
  books: LibraryBook[]; active: string; busy: boolean; error: string
  onAdd: () => void
  /** 폴더 가져오기(2026-10-03). */
  onAddFolder: () => void
  onOpen: (id: string) => void; onRemove: (ids: string[]) => Promise<void>
  /** 끌어 놓은 것 — 파일과 함께 폴더인지(같은 차례). */
  onDrop: (files: File[], dirs: boolean[]) => void
  /** 묶음 안 차례를 한 칸 옮긴다. */
  onReorder: (group: string, id: string, delta: -1 | 1) => Promise<void>
  /** 묶음 해제 — 책은 서재에 남는다(원본 파일도 그대로). */
  onUngroup: (group: string) => Promise<boolean>
  /** 원본 폴더에서 새 회차를 찾는다(사람이 누를 때만). */
  onCheckNew: (group: string) => void
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
  const [ungroupConfirm, setUngroupConfirm] = useState(false)
  const names = useMemo(() => Array.from(new Set(books.map(b => b.group).filter((g): g is string => !!g))).sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })), [books])
  const currentGroup = names.includes(inside) ? inside : ''
  const duplicateGroupName = renaming && groupName.trim() !== currentGroup && names.includes(groupName.trim())
  const shown = useMemo(() => {
    const found = books.filter(b => (!currentGroup || b.group === currentGroup) && `${b.name} ${b.group || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    if (currentGroup) return sortGroup(found)          // 묶음 안은 권·회차 차례(정리에서 앞/뒤로 바꾼다)
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
  const addFolder = <button data-testid="reader-add-folder" style={{ ...button, justifyContent: 'center' }} disabled={locked} onClick={onAddFolder}
    title="폴더 안의 TXT 를 작품 묶음으로 가져옵니다(하위 폴더 포함)"><Icon name="folder"/>폴더 가져오기</button>
  const add = <button data-testid="reader-add-text" className="reader-add-tile" style={{ ...button, flex: '1 1 170px', flexDirection: 'column', minHeight: current ? 150 : 214, gap: 15,
    background: 'var(--bg-base)', borderStyle: 'dashed', borderColor: dragging ? 'var(--accent-light)' : 'var(--border-subtle)', borderRadius: 16 }} disabled={locked} onClick={onAdd}>
    <span style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', background: 'var(--accent-glow)', color: 'var(--accent-light)', borderRadius: 16 }}><Icon name="plus" size={24}/></span>
    <strong style={{ fontSize: 15, color: 'var(--text-primary)' }}>{busy ? '책을 불러오는 중…' : '새 책 가져오기'}</strong>
    <span style={muted}>TXT 파일·폴더를 끌어 놓거나 선택</span>
  </button>
  return <div data-testid="reader-library-dialog" className="reader-view-enter" onDragOver={e => { e.preventDefault(); setDragging(true) }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
    onDrop={e => {
      e.preventDefault(); e.stopPropagation(); setDragging(false)
      if (locked) return
      const items = Array.from(e.dataTransfer.items).filter(i => i.kind === 'file')
      onDrop(Array.from(e.dataTransfer.files), items.map(i => !!(i as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.()?.isDirectory))
    }}
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
      <div style={{ flex: '1 1 170px', display: 'grid', gap: 8 }}>{add}{addFolder}</div>
    </div>}
    <section style={{ display: 'grid', gap: 18 }}>
      {currentGroup && <div data-testid="reader-group-crumb" style={{ ...row, gap: 8, position: 'sticky', top: 0, zIndex: 3, margin: '-4px -4px 0', padding: '8px 4px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
        <button data-testid="reader-group-back" style={button} aria-label="내 서재로 돌아가기" title="내 서재로 돌아가기" onClick={() => { setInside(''); setSelected([]); setRenaming(false); setQuery(''); setUngroupConfirm(false) }}><Icon name="back"/></button>
        <nav aria-label="위치" style={{ ...row, gap: 6, minWidth: 0, flex: '1 1 160px', fontSize: 13 }}>
          <button style={{ ...button, border: 'none', background: 'transparent', padding: '4px 2px', color: 'var(--text-muted)' }} onClick={() => { setInside(''); setSelected([]); setRenaming(false); setQuery(''); setUngroupConfirm(false) }}>내 서재</button>
          <span aria-hidden="true" style={muted}>›</span>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{currentGroup}</strong>
          <span style={muted}>{books.filter(b => b.group === currentGroup).length}권</span>
        </nav>
        <button data-testid="reader-group-check" style={button} disabled={locked} title="원본 폴더에서 새로 생긴 회차를 찾아 가져옵니다" onClick={() => onCheckNew(currentGroup)}><Icon name="reset"/>새 파일 확인</button>
        <button data-testid="reader-group-ungroup" style={{ ...button, color: ungroupConfirm ? 'var(--rose)' : undefined }} disabled={locked}
          title="묶음만 풉니다 — 책은 서재에 남고 원본 파일도 그대로입니다"
          onClick={async () => { if (!ungroupConfirm) { setUngroupConfirm(true); return } ; if (await onUngroup(currentGroup)) { setInside(''); setUngroupConfirm(false) } }}>
          <Icon name="folder"/>{ungroupConfirm ? '정말 풀기' : '묶음 해제'}</button>
      </div>}
      <div style={{ ...row, gap: 12 }}>
        <h2 style={{ fontSize: 16, margin: 0, overflowWrap: 'anywhere' }}>{currentGroup ? '권·회차' : '내 책장'} <span style={{ ...muted, marginLeft: 7 }}>{currentGroup ? shown.length : books.length}</span></h2>
        <input aria-label="서재 검색" data-testid="reader-library-search" placeholder="책 제목 검색" value={query}
          onChange={e => { setQuery(e.target.value); setConfirm(false) }} style={{ ...field, marginLeft: 'auto', flex: '0 1 220px', width: 160 }}/>
        {!currentGroup && <select aria-label="책 정렬" value={sort} onChange={e => setSort(e.target.value)} style={{ ...field, fontSize: 12 }}><option value="added">추가 순</option><option value="name">제목 순</option></select>}
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
        {currentGroup && <div style={{ ...row, width: '100%' }}>
          <span style={muted}>차례</span>
          <button data-testid="reader-move-up" style={button} disabled={locked || picked.length !== 1 || shown[0]?.id === picked[0]} title="한 칸 앞으로" onClick={() => void onReorder(currentGroup, picked[0], -1)}><Icon name="prev"/>앞으로</button>
          <button data-testid="reader-move-down" style={button} disabled={locked || picked.length !== 1 || shown.at(-1)?.id === picked[0]} title="한 칸 뒤로" onClick={() => void onReorder(currentGroup, picked[0], 1)}>뒤로<Icon name="next"/></button>
        </div>}
        <button style={{ ...button, color: 'var(--rose)' }} data-testid="reader-library-remove" title="원본 TXT 파일은 유지합니다" disabled={locked || !picked.length}
          onClick={async () => { if (!confirm) { setConfirm(true); return }; setRemoving(true); try { await onRemove(picked); setSelected([]); setConfirm(false) } finally { setRemoving(false) } }}>
          <Icon name="trash"/>{removing ? '정리 중…' : confirm ? '목록에서 빼기' : '선택 정리'}</button>
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: view === 'list' ? '1fr' : `repeat(auto-fill, minmax(${view === 'compact' ? 100 : 145}px, 1fr))`, gap: view === 'list' ? 8 : view === 'compact' ? '18px 14px' : '24px 20px' }}>
        {groupedNames.map(name => {
          const members = books.filter(b => b.group === name)
          const resume = groupResume(members)
          return <div key={`group:${name}`} data-testid="reader-group-tile" style={{ display: 'flex', flexDirection: view === 'list' ? 'row' : 'column', alignItems: view === 'list' ? 'center' : 'stretch', gap: 8, minWidth: 0,
            padding: view === 'list' ? '8px 10px 8px 4px' : 0, background: view === 'list' ? 'var(--bg-card)' : 'transparent', borderRadius: 10 }}>
            <button data-testid="reader-book-group" aria-label={`${name} 작품 열기`} title={`${name} — ${members.length}권 묶음 열기`} className="reader-book-tile" disabled={locked}
              onClick={() => { setInside(name); setQuery(''); setSelected([]); setUngroupConfirm(false) }}
              style={{ display: view === 'list' ? 'flex' : 'grid', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: view === 'list' ? 6 : 0, font: 'inherit', color: 'inherit', cursor: 'pointer', borderRadius: 10 }}>
              {view === 'list' ? <Icon name="folder"/> : <ReaderStack name={name} books={members} compact={view === 'compact'}/>}
              <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                <span style={muted}>{members.length}권 묶음</span>
              </span>
            </button>
            {resume && <button data-testid="reader-group-resume" style={{ ...button, fontSize: 11, padding: '5px 9px', justifyContent: 'center' }} disabled={locked}
              title={`이어 읽기 — ${resume.name}`} aria-label={`${name} 이어 읽기`} onClick={() => onOpen(resume.id)}><Icon name="play" size={12}/>이어 읽기</button>}
          </div>
        })}
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
