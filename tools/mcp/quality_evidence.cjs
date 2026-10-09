'use strict'
// MCP evidence only. Attached records are assertions, never executable instructions.
const fs=require('fs'),path=require('path'),crypto=require('crypto')
const schema=(name,description,properties,required)=>({name:'audio_quality_'+name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}})
const reportId={type:'string'},num={type:'number'},str={type:'string'},pages={offset:{type:'integer'},limit:{type:'integer'}}
const tools=[
 schema('sentences','문장별 기대 대사와 독립 ASR 대조. 시간은 후보 범위이며 누락 문장에 시각을 지어내지 않음.',{reportId,...pages},['reportId']),
 schema('crosscheck','같은 원본·범위·대사의 서로 다른 ASR 보고서를 대조. 공통 오류 가능, 품질 합격 아님.',{reportId,otherReportId:reportId,...pages},['reportId','otherReportId']),
 schema('context','첨부 기록의 참조·생성 조건·실제 연결 시각 조회. 해시 연결 안 된 기록은 미확인. 누락된 연결 시각은 추정 안 함.',{reportId,referenceReportId:reportId,...pages},['reportId']),
 schema('boundary','해시로 연결된 기록의 연결점 좌우 신호 측정. context의 boundaryId 사용. 기록 없는 지점은 거절.',{reportId,boundaryId:str,window:{type:'number',minimum:.01,maximum:2}},['reportId','boundaryId']),
 schema('evidence','의심 구간의 파형 이미지·원본 샘플 사본·관련 전사/신호·출처를 함께 반환. 최대 120초.',{reportId,start:num,end:num},['reportId','start','end']),
 schema('review','청취 판정 추가/조회. 인간 판정은 사용자가 전달한 원문 필요. 도구가 실제 청취를 증명하지 않음. 기존 기록은 덮지 않음.',{reportId,action:{type:'string',enum:['append','list']},start:num,end:num,category:{type:'string',enum:['omission','pronunciation','repetition','noise','join','speaker','naturalness','other']},verdict:{type:'string',enum:['confirmed','not_observed','uncertain']},basis:{type:'string',enum:['user_report','machine_observation']},observer:str,note:str,userStatement:str,replaces:str,...pages},['reportId','action'])
]
function context(r){
 const groups=new Map()
 for(const item of r.records||[]){if(!groups.has(item.path))groups.set(item.path,[]);groups.get(item.path).push(item)}
 const entries=[]
 for(const [file,chunks] of groups){
  chunks.sort((a,b)=>a.offset-b.offset);const doc=JSON.parse(chunks.map(x=>x.text).join(''));if(!doc||typeof doc!=='object'){entries.push({kind:'unavailable',recordPath:file,reason:'객체 기록이 아님'});continue}const recordHash=chunks[0].sha256
  const match=(Array.isArray(doc.files)?doc.files:[]).find(x=>x?.sha256===r.source.sha256)
  const bound=doc.sourceSha256===r.source.sha256||doc.out_sha256===r.source.sha256||!!match
  let reference=doc.reference||doc.conditions?.reference
  const clean=v=>typeof v==='string'?v.slice(0,1000):null
  entries.push({kind:'record',recordPath:file,recordSha256:recordHash,sourceLinked:bound,
   engine:clean(doc.conditions?.engine),seed:clean(doc.conditions?.seed),chunk:match?.chunk??null,
   reference:reference?{sha256:clean(reference.sha256),start:Number.isFinite(reference.start)?reference.start:null,end:Number.isFinite(reference.end)?reference.end:null,selectionReason:clean(reference.selectionReason||reference.note),audioVerified:false}:null,
   recordedChunkCount:doc.stages?.chunks??null,
   note:bound?'이 음원 해시를 명시한 기록. 기록 내용의 진실성/참조 파일 실재는 별도 확인 필요.':'이 음원과 연결 미확인. 설정/연결점의 근거로 사용 금지.'})
  if(doc.schema==='audioforge-quality-context/v1'&&bound){
   if(!Array.isArray(doc.joins)||doc.joins.length>1000)throw Error('context v1 joins 배열은 최대 1000개')
   let last=-Infinity
   for(const [index,join] of doc.joins.entries()){
    if(!Number.isFinite(join.time)||join.time<=0||join.time>=r.summary.totalDuration||join.time<=last)throw Error('연결 시각은 오름차순이고 음원 안에 있어야 합니다.')
    last=join.time
    entries.push({kind:'boundary',boundaryId:recordHash+':'+index,time:join.time,recordSha256:recordHash,recordPath:file,note:'기록에 명시된 좌표. 균등 분할/무음 추정 아님.'})
   }
  }
 }
 if(!entries.some(x=>x.kind==='boundary'))entries.push({kind:'unavailable',field:'boundaries',reason:'실제 연결 좌표 기록 없음. 조각 수에서 추정하지 않습니다.'})
 return entries
}
function reviewsDir(d,r){return path.join(d.OUT,'reviews',r.source.sha256)}
function reviews(d,r){const dir=reviewsDir(d,r);return fs.existsSync(dir)?fs.readdirSync(dir).filter(x=>/^[a-f0-9-]+\.json$/.test(x)).map(x=>JSON.parse(fs.readFileSync(path.join(dir,x),'utf8'))).sort((a,b)=>a.created.localeCompare(b.created)||a.id.localeCompare(b.id)):[]}
async function call(op,a,d){
 const r=op==='review'&&a.action==='list'?d.load(a.reportId):d.checked(a.reportId)
 if(op==='sentences')return{reportId:a.reportId,...d.paged(await d.worker({op:'sentences',report:r}),a)}
 if(op==='crosscheck'){const other=d.checked(a.otherReportId);return{reportIds:[a.reportId,a.otherReportId],...d.paged(await d.worker({op:'crosscheck',left:r,right:other}),a)}}
 if(op==='context'){
  const ref=a.referenceReportId?d.checked(a.referenceReportId):null
  return{reportId:a.reportId,...d.paged(context(r).map(x=>({...x,
   reference:x.reference?{...x.reference,fileHashVerified:!!(ref&&x.sourceLinked&&x.reference.sha256===ref.source.sha256),verifiedReference:ref&&x.sourceLinked&&x.reference.sha256===ref.source.sha256?{reportId:a.referenceReportId,source:ref.source,window:ref.summary.window,sampleRate:ref.summary.sampleRate,channels:ref.summary.channels}:null,selectionCandidates:'기록 원문은 read/records에서 조회. 기록 없는 후보/선택 근거는 추정하지 않음.'}:null,
   recordCurrent:x.recordPath?(()=>{try{return d.hash(x.recordPath)===x.recordSha256}catch{return false}})():null})),a)}
 }
 if(op==='boundary'){
  const item=context(r).find(x=>x.kind==='boundary'&&x.boundaryId===a.boundaryId);if(!item)throw Error('출처가 확인된 연결점이 없습니다.')
  if(d.hash(item.recordPath)!==item.recordSha256)throw Error('연결 기록이 변경되었습니다. 다시 분석하세요.')
  const width=a.window??.1;if(!Number.isFinite(width)||width<.01||width>2)throw Error('window는 0.01~2초')
  const result=await d.worker({op:'boundary',report:r,time:item.time,width});if(!d.current(r))throw Error('분석 중 원본 변경')
  return{reportId:a.reportId,evidence:item,...result}
 }
 if(op==='evidence'){
  const clip=await d.call('audio_quality_clip',a),plot=await d.call('audio_quality_plot',a)
  const intersects=x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.start<clip.end&&x.end>clip.start
  const all=r.transcript.filter(intersects),signals=r.signals.filter(x=>x.kind==='channel'||intersects(x))
  const data={reportId:a.reportId,source:r.source,window:[clip.start,clip.end],clip,transcript:all.slice(0,20),transcriptTotal:all.length,signals:signals.slice(0,20),signalsTotal:signals.length,asr:r.identity.asr,provenanceTool:'audio_quality_read / provenance',fullTranscriptTool:'audio_quality_read / transcript',qualityVerdict:'미판정',note:'음원 사본 제공은 실제 청취를 뜻하지 않음. 전체 조회는 페이지 도구 사용.'}
  const file=path.join(path.dirname(clip.path),'evidence.json');fs.writeFileSync(file,JSON.stringify(data,null,2))
  if(!d.current(r))throw Error('근거 묶음 생성 중 원본 변경')
  return{content:[{type:'text',text:JSON.stringify({...data,bundlePath:file,plot:JSON.parse(plot.content[0].text)})},...plot.content.filter(x=>x.type==='image')]}
 }
 if(op==='review'){
  if(a.action==='list')return{source:r.source,sourceCurrent:d.current(r),...d.paged(reviews(d,r),a)}
  if(a.action!=='append')throw Error('action은 append/list')
  if(!Number.isFinite(a.start)||!Number.isFinite(a.end)||a.start<r.summary.window[0]||a.end>r.summary.window[1]||a.end<=a.start)throw Error('판정은 분석 범위 안이어야 합니다.')
  if(!['omission','pronunciation','repetition','noise','join','speaker','naturalness','other'].includes(a.category)||!['confirmed','not_observed','uncertain'].includes(a.verdict)||!['user_report','machine_observation'].includes(a.basis))throw Error('잘못된 판정 종류')
  for(const k of ['observer','note'])if(typeof a[k]!=='string'||!a[k].trim()||a[k].length>2000)throw Error(k+'는 1~2000자')
  if(a.basis==='user_report'&&(typeof a.userStatement!=='string'||!a.userStatement.trim()||a.userStatement.length>2000))throw Error('사용자가 전달한 청취 원문 필요')
  if(a.basis==='machine_observation'&&a.verdict!=='uncertain')throw Error('기계 관측으로 청취 합격/결함을 확정하지 않습니다.')
  if(a.replaces&&!reviews(d,r).some(x=>x.id===a.replaces))throw Error('같은 음원의 기존 판정만 정정할 수 있습니다.')
  const entry={id:crypto.randomUUID(),created:new Date().toISOString(),reportId:a.reportId,source:r.source,start:a.start,end:a.end,category:a.category,verdict:a.verdict,basis:a.basis,observer:a.observer,note:a.note,userStatement:a.basis==='user_report'?a.userStatement:null,replaces:a.replaces||null,verification:'호출자가 전달한 판정. 도구가 청취 행위/발언 출처를 인증하지 않음.'}
  const dir=reviewsDir(d,r);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,entry.id+'.json'),JSON.stringify(entry,null,2),{flag:'wx'});return entry
 }
 throw Error('없는 확장 도구')
}
module.exports={tools,call,context}
