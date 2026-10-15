const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {McpClient}=require('../../tools/mcp/client.cjs');
(async()=>{
 const c=new McpClient();await c.start();let checks=0;
 const call=async(name,args={})=>{const r=await c.call(name,args);if(r.isError)throw Error(r.text);return r.json};
 const ev=code=>call('js_eval',{code});const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('확인',label)};
 try{
  await call('app_start',{build:'never',prep:'test'});const opts=await ev('window.api.options.get()');
  const dir=path.join(opts.dataDir,'works','books');fs.mkdirSync(path.dirname(dir),{recursive:true});fs.writeFileSync(dir,'읽기 실패 검사용');
  await call('app_mode',{mode:'reader'});
  check((await call('ui_wait',{code:'document.body.textContent.includes("서재를 읽지 못했습니다")',timeoutMs:10000})).met,'서재 읽기 실패 안내');
  fs.unlinkSync(dir);
  await ev('(()=>{window.__readerStore.setState({books:[{id:"memory-book",name:"검사용 책",paragraphs:["첫 문단입니다.","다음 문단입니다."],position:1}],active:"memory-book"});return true})()');
  await ev('(async()=>{await new Promise(r=>setTimeout(r,900));return true})()');
  check(!fs.existsSync(dir)||!fs.readdirSync(dir).some(n=>n.endsWith('.json')),'읽기 실패 뒤 메모리 책으로 저장본을 덮지 않음');
  await call('app_mode',{mode:'music'});await call('app_mode',{mode:'reader'});
  await ev('(async()=>{await new Promise(r=>setTimeout(r,150));window.__readerStore.setState(s=>({books:s.books.map(b=>({...b,position:0}))}));await new Promise(r=>setTimeout(r,900));return true})()');
  check(fs.existsSync(dir)&&fs.readdirSync(dir).some(n=>n.startsWith('memory-book.')),'정상 다시 읽기 뒤 저장 재개');
  const errors=await call('errors');check(errors.count===0,'화면 오류 없음');console.log(JSON.stringify({checks,errors}));
 }finally{await c.call('app_stop');await c.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
