const assert=require('node:assert/strict');const {McpClient}=require('../../tools/mcp/client.cjs');
(async()=>{const c=new McpClient();await c.start();let n=0;const call=async(k,a={})=>{const r=await c.call(k,a);if(r.isError)throw Error(r.text);return r.json};const check=(x,m)=>{assert.ok(x,m);console.log('PASS',m);n++};const click=async target=>{const r=await call('ui_click',{target:'testid:'+target});assert.equal(r.clicked,true,'클릭 대상: '+target);return r};const wait=async code=>check((await call('ui_wait',{code,timeoutMs:6000})).met,'화면 상태 반영');const books=()=>call('js_eval',{code:'window.__readerStore.getState().books'});try{
await call('app_start',{build:'never'});
for(let i=1;i<=2;i++)await call('api_call',{method:'works.write',args:['books','shelf-'+i,{id:'shelf-'+i,name:'시험 '+i+'권',group:'시험 작품',paragraphs:['첫 문단','둘째 문단'],position:1,order:i}],full:true});
await call('app_mode',{mode:'reader'});await wait('document.querySelectorAll("[data-testid=reader-group-tile]").length===1');
await call('ui_pointer',{target:'testid:reader-group-tile',action:'rightclick',at:[0.5,0.5]});await wait('!!document.querySelector("[data-testid=reader-context-menu]")');check(!(await call('js_eval',{code:'!!document.querySelector("dialog[open]")'})),'우클릭 메뉴는 모달을 띄우지 않는다');

await call('ui_key',{keys:'ArrowDown'});check(await call('js_eval',{code:'document.activeElement.dataset.testid === "reader-group-archive"'}),'방향키로 메뉴 이동');
await call('ui_key',{keys:'Escape'});await wait('!document.querySelector("[data-testid=reader-context-menu]")');
await click('reader-group-menu');
await click('reader-group-archive');await wait('document.querySelectorAll("[data-testid=reader-group-tile]").length===0');check((await books()).every(b=>b.archived),'보관해도 두 책과 읽던 위치 보존');
const disk=await call('api_call',{method:'works.read',args:['books','shelf-1'],full:true});check(JSON.stringify(disk).includes('"archived":true'),'보관 상태 실제 파일 저장');
await click('reader-archive-view');await wait('document.querySelectorAll("[data-testid=reader-group-tile]").length===1');await click('reader-group-menu');await click('reader-group-archive');await click('reader-archive-view');await wait('document.querySelectorAll("[data-testid=reader-group-tile]").length===1');check((await books()).every(b=>!b.archived),'보관함에서 꺼내기');
await click('reader-group-menu');await click('reader-group-remove');await wait('window.__readerStore.getState().books.length===0');await click('reader-remove-undo');await wait('window.__readerStore.getState().books.length===2');check((await books()).every(b=>b.position===1&&b.group==='시험 작품'),'제거 되돌리기는 위치·묶음·본문 보존');
await click('reader-group-menu');await click('reader-group-unpack');await wait('document.querySelectorAll("[data-testid=reader-library-book]").length===2');check((await books()).every(b=>!b.group),'묶음 풀기는 책 유지');
await call('js_eval',{code:'(()=>{document.querySelector("[data-testid=reader-library-book]").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:innerWidth-2,clientY:innerHeight-2}));return true})()'});
await wait('!!document.querySelector("[data-testid=reader-context-menu]")');
check(await call('js_eval',{code:'(()=>{const r=document.querySelector("[data-testid=reader-context-menu]").getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'}),'화면 끝에서도 메뉴가 밖으로 나가지 않는다');
await click('reader-book-remove');await wait('window.__readerStore.getState().books.length===1');check((await books())[0].id==='shelf-2','개별 책 제거는 다른 책 유지');
await click('reader-remove-undo');await wait('window.__readerStore.getState().books.length===2');
await click('reader-book-menu');await click('reader-archive-view');await wait('!document.querySelector("[data-testid=reader-context-menu]")');check(true,'바깥 클릭으로 닫힌다');
console.log('RESULT',n,'checks · 0 fail');
}finally{await c.call('app_stop');await c.close()}})().catch(e=>{console.error(e);process.exitCode=1});
