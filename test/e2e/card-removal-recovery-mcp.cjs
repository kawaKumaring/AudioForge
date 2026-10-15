const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {pathToFileURL}=require('node:url');const {McpClient}=require('../../tools/mcp/client.cjs');
async function lockFile(file){
 const quoted=file.replace(/'/g,"''");const code=`$s=[IO.File]::Open('${quoted}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('READY');[Console]::In.ReadLine()|Out-Null;$s.Dispose()`;
 const p=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 await new Promise((resolve,reject)=>{let output='';const t=setTimeout(()=>{p.kill();reject(Error('검사용 파일 잠금 시간 초과'))},10000);p.once('error',e=>{clearTimeout(t);reject(e)});p.stdout.on('data',b=>{output+=b;if(output.includes('READY')){clearTimeout(t);resolve()}});p.once('exit',code=>{clearTimeout(t);if(!output.includes('READY'))reject(Error('파일 잠금 실패 '+code))})});
 return async()=>{if(p.exitCode!==null)return;await new Promise(resolve=>{const t=setTimeout(()=>{p.kill();resolve()},5000);p.once('close',()=>{clearTimeout(t);resolve()});p.stdin.end('\n')})};
}
(async()=>{
 const c=new McpClient();await c.start();let checks=0,unlock=null;
 const call=async(name,args={})=>{const r=await c.call(name,args);if(r.isError)throw Error(r.text);return r.json};const ev=code=>call('js_eval',{code});const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('확인',label)};
 try{
  await call('app_start',{build:'never',prep:'test'});const tone=await call('test_input',{kind:'tone',seconds:3,freq:200}),opts=await ev('window.api.options.get()');
  await ev(`window.api.settings.set('outputRoot',${JSON.stringify(opts.dataDir)})`);
  const out=path.join(opts.dataDir,'검사 출력');fs.mkdirSync(out);const audio=path.join(out,'synthesized.wav');fs.copyFileSync(tone.path,audio);
  fs.writeFileSync(path.join(out,'session.json'),JSON.stringify({mode:'tts',tracks:[{path:audio}]}));fs.writeFileSync(path.join(out,'synthesized.h3.json'),'공유 생성 기록 보존');
  const raw={id:'removal-card',label:'삭제 검사',sourcePath:tone.path,sourceName:'검사 원본',sourceDuration:3,text:'검사용 대사',settings:{},takes:[{id:'take-1',path:audio,text:'검사용 대사',createdAt:1,sourcePath:tone.path,sourceName:'검사 원본',sourceDuration:3,settings:{},applied:{}}],adoptedId:'take-1'};
  let r=await ev(`window.api.cards.saveInput(${JSON.stringify(raw)})`);raw.contentPath=r.path;
  const historical={...raw,takes:raw.takes.map(t=>({...t,id:'old-take'})),adoptedId:'old-take'};
  const other={...raw,id:'other-card',label:'유지 카드',text:'',contentPath:'',takes:[],adoptedId:null};
  await ev(`window.api.works.writeBatch('cards',[{key:'current',data:{cards:${JSON.stringify([raw,other])},joins:{},savedAt:1}},{key:'kept',data:[{cards:${JSON.stringify([historical,other])},joins:{},savedAt:2}]}])`);
  const dir=path.join(opts.dataDir,'works','cards'),names=fs.readdirSync(dir).filter(n=>/^(current|kept)\./.test(n)),before=names.map(n=>fs.readFileSync(path.join(dir,n),'utf8'));
  unlock=await lockFile(audio);
  r=await ev(`window.api.cards.remove(${JSON.stringify(raw)},true,[])`);check(!r.ok,'실제 잠긴 음원 때문에 제거가 실패함');
  check(fs.existsSync(audio)&&fs.existsSync(raw.contentPath),'실패 뒤 음원과 대사 파일 모두 복원');
  check(names.every((n,i)=>fs.readFileSync(path.join(dir,n),'utf8')===before[i]),'실패 뒤 현재·보관함 모두 원래 바이트');
  check(!fs.readdirSync(out).some(n=>n.endsWith('.pending')),'실패 복구 뒤 임시 음원 없음');
  await unlock();unlock=null;
  r=await ev(`window.api.cards.remove(${JSON.stringify(raw)},true,[])`);check(r.ok&&!r.cleanupPending,'잠금 해제 후 다시 제거 성공');
  check(!fs.existsSync(audio)&&!fs.existsSync(raw.contentPath)&&!fs.readdirSync(out).filter(n=>n.endsWith('.input.json')).some(n=>JSON.parse(fs.readFileSync(path.join(out,n),'utf8')).cardId===raw.id),'확정 뒤 음원과 서로 다른 과거 생성본 입력 모두 제거');
  r=await ev("window.api.works.list('cards')");check(r.records.every(record=>(Array.isArray(record.data)?record.data:[record.data]).every(w=>w.cards.length===1&&w.cards[0].id==='other-card')),'모든 저장 버전에서 같은 카드 제거·다른 카드 유지');
  check(fs.existsSync(tone.path)&&fs.existsSync(path.join(out,'session.json'))&&fs.existsSync(path.join(out,'synthesized.h3.json')),'참조 원본과 공유 생성 기록 보존');
  // 새로운 격리 자료로 중단된 삭제와 복구 충돌 안내를 확인한다.
  fs.copyFileSync(tone.path,audio);raw.id='recovery-card';r=await ev(`window.api.cards.saveInput(${JSON.stringify(raw)})`);raw.contentPath=r.path;
  await ev(`window.api.works.writeBatch('cards',[{key:'current',data:{cards:${JSON.stringify([raw,other])},joins:{},savedAt:3}},{key:'kept',data:[]}])`);
  const files=fs.readdirSync(out).filter(n=>/\.input\.json$/.test(n)).map(n=>path.join(out,n)).filter(p=>JSON.parse(fs.readFileSync(p,'utf8')).cardId===raw.id);files.push(audio);
  const after=names.map(name=>{const x=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));const prune=w=>({...w,cards:w.cards.filter(card=>card.id!==raw.id)});x.data=Array.isArray(x.data)?x.data.map(prune):prune(x.data);return {name,body:JSON.stringify(x)}});
  const script=`import {writeWorkTransaction} from ${JSON.stringify(pathToFileURL(path.join(process.cwd(),'src/main/services/work-transaction.ts')).href)};writeWorkTransaction(${JSON.stringify(dir)},${JSON.stringify(after)},undefined,{removals:${JSON.stringify(files)},onStep:step=>{if(step==='staged')process.exit(81)}});`;
  const child=cp.spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',script],{encoding:'utf8',timeout:10000});check(child.status===81,'파일 이동 뒤 실제 하위 프로세스 종료');
  const conflict=files[0];fs.writeFileSync(conflict,'다른 새 파일');await call('app_mode',{mode:'tts'});
  check((await call('ui_wait',{code:'!!document.querySelector("[data-testid=card-removal-recovery]")',timeoutMs:10000})).met,'복구 충돌을 카드 화면에서 안내');
  check(await ev('document.querySelector("[data-testid=import-legacy]").disabled'),'복구 전 후속 작업 조작 차단');
  fs.renameSync(conflict,conflict+'.preserved');await call('ui_click',{target:'testid:card-removal-retry'});
  check((await call('ui_wait',{code:'!document.querySelector("[data-testid=card-removal-recovery]")',timeoutMs:10000})).met,'다시 정리로 복구 완료');
  check(fs.existsSync(audio)&&fs.existsSync(conflict)&&fs.readFileSync(conflict+'.preserved','utf8')==='다른 새 파일','기존 음원·입력 복원과 충돌 파일 보존');
  r=await ev("window.api.works.list('cards')");check(!r.error&&r.records.some(x=>!Array.isArray(x.data)&&x.data.cards.some(card=>card.id==='recovery-card')),'복구 뒤 카드 정보 다시 읽기');
  const errors=await call('errors');check(errors.count===0,'화면 오류 없음');console.log(JSON.stringify({checks,errors}));
 }finally{if(unlock)await unlock();await c.call('app_stop');await c.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
