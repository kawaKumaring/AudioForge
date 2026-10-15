const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {McpClient}=require('../../tools/mcp/client.cjs');
(async()=>{
 const c=new McpClient();await c.start();let checks=0;
 const call=async(name,args={})=>{const r=await c.call(name,args);if(r.isError)throw Error(r.text);return r.json};
 const ev=code=>call('js_eval',{code});const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('확인',label)};
 try{
  await call('app_start',{build:'never',prep:'test'});
  const opts=await ev('window.api.options.get()');await ev(`window.api.settings.set('outputRoot',${JSON.stringify(opts.dataDir)})`);
  await ev(`(async()=>{const c={id:'integrity-card',label:'첫 작업',sourcePath:'synthetic-reference.wav',sourceName:'검사 원본',sourceDuration:3,text:'검사용 대사',settings:{},takes:[],adoptedId:null};const saved=await window.api.cards.saveInput(c);if(!saved.ok)throw Error(saved.why);c.contentPath=saved.path;window.__integrityWork={cards:[c],joins:{},savedAt:1};return true})()`);
  let r=await ev('window.api.works.writeBatch("cards",[{key:"current",data:window.__integrityWork},{key:"kept",data:[]}])');check(r.ok,'현재·보관함 묶음 저장');
  r=await ev('window.api.works.list("cards")');check(!r.error&&r.records.find(x=>x.key==='current').data.cards[0].text==='검사용 대사','외부 입력 복원');
  const dir=path.join(opts.dataDir,'works','cards'),kept=fs.readdirSync(dir).find(n=>n.startsWith('kept.')&&n.endsWith('.json')),current=fs.readdirSync(dir).find(n=>n.startsWith('current.')&&n.endsWith('.json'));
  const original=fs.readFileSync(path.join(dir,current),'utf8');check(!original.includes('검사용 대사'),'내부 메타에 대사 원문 없음');
  const held=path.join(dir,kept+'.held');fs.renameSync(path.join(dir,kept),held);fs.mkdirSync(path.join(dir,kept));
  try{r=await ev('window.api.works.writeBatch("cards",[{key:"current",data:{...window.__integrityWork,savedAt:99}},{key:"kept",data:[]}])');check(!r.ok,'두 번째 대상 실패를 성공으로 보고하지 않음');check(fs.readFileSync(path.join(dir,current),'utf8')===original,'묶음 실패 때 첫 기록 그대로');}
  finally{fs.rmdirSync(path.join(dir,kept));fs.renameSync(held,path.join(dir,kept))}
  r=await ev('window.api.works.writeBatchSync("cards",[{key:"current",data:window.__integrityWork},{key:"kept",data:[]}])');check(r.ok,'종료 동기 통로도 묶음 저장');
  const before=fs.readFileSync(path.join(dir,current),'utf8');let changed=JSON.parse(before);changed.key='다른 열쇠';fs.writeFileSync(path.join(dir,current),JSON.stringify(changed));
  try{r=await ev('window.api.works.read("cards","current")');check(!!r.error&&!r.record,'손상 기록을 없는 기록으로 꾸미지 않음')}
  finally{fs.writeFileSync(path.join(dir,current),before)}
  const heldDir=dir+'.held';fs.renameSync(dir,heldDir);fs.writeFileSync(dir,'폴더 읽기 실패 검사용');
  try{r=await ev('window.api.works.list("cards")');check(!!r.error,'폴더 읽기 실패를 빈 목록과 구분')}
  finally{fs.unlinkSync(dir);fs.renameSync(heldDir,dir)}
  r=await ev('window.api.works.list("cards")');check(!r.error&&r.records.length===2,'복구 후 다시 읽기 정상');
  r=await ev('window.api.works.writeBatch("cards",[{key:"current",data:null},{key:"current",data:null}])');check(!r.ok,'중복 열쇠 거절');
  const errors=await call('errors');check(errors.count===0,'화면 오류 없음');console.log(JSON.stringify({checks,errors}));
 }finally{await c.call('app_stop');await c.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
