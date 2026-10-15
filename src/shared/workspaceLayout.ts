/** 메뉴 배치가 사용자 판단의 개발 상태를 함께 소유한다. */
export const WORKSPACE_LAYOUT_KEY = 'workspaceLayout'
export const WORKSPACE_IDS = ['music','conversation','transcribe','split','tts','voiceedit','reader','dub'] as const
export type WorkspaceId = typeof WORKSPACE_IDS[number]
export type WorkspaceGroup = 'files' | 'create'
export interface WorkspaceLayout { version: 1; files: WorkspaceId[]; create: WorkspaceId[] }
export const WORKSPACE_GROUPS = [{id:'files',label:'파일에서 시작'},{id:'create',label:'새 콘텐츠 만들기'}] as const
export function defaultWorkspaceLayout(): WorkspaceLayout {
  return {version:1,files:['music','conversation','transcribe','split'],create:['tts','voiceedit','reader','dub']}
}
/**
 * 예전에 저장된 배치에 **새로 생긴 작업실만 빠져 있으면** 그것만 '새 콘텐츠 만들기' 끝에 덧붙인다(사용자가 정한 순서는 그대로).
 * ★2026-10-16 음성 편집 추가 때: 검사가 '모든 id 가 정확히 있어야' 해서, 새 작업실을 넣는 순간 예전 배치가
 *   '손상' 으로 거절되고 메뉴가 막혔을 것이다. 모르는 id·중복·잘못된 버전은 여전히 null(손상).
 */
export function migrateWorkspaceLayout(v:unknown):WorkspaceLayout|null {
  if(validWorkspaceLayout(v))return v
  if(!v || typeof v!=='object')return null
  const x=v as WorkspaceLayout
  if(x.version!==1 || !Array.isArray(x.files)||!Array.isArray(x.create))return null
  const ids=[...x.files,...x.create]
  if(!ids.every(isWorkspaceId) || new Set(ids).size!==ids.length)return null
  const next:WorkspaceLayout={version:1,files:[...x.files],create:[...x.create,...WORKSPACE_IDS.filter(id=>!ids.includes(id))]}
  return validWorkspaceLayout(next)?next:null
}
export function isWorkspaceId(v:unknown):v is WorkspaceId {return typeof v==='string' && (WORKSPACE_IDS as readonly string[]).includes(v)}
export function validWorkspaceLayout(v:unknown):v is WorkspaceLayout {
  if(!v || typeof v!=='object')return false
  const x=v as WorkspaceLayout
  if(x.version!==1 || !Array.isArray(x.files)||!Array.isArray(x.create))return false
  const ids=[...x.files,...x.create]
  return ids.length===WORKSPACE_IDS.length && ids.every(isWorkspaceId) && new Set(ids).size===ids.length
}
export function moveWorkspace(layout:WorkspaceLayout,id:WorkspaceId,group:WorkspaceGroup,before?:WorkspaceId):WorkspaceLayout {
  if(!validWorkspaceLayout(layout)||!isWorkspaceId(id)||(group!=='files'&&group!=='create'))throw Error('작업실 배치가 올바르지 않습니다')
  if(before===id)return layout
  const next:WorkspaceLayout={version:1,files:layout.files.filter(x=>x!==id),create:layout.create.filter(x=>x!==id)}
  const at=before?next[group].indexOf(before):-1
  next[group].splice(at<0?next[group].length:at,0,id)
  return next
}
export function stepWorkspace(layout:WorkspaceLayout,id:WorkspaceId,direction:-1|1):WorkspaceLayout {
  const group=layout.files.includes(id)?'files':'create',at=layout[group].indexOf(id)
  if(direction===-1){if(at>0)return moveWorkspace(layout,id,group,layout[group][at-1]);if(group==='create')return moveWorkspace(layout,id,'files');return layout}
  if(at<layout[group].length-1){const next=moveWorkspace(layout,layout[group][at+1],group,id);return next}
  if(group==='files')return moveWorkspace(layout,id,'create',layout.create[0])
  return layout
}
