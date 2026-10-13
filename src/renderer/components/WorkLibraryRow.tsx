import {Action,Icon,button,muted,type IconName} from './kit'
export default function WorkLibraryRow({title,summary,icon='history',onDetails,onLoad,onReveal,onRemove,testId,selected,onSelect,disabled=false}:{title:string;summary:string;icon?:IconName;onDetails:()=>void;onLoad:()=>void;onReveal?:()=>void;onRemove?:()=>void;testId?:string;selected?:boolean;onSelect?:(checked:boolean)=>void;disabled?:boolean}){
 return <article data-testid={testId||'work-library-row'} className="af-work-library-row" style={{display:'flex',alignItems:'center',gap:12,padding:'14px 15px',background:'var(--bg-base)',border:'1px solid var(--border-subtle)',borderRadius:11,minWidth:0}}>
  {onSelect&&<input type="checkbox" data-testid="work-library-select" aria-label={`${title} 선택`} checked={selected===true} disabled={disabled} onChange={e=>onSelect(e.target.checked)} style={{width:16,height:16,flexShrink:0,accentColor:"var(--accent)"}}/>}
  <span aria-hidden="true" style={{display:'flex',alignItems:'center',justifyContent:'center',width:27,flexShrink:0,color:'var(--accent-light)'}}><Icon name={icon} size={19}/></span>
  <div style={{flex:'1 1 180px',minWidth:0}}>
   <div title={title} style={{fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{title}</div>
   <div style={{...muted,marginTop:4,lineHeight:1.45}}>{summary}</div>
  </div>
  <div className="af-work-library-actions" style={{display:'flex',alignItems:'center',gap:7,flexShrink:0}}>
   {onReveal&&<Action icon="folder" label={`${title} 파일 위치`} title="생성 음원 또는 대사 파일 위치를 엽니다" disabled={disabled} onClick={onReveal}/>}
   {onRemove&&<Action icon="trash" label={`${title} 기록 제거`} disabled={disabled} onClick={onRemove}/>}
   <button type="button" data-testid="work-library-details" style={{...button,fontSize:12}} disabled={disabled} onClick={onDetails}>내용 보기</button>
   <button type="button" data-testid="work-library-load" style={{...button,fontSize:12,color:'var(--accent-light)',borderColor:'var(--border-default)'}} disabled={disabled} onClick={onLoad}>불러오기</button>
  </div>
  <style>{`@media(max-width:700px){.af-work-library-row{flex-wrap:wrap}.af-work-library-actions{margin-left:39px;flex-wrap:wrap;max-width:calc(100% - 39px)}}`}</style>
 </article>
}
