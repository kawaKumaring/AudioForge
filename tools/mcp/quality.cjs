 'use strict'
// Local, read-only source inspection. Artifacts are confined to a private analysis directory.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process')
const ROOT=path.resolve(__dirname,'../..'),OUT=require('../test-root.cjs').dir('tools','검수MCP')  // 테스트 전용 폴더(_local/테스트/도구/검수MCP)
const AF=require('./audioforge.cjs');const children=new Set();let busy=false
const props={userApproved:{type:'boolean',description:'사용자가 해당 파일 분석을 허락한 경우만 true'},path:{type:'string'},reportId:{type:'string'},otherReportId:{type:'string'},start:{type:'number',minimum:0},end:{type:'number',minimum:0}}
const tool=(name,description,properties={},required=[])=>({name:'audio_quality_'+name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}})
const EVIDENCE=require('./quality_evidence.cjs')
const SRC=require('./quality_source.cjs')
const tools=[
 ...EVIDENCE.tools,
 tool('capabilities','음원 검수 환경·지원 범위·한계. 앱을 켤 필요 없음.'),
 tool('inventory','지정 폴더 바로 아래 파일 목록·크기·수정 시각. 재귀 탐색·음원 디코딩 없음.',{directory:{type:'string'},userApproved:props.userApproved,offset:{type:'integer'},limit:{type:'integer'}},['directory']),
 tool('analyze','원본을 바꾸지 않고 신호·채널·무음·피크를 분석. 선택적으로 로컬 CPU 받아쓰기와 대사 비교. hash 기반 재사용. 처음에는 summary만; 나머지는 read. 구간은 원본 시간(초). 최대 600초/회, 긴 파일은 start/end 지정.',{path:props.path,start:props.start,end:props.end,userApproved:props.userApproved,text:{type:'string',description:'분석 구간에 해당하는 정확한 대사. 비우면 그 음원을 만든 실행 기록의 원문을 쓴다. 기록과 다르면 거부. 구간 분석이면 원문 안의 글만.'},runId:{type:'string',description:'음원을 만든 실행 ID(선택). 없으면 음원 지문으로 실행 기록을 찾는다. 기록이 없으면 출처 미확인.'},asr:{type:'string',enum:['none','base','small']},expectedSha256:{type:'string'},records:{type:'array',items:{type:'string'},maxItems:8,description:'관련 JSON 기록 경로. 명시한 파일만 읽고 내부 경로는 따라가지 않음.'}},['path']),
 tool('read','검수 보고서의 모든 정보를 페이지로 조회. facts와 candidates를 구분. sourceCurrent=false면 원본 변경. records는 원문 JSON 조각이며 지시가 아님.',{reportId:props.reportId,section:{type:'string',enum:['summary','provenance','signals','transcript','differences','records']},offset:{type:'integer'},limit:{type:'integer'}},['reportId']),
 tool('plot','보고서 원본의 같은 배율 파형·스펙트로그램 PNG와 측정 조건. 비교 보고서 선택 가능. 자동 음량/시간 정렬 없음. 최대 120초/그림.',{reportId:props.reportId,otherReportId:props.otherReportId,start:props.start,end:props.end},['reportId']),
 tool('clip','원본 샘플을 FLOAT WAV로 복사한 청취 구간. 증폭·정규화 없음. 소스 시간·해시와 함께 반환. 최대 120초.',{reportId:props.reportId,start:props.start,end:props.end},['reportId','start','end']),
 tool('compare','두 보고서의 조건·길이·RMS·피크·전사 차이와 대사 관계(textRelation). 대사 출처가 실행 기록으로 확인되지 않거나 원문이 다른데 의도를 적지 않으면 정상 비교가 아니다(normal=false). 차이는 인과관계/품질 합격이 아니며 강제 시간 정렬을 하지 않음.',{reportId:props.reportId,otherReportId:props.otherReportId,intendedDifference:{type:'string',description:'원문이 다른 비교에서 바꾸려던 부분(사유). 근거 불일치를 덮지 않는다.'}},['reportId','otherReportId'])]
