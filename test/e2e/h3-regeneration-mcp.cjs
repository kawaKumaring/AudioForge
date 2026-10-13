// 실제 GPU 생성 전용. 파일별 사용자 승인 없이 실행하지 않는다. 캡처·모의 응답 없음.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),cp=require('child_process');
const {McpClient}=require('../../tools/mcp/client.cjs');
const argv=process.argv.slice(2),arg=k=>argv[argv.indexOf(k)+1];
const lifecycleOnly=argv.includes('--lifecycle-only'),runCount=lifecycleOnly?1:2;
if(!argv.includes('--approve-reference')||!argv.includes('--reference')||!argv.includes('--out'))throw Error('참조·저장 폴더와 파일별 승인 플래그 필요');
const reference=path.resolve(arg('--reference')),out=path.resolve(arg('--out'));
if(fs.existsSync(out))throw Error('기존 자료 보호: 새 저장 폴더를 지정하세요');
fs.mkdirSync(out,{recursive:true});process.env.AF_E2E_H3_IDLE_MS='20000';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const gpu=()=>cp.execFileSync('nvidia-smi',['--query-gpu=memory.used,memory.free,utilization.gpu','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true}).trim();
const text='오늘은 하루 종일 비가 와서 조금 우울했는데, 저녁에 친구가 찾아와서 따뜻한 차를 마시며 이야기를 나누니까 기분이 정말 좋아졌어요.';
const report={mode:'실제 앱·H3, 검사 미리 준비 꺼짐',reference_sha256:hash(reference),text,runs:[],checks:[],gpu_before:gpu()};
const save=()=>fs.writeFileSync(path.join(out,'measurement.json'),JSON.stringify(report,null,2));
const client=new McpClient();
async function call(tool,args={}){const r=await client.call(tool,args);if(r.isError)throw Error(r.text);return r.json??r.text}
const ev=code=>call('js_eval',{code,userApproved:true});
const check=(value,label)=>{assert.ok(value,label);report.checks.push(label);save();console.log('확인:',label)};
const click=async target=>{const r=await call('ui_click',{target});check(r.clicked,'누름: '+target);return r};
const wait=async(code,timeoutMs=10000)=>{const r=await call('ui_wait',{code,timeoutMs});check(r.met,'조건: '+code)};
(async()=>{await client.start();save();try{
  await call('app_start',{build:'never',visible:false,width:1200,height:860});await call('app_mode',{mode:'tts'});
  await call('dialog_queue',{kind:'open',answers:[reference],userApproved:true});await click('.source-dropzone');
  await wait('!!document.querySelector("[data-testid=generation-card]")');
  await click('[aria-label="1번 카드 고급 옵션"]');await wait('!!document.querySelector("#card-reference-engine")');
  await call('ui_set',{target:'#card-reference-engine',value:'minimax-h3'});
  const q=await call('ui_query',{within:'dialog[open]',text:'적용',limit:3});await click(q.items.find(i=>i.tag==='button'&&i.text==='적용').ref);
  await call('ui_set',{target:'testid:card-script',value:text});await wait('document.querySelector("[data-testid=card-generate]")?.disabled===false');
  await ev('(()=>{window.__h3Results=[];window.__h3Failures=[];window.api.audio.onResult(r=>window.__h3Results.push(r));window.api.audio.onError(e=>window.__h3Failures.push(e));return true})()');
  for(let index=0;index<runCount;index++){
    const start=performance.now();await click('testid:card-generate');console.log(index?'재생성 시작':'첫 생성 시작');
    for(let n=0;n<16;n++){
      const r=await call('ui_wait',{code:'window.__synthesisCards.getState().job===null',timeoutMs:30000});
      if(r.met)break;
      console.log('처리 중:',await ev('window.__synthesisCards.getState().job?.message'));
      if(n===15)throw Error('실제 생성 상한 초과');
    }
    const state=await ev('(()=>{const s=window.__synthesisCards.getState();return {takes:s.cards[0].takes,results:window.__h3Results,failures:window.__h3Failures}})()');
    if(state.takes.length!==index+1){report.failed_request=state;save()}
    check(state.takes.length===index+1,'새 생성본 등록 '+(index+1));
    check(state.failures.length===0,'실제 오류 없음 '+(index+1));
    const take=state.takes[index],result=state.results[index],meta=result.metadata,detail=meta.h3_requests[0];
    check(meta.actual_engine==='minimax-h3'&&meta.actual_device==='cuda','실제 H3 CUDA '+(index+1));
    check(detail.reference_sha256===report.reference_sha256,'참조 동일 '+(index+1));
    check(detail.condition_cache_hit===(index===1),'조건 캐시 판정 '+(index+1));
    check(index===0||detail.model_reused,'모델 재사용');
    check(detail.settings.steps===16&&detail.settings.canvas===256&&detail.settings.sampler==='res_multistep','품질 설정 유지');
    const dest=path.join(out,index?'재생성.wav':'첫생성.wav');fs.copyFileSync(take.path,dest);
    fs.copyFileSync(path.join(path.dirname(take.path),'session.json'),path.join(out,`session-${index+1}.json`));
    report.runs.push({path:dest,original:take.path,sha256:hash(dest),elapsed_click_to_result_seconds:(performance.now()-start)/1000,metadata:meta});save();
    console.log('생성 완료',index+1,report.runs[index].elapsed_click_to_result_seconds,detail.stage_seconds);
  }
  if(!lifecycleOnly){
    check(report.runs[0].metadata.seed!==report.runs[1].metadata.seed,'새 seed');
    check(report.runs[0].sha256!==report.runs[1].sha256,'생성 음성 자체 재사용 안 함');
  }
  await wait('document.querySelector("[data-testid=card-result] [data-testid=take-wave]")?.dataset.state==="ready"');
  await call('ui_click',{target:'testid:take-play',waitMs:1400});const playing=await call('audio_now');
  check(playing.some(a=>!a.paused&&a.time>0),'새 결과 실제 재생');
  await click('testid:take-play');const stopped=await call('audio_now');report.playback={playing,stopped};save();
  console.log('미사용 메모리 해제 대기');await new Promise(r=>setTimeout(r,23000));
  report.gpu_idle=gpu();const logs=await call('logs',{source:'app',grep:'H3 상주 실행기',limit:30});report.lifecycle=logs;
  check(logs.items.some(l=>l.includes('한동안 안 씀')),'미사용 실행기 내려감');
  await click('testid:card-generate');await wait('window.__synthesisCards.getState().job?.percent>=25',30000);
  await new Promise(r=>setTimeout(r,5000));const cancel=performance.now();await click('testid:card-stop');
  await wait('window.__synthesisCards.getState().job===null',10000);
  report.cancel_seconds=(performance.now()-cancel)/1000;
  check(await ev(`window.__synthesisCards.getState().cards[0].takes.length===${runCount}`),'취소 시 기존 생성본 보존');
  report.gpu_after_cancel=gpu();check(hash(reference)===report.reference_sha256,'참조 원본 불변');
  report.status='완료';save();
}catch(e){report.status='실패';report.error=e.message;save();throw e}
finally{await call('app_stop').catch(()=>{});await client.close()}})().catch(e=>{console.error(e);process.exitCode=1});
