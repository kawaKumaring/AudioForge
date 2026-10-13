import {useEffect,useSyncExternalStore} from 'react'
import {defaultWorkspaceLayout,validWorkspaceLayout,type WorkspaceLayout} from '../../shared/workspaceLayout'
let state:{layout:WorkspaceLayout;ready:boolean;saving:boolean;error:string}={layout:defaultWorkspaceLayout(),ready:false,saving:false,error:''}
const listeners=new Set<()=>void>()
let loading:Promise<void>|null=null
function publish(patch:Partial<typeof state>){state={...state,...patch};listeners.forEach(fn=>fn())}
export async function loadWorkspaceLayout():Promise<void>{
 if(loading)return loading
 loading=(async()=>{
  try{
   const r=await window.api.options.getWorkspaceLayout()
   if(!r.ok)throw Error(r.why||'메뉴 배치를 읽지 못했습니다')
   if(!validWorkspaceLayout(r.layout))throw Error('저장된 메뉴 배치를 확인해야 합니다')
   publish({layout:r.layout,ready:true,error:''})
  }catch(e){publish({ready:false,error:(e as Error).message})}
 })()
 try{await loading}finally{loading=null}
}
export async function saveWorkspaceLayout(layout:WorkspaceLayout):Promise<void>{
 if(!state.ready||state.saving)return
 if(!validWorkspaceLayout(layout)){publish({error:'메뉴 배치가 올바르지 않습니다'});return}
 publish({saving:true,error:''})
 try{const r=await window.api.options.setWorkspaceLayout(layout);if(!r.ok)throw Error(r.why||'메뉴 배치를 저장하지 못했습니다');publish({layout})}
 catch(e){publish({error:(e as Error).message})}
 finally{publish({saving:false})}
}
export function useWorkspaceLayout(){
 const value=useSyncExternalStore(fn=>{listeners.add(fn);return()=>{listeners.delete(fn)}},()=>state)
 useEffect(()=>{if(!state.ready)void loadWorkspaceLayout()},[])
 return value
}
