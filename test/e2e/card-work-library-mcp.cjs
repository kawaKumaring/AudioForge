const assert=require('node:assert/strict');const {McpClient}=require('../../tools/mcp/client.cjs');
(async()=>{
 const c=new McpClient();await c.start();const call=async(name,args={})=>{const r=await c.call(name,args);if(r.isError)throw Error(r.text);return r.json};let checks=0;
 const ev=code=>call('js_eval',{code});const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('확인',label)};
 try{
  await call('app_start',{build:'never',width:1100,height:840,prep:'test'});
  const tone=await call('test_input',{kind:'tone',seconds:4,freq:220});
  await ev(`(async()=>{
    const opts=await window.api.options.get();await window.api.settings.set('outputRoot',opts.dataDir);await window.api.settings.set('cardAutoSave',false);
    const path=${JSON.stringify(tone.path)},now=Date.now();const works=[];
    for(let i=0;i<8;i++){
      const card={id:'library-card-'+i,label:['첫 장면 대사','늦은 밤 이야기','새로운 시작','차분한 안내'][i%4],sourcePath:path,sourceName:'검사용 소리',sourceDuration:4,text:'검사용 대사입니다. 저장한 내용을 확인합니다.',settings:{engine:'minimax-h3',h3Direction:'차분하고 또렷하게 말한다',speed:1,pitch:0,reference:'auto'},takes:Array.from({length:i%3},(_,j)=>({id:'take-'+i+'-'+j,path,text:'검사용 대사입니다.',createdAt:now-j,sourcePath:path,sourceName:'검사용 소리',sourceDuration:4,settings:{},applied:{}})),adoptedId:null};
      const saved=await window.api.cards.saveInput(card);if(!saved.ok)throw Error(saved.why);card.contentPath=saved.path;works.push({cards:[card],joins:{},savedAt:now-i*3600000});
    }
    await window.api.works.write('cards','current',null);await window.api.works.write('cards','kept',works);
    const drafts={};for(let i=0;i<10;i++)drafts['draft-'+i]={sourcePath:path,ttsText:'옛 작업 대사 '+i+'입니다.',speakers:{},updatedAt:new Date(now-i*7200000).toISOString()};await window.api.settings.set('workDrafts',{drafts});return true;
  })()`);
  await call('app_mode',{mode:'tts'});
  await call('ui_wait',{code:'!!document.querySelector("[data-testid=import-legacy]")',timeoutMs:10000});
  const open=await call('ui_click',{target:'testid:import-legacy'});check(open.clicked,'통합 불러오기 열기');
  check((await call('ui_wait',{code:'document.querySelectorAll(".af-work-library-row").length===18',timeoutMs:10000})).met,'카드·옛 기록 18개가 같은 카드형 목록');
  check(await ev('Array.from(document.querySelectorAll(".af-work-library-row")).every(e=>getComputedStyle(e).borderRadius==="11px")'),'목록 전체 모양 통일');
  await call('ui_screenshot',{savePath:'card-storage-library-wide.png'});
  check((await call('ui_click',{target:'testid:work-library-details',index:0})).clicked,'내용 보기');
  check((await call('ui_wait',{code:'document.querySelector("dialog[open]")?.textContent.includes("검사용 대사입니다")',timeoutMs:10000})).met,'외부에 저장한 대사가 내용 보기에 표시');
  await call('ui_screenshot',{savePath:'card-storage-content-wide.png'});
  await call('ui_key',{keys:'Escape'});
  await call('window_resize',{width:760,height:700});
  check(await ev('(()=>{const d=document.querySelector("dialog[open]");return !!d&&d.scrollWidth<=d.clientWidth})()'),'좁은 창 대화상자 가로 넘침 없음');
  await call('ui_screenshot',{savePath:'card-storage-library-small.png'});
  await call('ui_click',{target:'testid:work-library-select',index:0});
  await call('ui_click',{target:'testid:work-library-select',index:8});
  check(await ev('document.querySelector("[data-testid=work-library-remove-selected]").textContent.includes("2")'),'새 작업과 옛 작업 함께 선택');
  await call('ui_click',{target:'testid:work-library-remove-selected'});
  check(await ev('document.querySelector("[data-testid=work-library-remove-confirm]").textContent.includes("음원과 따로 저장한")'),'삭제 범위 확인');
  await call('ui_click',{target:'testid:work-library-remove-confirmed'});
  check((await call('ui_wait',{code:'document.querySelectorAll(".af-work-library-row").length===16',timeoutMs:10000})).met,'선택한 두 기록만 제거');
  await call('ui_click',{target:'testid:work-library-select-all'});
  await call('ui_click',{target:'testid:work-library-remove-selected'});
  await call('ui_click',{target:'testid:work-library-remove-confirmed'});
  check((await call('ui_wait',{code:'document.querySelectorAll(".af-work-library-row").length===0',timeoutMs:10000})).met,'전체 선택 일괄 제거');
  check(require('node:fs').existsSync(tone.path),'검사용 원본 소리 유지');
  const errors=await call('errors');console.log(JSON.stringify({checks,errors}));
 }finally{await c.call('app_stop');await c.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
