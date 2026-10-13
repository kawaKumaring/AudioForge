import {WORKSPACE_GROUPS,moveWorkspace,stepWorkspace,type WorkspaceId,type WorkspaceGroup} from '../../shared/workspaceLayout'
import {useWorkspaceLayout,saveWorkspaceLayout,loadWorkspaceLayout} from '../lib/workspaceLayout'
import {useEffect,useState,type ReactNode,type DragEvent} from 'react'
import { useAppStore } from '@/stores/app.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import type { SeparationMode } from '../../shared/types'

type WorkspaceInfo = { label: string; description: string; icon: ReactNode }
const icon = (paths: ReactNode) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>

export const WORKSPACES: Record<SeparationMode, WorkspaceInfo> = {
  reader: { label: '낭독', description: '책을 펼치고 원하는 위치부터 듣습니다.', icon: icon(<><path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z"/></>) },
  'dialogue-rebuild': { label: '대화 구간 편집', description: '수정한 대화 구간을 저장합니다.', icon: icon(<path d="M4 6h16M4 12h16M4 18h10"/>) },
  music: { label: '음악 분리', description: '보컬과 악기를 나누고, 필요한 소리를 골라 저장하세요.', icon: icon(<><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>) },
  conversation: { label: '대화 분리', description: '대화 속 목소리를 나누고, 화자별 구간을 확인하세요.', icon: icon(<><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a5 5 0 0 1 10 0v3M17 4a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 4v3"/></>) },
  transcribe: { label: '텍스트 추출', description: '음성을 글로 옮긴 뒤, 내용을 다듬고 번역하세요.', icon: icon(<><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/></>) },
  split: { label: '트랙 분할', description: '파형을 들으며 구간을 나누고, 각각의 파일로 저장하세요.', icon: icon(<><path d="M12 3v18M3 8h5M3 12h5M3 16h5M16 8h5M16 12h5M16 16h5"/></>) },
  tts: { label: '음성 합성', description: '목소리를 고르고 대본을 작성해, 원하는 음성으로 완성하세요.', icon: icon(<><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>) },
  dub: { label: '노래 변환', description: '원곡의 목소리를 다른 목소리로 바꿉니다. 번역 가창은 후속 개발입니다.', icon: icon(<><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></>) },
  lab: { label: '실험실', description: '개발 중인 기능을 확인하세요.', icon: icon(<><path d="M9 3h6M10 3v6L5 19h14L14 9V3"/></>) }
}

const DRAG_KIND='application/x-audioforge-workspace'
export default function ModeSelector() {
  const { mode, setMode, status, errorInfo } = useAppStore()
  const {layout,ready,saving,error}=useWorkspaceLayout()
  const [editing,setEditing]=useState(false),[dragged,setDragged]=useState<WorkspaceId|null>(null),[target,setTarget]=useState('')
  const disabled = status === 'processing' || isCancelCleanupBusy(status) || !!errorInfo?.childAlive
  const arrangeBlocked=disabled||saving||!ready
  useEffect(()=>{if(arrangeBlocked){setDragged(null);setTarget('')}},[arrangeBlocked])
  const accept=(e:DragEvent,group:WorkspaceGroup,before?:WorkspaceId)=>{
    if(arrangeBlocked||!dragged)return
    e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';setTarget(group+':'+(before||'end'))
  }
  const drop=(e:DragEvent,group:WorkspaceGroup,before?:WorkspaceId)=>{
    e.preventDefault();e.stopPropagation()
    if(!arrangeBlocked&&dragged&&e.dataTransfer.getData(DRAG_KIND)===dragged)void saveWorkspaceLayout(moveWorkspace(layout,dragged,group,before))
    setDragged(null);setTarget('')
  }
  return <nav aria-label="작업 선택" style={{display:'flex',flexDirection:'column',gap:24}}>
    <div style={{display:'flex',justifyContent:'flex-end'}}><button data-testid="workspace-arrange" type="button" disabled={disabled||saving} aria-pressed={editing} title="메뉴를 끌어 순서와 분류를 바꿉니다. 새 콘텐츠 만들기에 둔 작업은 개발 중으로 표시합니다." onClick={()=>setEditing(v=>!v)} className="btn btn-ghost" style={{fontSize:10,padding:'4px 8px'}}>{editing?'배치 완료':'배치 편집'}</button></div>
    {WORKSPACE_GROUPS.map(group=><section key={group.id} data-testid={'workspace-group-'+group.id} onDragOver={e=>accept(e,group.id)} onDrop={e=>drop(e,group.id)}>
      <div style={{padding:'0 12px',marginBottom:9,fontSize:11,fontWeight:500,color:'var(--text-muted)'}}>{group.label}</div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {layout[group.id].map(id=>{
          const item=WORKSPACES[id],active=mode===id
          return <div key={id} data-testid={'workspace-position-'+id} draggable={!arrangeBlocked}
            onDragStart={e=>{if(arrangeBlocked){e.preventDefault();return}e.dataTransfer.setData(DRAG_KIND,id);e.dataTransfer.effectAllowed='move';setDragged(id)}}
            onDragEnd={()=>{setDragged(null);setTarget('')}} onDragOver={e=>accept(e,group.id,id)} onDrop={e=>drop(e,group.id,id)}
            style={{display:'flex',alignItems:'center',gap:2,borderTop:target===group.id+':'+id?'2px solid var(--accent-light)':'2px solid transparent',opacity:dragged===id ? 0.5 : 1}}>
            <button type="button" data-testid={`mode-${id}`} aria-current={active?'page':undefined} onClick={()=>{if(!dragged)setMode(id)}} disabled={disabled}
              className="workspace-nav-item" title={disabled?'진행 중인 작업이 끝나면 이동할 수 있습니다.':item.description+' · 끌어서 메뉴 배치 이동'}
              style={{display:'flex',alignItems:'center',gap:9,flex:1,minWidth:0,padding:'11px 10px',borderRadius:9,border:`1px solid ${active?'var(--border-accent)':'transparent'}`,background:active?'var(--accent-glow)':'transparent',color:active?'var(--text-primary)':'var(--text-secondary)',fontFamily:'inherit',fontSize:13,fontWeight:active?600:400,textAlign:'left',cursor:disabled?'not-allowed':'pointer',opacity:disabled&&!active ? 0.45 : 1}}>
              <span style={{display:'flex',flexShrink:0,color:active?'var(--accent-light)':'inherit'}}>{item.icon}</span>
              <span style={{minWidth:0,flex:1}}><span style={{display:'block',whiteSpace:'nowrap'}}>{item.label}</span>{group.id==='create'&&<span data-testid={'workspace-development-'+id} style={{display:'block',fontSize:9,lineHeight:1.4,color:'var(--text-muted)',marginTop:2}}>개발 중</span>}</span>
            </button>
            {editing&&<div style={{display:'grid',gap:2}}><button type="button" data-testid={'workspace-up-'+id} disabled={arrangeBlocked} aria-label={item.label+' 위로 이동'} title="위로 이동 · 분류 경계에서도 이동합니다" className="btn btn-ghost" style={{padding:'1px 5px',fontSize:10}} onClick={()=>void saveWorkspaceLayout(stepWorkspace(layout,id,-1))}>↑</button><button type="button" data-testid={'workspace-down-'+id} disabled={arrangeBlocked} aria-label={item.label+' 아래로 이동'} title="아래로 이동 · 분류 경계에서도 이동합니다" className="btn btn-ghost" style={{padding:'1px 5px',fontSize:10}} onClick={()=>void saveWorkspaceLayout(stepWorkspace(layout,id,1))}>↓</button></div>}
          </div>
        })}
        {(editing||dragged)&&<div data-testid={'workspace-drop-'+group.id} onDragOver={e=>accept(e,group.id)} onDrop={e=>drop(e,group.id)} style={{minHeight:30,display:'grid',placeItems:'center',fontSize:10,color:'var(--text-muted)',border:'1px dashed '+(target===group.id+':end'?'var(--accent-light)':'var(--border-subtle)'),borderRadius:7,background:target===group.id+':end'?'var(--accent-glow)':'transparent'}}>여기에 놓기</div>}
      </div>
    </section>)}
    {saving&&<span role="status" style={{fontSize:10,color:'var(--text-muted)'}}>배치 저장 중…</span>}
    {error&&<div role="alert" style={{fontSize:10,color:'var(--rose)',lineHeight:1.6}}>{error}{!ready&&<button type="button" className="btn btn-ghost" onClick={()=>void loadWorkspaceLayout()} style={{fontSize:10}}>다시 읽기</button>}</div>}
  </nav>
}