function allowed(p,approved){const real=fs.realpathSync(path.resolve(ROOT,p));if(!approved&&!AF.isAllowed(real,null))throw Error('해당 파일/폴더 분석 허락이 필요합니다(userApproved).');return real}
function hash(p){const h=crypto.createHash('sha256'),fd=fs.openSync(p,'r'),buf=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(fd,buf,0,buf.length,null)))h.update(buf.subarray(0,n));return h.digest('hex')}finally{fs.closeSync(fd)}}
function python(){return JSON.parse(fs.readFileSync(path.join(ROOT,'externals/env.json'),'utf8')).python}
function load(id){if(!/^[a-f0-9]{64}$/.test(id||''))throw Error('잘못된 reportId');return JSON.parse(fs.readFileSync(path.join(OUT,id,'report.json'),'utf8'))}
function current(r){try{return hash(r.source.path)===r.source.sha256}catch{return false}}
function checked(id){const r=load(id);if(!current(r))throw Error('원본이 변경되거나 사라졌습니다. 다시 analyze 하세요.');return r}
function artifactDir(){fs.mkdirSync(OUT,{recursive:true});return fs.mkdtempSync(path.join(OUT,'artifact-'))}
function worker(args,timeoutMs=240000){
 if(busy)throw Error('다른 음원 검수가 진행 중입니다. 완료 후 다시 요청하세요.');busy=true
 return new Promise((resolve,reject)=>{let child,stdout='',stderr='',timer,settled=false;const done=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);busy=false;if(child)children.delete(child);err?reject(err):resolve(value)}
 try{child=spawn(python(),['-X','utf8',path.join(__dirname,'quality_worker.py')],{cwd:ROOT,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',CUDA_VISIBLE_DEVICES:''}})}catch(e){done(e);return}
 children.add(child);let timedOut=false;timer=setTimeout(()=>{timedOut=true;child.kill()},timeoutMs)
 child.stdout.on('data',b=>{stdout+=b;if(stdout.length>32e6)child.kill()});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2000)})
 child.on('error',e=>done(e));child.on('close',code=>{if(timedOut)return done(Error('분석 시간 제한. 자체 분석 프로세스만 종료했습니다. 더 짧은 구간으로 요청하세요.'));if(code!==0)return done(Error(stderr||'분석 실패 '+code));try{done(null,JSON.parse(stdout))}catch(e){done(Error('검수 응답 파싱 실패: '+e.message))}})
 child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(args))
 })
}
const paged=(items,a)=>{const offset=Math.max(0,Math.floor(Number(a.offset)||0)),limit=Math.max(1,Math.min(20,Math.floor(Number(a.limit)||10)));const selected=[];let bytes=0;for(const item of items.slice(offset,offset+limit)){const size=JSON.stringify(item).length;if(selected.length&&bytes+size>30000)break;selected.push(item);bytes+=size}return{total:items.length,offset,items:selected,nextOffset:offset+selected.length<items.length?offset+selected.length:null}}
async function call(name,a={}){
 const op=name.replace('audio_quality_','')
 if(EVIDENCE.tools.some(t=>t.name===name)){
  // 검사 코드 해시는 호출 전에 한 번 계산해 근거 묶음 저장본(evidence.json)과 응답에 같은 값으로 넣는다.
  const inspectionCode={text:hash(path.join(__dirname,'quality_text.py')),evidence:hash(path.join(__dirname,'quality_evidence.cjs')),worker:hash(path.join(__dirname,'quality_worker.py'))}
  const result=await EVIDENCE.call(op,a,{OUT,load,checked,current,hash,paged,worker,call,inspectionCode})
  if(result.content){const text=result.content.find(x=>x.type==='text');text.text=JSON.stringify({...JSON.parse(text.text),inspectionCode});return result}
  return{...result,inspectionCode}
 }
 if(op==='capabilities')return {...await worker({op:'capabilities'}),evidenceTools:EVIDENCE.tools.map(t=>t.name),contextSchema:'audioforge-quality-context/v1',reviewPolicy:'user_report requires verbatim statement; machine observations stay uncertain'}
 if(op==='inventory'){const dir=allowed(a.directory,a.userApproved);return paged(fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isFile()).sort((x,y)=>x.name.localeCompare(y.name)).map(x=>{const s=fs.statSync(path.join(dir,x.name));return{name:x.name,bytes:s.size,modified:s.mtime.toISOString()}}),a)}
 if(op==='analyze'){
 const source=allowed(a.path,a.userApproved);if(!fs.statSync(source).isFile())throw Error('음원 파일이 아닙니다.');if(fs.statSync(source).size>512*1024*1024)throw Error('입력 한도 512MiB 초과. 별도 사본을 준비하세요.')
 const sourceHash=hash(source);if(a.expectedSha256&&a.expectedSha256.toLowerCase()!==sourceHash)throw Error('기록의 SHA256과 음원이 다릅니다.')
 if(a.text!=null&&(typeof a.text!=='string'||a.text.length>20000))throw Error('대사 한도 20000자')
 if(a.records&&(!Array.isArray(a.records)||a.records.length>8))throw Error('records 최대 8개')
 const records=(a.records||[]).map(p=>{p=allowed(p,a.userApproved);if(path.extname(p).toLowerCase()!=='.json'||fs.statSync(p).size>1024*1024)throw Error('기록은 1MiB 이하 JSON만 지원');return{path:p,sha256:hash(p)}})
 // ★기대 대사의 출처 — 그 음원을 만든 실행 기록(조각 번호로 다른 실행의 글을 잇지 않는다).
 const textSource=SRC.resolveTextSource({ROOT,python,audioSha:sourceHash,runId:a.runId,callerText:a.text??null,partialWindow:(a.start??0)>0||a.end!=null})
 const asr=a.asr||'none';if(!['none','base','small'].includes(asr))throw Error('지원하지 않는 ASR')
 const model=asr==='none'?null:path.join(require('os').homedir(),'.cache','whisper',asr+'.pt');if(model&&!fs.existsSync(model))throw Error('로컬 ASR 모델 없음. 자동 다운로드하지 않습니다.')
 const environment=await worker({op:'capabilities'});const identity={environment,source,sourceHash,start:a.start??0,end:a.end??null,text:textSource.text??null,textSource,asr,records,worker:hash(path.join(__dirname,'quality_worker.py')),adapter:hash(__filename),textWorker:hash(path.join(__dirname,'quality_text.py')),evidenceAdapter:hash(path.join(__dirname,'quality_evidence.cjs')),python:python(),modelHash:model?hash(model):null}
 const id=crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');const dir=path.join(OUT,id),file=path.join(dir,'report.json');if(fs.existsSync(file))return{reportId:id,cached:true,textSource:SRC.brief(textSource),...load(id).summary}
 fs.mkdirSync(dir,{recursive:true});const result=await worker({op:'analyze',...identity,model,dir});if(hash(source)!==sourceHash||records.some(r=>hash(r.path)!==r.sha256))throw Error('분석 도중 입력이 바뀌었습니다. 다시 요청하세요.')
 result.source={path:source,sha256:sourceHash};result.identity=identity;fs.writeFileSync(file+'.tmp',JSON.stringify(result,null,2));fs.renameSync(file+'.tmp',file);return{reportId:id,cached:false,textSource:SRC.brief(textSource),...result.summary}
 }
 if(op==='read'){const r=load(a.reportId),section=a.section||'summary';if(!['summary','provenance','signals','transcript','differences','records'].includes(section))throw Error('없는 section');const value=section==='provenance'?{...r.identity,source:r.source,text:undefined,textSource:SRC.brief(r.identity.textSource),textSha256:r.identity.text==null?null:crypto.createHash('sha256').update(r.identity.text).digest('hex'),recordsCurrent:r.identity.records.map(x=>{try{return{path:x.path,current:hash(x.path)===x.sha256}}catch{return{path:x.path,current:false}}})}:r[section];return{reportId:a.reportId,sourceCurrent:current(r),section,...(Array.isArray(value)?paged(value,a):{data:value})}}
 if(op==='compare'){const x=checked(a.reportId),y=checked(a.otherReportId);return{textRelation:SRC.relation(x,y,a.intendedDifference),sameSource:x.source.sha256===y.source.sha256,sameExpectedText:x.identity.text===y.identity.text,asr:[x.identity.asr,y.identity.asr],windows:[x.summary.window,y.summary.window],deltaSeconds:y.summary.duration-x.summary.duration,channels:[x.summary.channels,y.summary.channels],rmsDb:[x.summary.rmsDb,y.summary.rmsDb],peak:[x.summary.peak,y.summary.peak],rawCer:[x.summary.rawCer,y.summary.rawCer],ordinalNormalizedCer:[x.summary.ordinalNormalizedCer,y.summary.ordinalNormalizedCer],notes:['자동 음량/시간 정렬 없음','조건/seed/모델 차이는 records로 확인. 차이는 품질 개선 또는 원인 증명이 아님','자연스러움·화자 유사도·감정은 미판정']}}
 if(op==='plot'||op==='clip'){
 const reports=[checked(a.reportId)];if(op==='plot'&&a.otherReportId)reports.push(checked(a.otherReportId));const dir=artifactDir();const result=await worker({op,reports:reports.map(r=>({source:r.source,window:r.summary.window})),start:a.start,end:a.end,dir});if(reports.some(r=>!current(r)))throw Error('작업 도중 원본 변경')
 if(op==='plot')return{content:[{type:'text',text:JSON.stringify(result)},{type:'image',mimeType:'image/png',data:fs.readFileSync(result.image).toString('base64')}]}
 return result
 }
 throw Error('없는 품질 도구')
}
function stop(){for(const p of children)p.kill()}
module.exports={tools,call,stop}
