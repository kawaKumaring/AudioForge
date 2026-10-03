const {McpClient}=require('../../tools/mcp/client.cjs');
(async()=>{const c=new McpClient();await c.start();try{
 // ★ui_click 은 대상이 없어도 오류로 끝나지 않는다(clicked:false) — 그대로 두면 없는 단추를 누른 검사가 통과한다(2026-10-03 확인). 실패로 본다.
 const call=async(n,a={})=>{const r=await c.call(n,a);console.log(n,r.text.slice(0,3500));if(r.isError)throw Error(r.text);if(n==='ui_click'&&r.json&&r.json.clicked===false)throw Error('누를 대상 없음: '+a.target);return r.json};
 const check=async(code)=>{const r=await call('ui_wait',{code,timeoutMs:8000});if(!r.met)throw Error('FAILED '+code)};
 await call('app_start',{width:1100,height:820});await call('app_mode',{mode:'reader'});
 const paths=[];for(let i=1;i<=8;i++){const f=await call('test_input',{kind:'text',name:`달빛 도서관 ${i}권.txt`,content:Array.from({length:24},(_,j)=>`${i}권 ${j+1}장. 문을 열자 오래된 책의 향기가 바람을 타고 전해졌다. 서가 끝에서 작은 불빛이 흔들렸다.`).join('\n')});paths.push(f.path)}
 await call('dialog_queue',{kind:'open',answers:[paths]});await call('ui_click',{target:'testid:reader-add-text'});
 await check('window.__readerStore.getState().books.length===8');
 await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-library-after.png'});
 await call('ui_set',{target:'testid:reader-library-search',value:'3권'});
 await check('document.querySelectorAll("[data-testid=reader-library-book]").length===1');
 await call('ui_click',{target:'testid:reader-library-book'});
 await call('ui_click',{target:'testid:reader-find'});
 await call('ui_set',{target:'testid:reader-find-input',value:'3권 12장.'});
 await check('document.querySelectorAll("[data-testid=reader-find-result]").length===1');
 await call('ui_click',{target:'testid:reader-find-result'});
 await check('window.__readerStore.getState().books.find(b=>b.id===window.__readerStore.getState().active).position===11');
 await call('ui_click',{target:'testid:reader-library'});
 await call('dialog_queue',{kind:'open',answers:[[paths[2]]]});await call('ui_click',{target:'testid:reader-add-text'});
 await check('window.__readerStore.getState().books.length===8 && document.querySelector("[data-testid=reader-notice]").textContent.includes("이미")');
 await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-after.png'});
 await call('ui_click',{target:'testid:reader-voice'});
 await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-voice-after.png'});
 await call('ui_click',{target:'testid:voice-source-reference'});
 await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-reference-after.png'});
 await call('ui_click',{target:'testid:reader-voice-file'});
 await check('document.querySelector("[data-testid=reader-voice-file]")!==null');
 await call('ui_key',{keys:'Escape'});
 await call('ui_click',{target:'testid:reader-library'});await call('ui_click',{target:'testid:reader-library-manage'});
 await call('ui_click',{target:'testid:reader-library-book',index:0});await call('ui_click',{target:'testid:reader-library-book',index:1});
 await call('ui_click',{target:'testid:reader-library-remove'});
 await check('window.__readerStore.getState().books.length===8');
 await call('ui_click',{target:'testid:reader-library-remove'});await check('window.__readerStore.getState().books.length===6');
 await call('window_resize',{width:800,height:660});
 await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-library-narrow.png'});
 // 정리를 마치면 '취소' 로 정리 모드를 나온다 — 정리 중에는 '이어서 읽기' 가 보이지 않는다.
 await call('js_eval',{code:'(()=>{const b=[...document.querySelectorAll("[data-testid=reader-library-dialog] button")].find(x=>x.textContent.trim()==="취소");if(!b)throw Error("취소 단추 없음");b.click();return true})()'});
 await call('ui_click',{target:'testid:reader-resume'});
 await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-narrow.png'});
 // 조작 막대가 **보일 때만** 잰다 — 숨은 막대(0×0)끼리 견주면 늘 참이다.
 await check('(()=>{const f=document.querySelector("[data-testid=reader-controls]").getBoundingClientRect(); const p=document.querySelector("[data-testid=reader-play]").getBoundingClientRect(); return f.width>0&&p.width>0&&f.bottom<=innerHeight+1&&Math.abs(f.x+f.width/2-p.x-p.width/2)<2})()');
 await call('ui_click',{target:'testid:reader-library'});
 const extra=await call('test_input',{kind:'text',name:'새로 열린 책.txt',content:'새로 추가한 책이 바로 열립니다.\n둘째 문단입니다.'});
 await call('ui_drop_files',{target:'testid:reader-library-dialog',paths:[extra.path]});
 await check('window.__readerStore.getState().books.length===7 && window.__readerStore.getState().books.find(b=>b.id===window.__readerStore.getState().active)?.name==="새로 열린 책"');
 await call('app_restart');await call('app_mode',{mode:'reader'});await check('window.__readerStore.getState().books.length===7');
 await call('errors');
 console.log('PASS: multi import, search, duplicate, confirm removal, restart persistence, voice panes');
 }finally{await c.call('app_stop');await c.close()}})().catch(e=>{console.error(e);process.exitCode=1});

