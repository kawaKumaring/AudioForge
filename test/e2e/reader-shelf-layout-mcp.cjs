const assert = require('node:assert/strict');
const { McpClient } = require('../../tools/mcp/client.cjs');
(async () => {
 const c = new McpClient(); await c.start();
 try {
  const call = async (name,args={}) => {const r=await c.call(name,args);if(r.isError)throw Error(r.text);return r.json};
  const check = async code => {const r=await call('ui_wait',{code,timeoutMs:10000});assert.equal(r.met,true,code);console.log('PASS',code)};
  const rect = async testid => call('js_eval',{code:`(()=>{const r=document.querySelector('[data-testid="${testid}"]').getBoundingClientRect();return [r.y,r.height]})()`});
  const fixed = async (scroll,head,foot) => {
   await call('ui_scroll',{target:'testid:'+scroll,to:'top'});
   const h=await rect(head), f=await rect(foot);
   await call('ui_scroll',{target:'testid:'+scroll,to:'bottom'});
   assert.deepEqual(await rect(head),h,head+' moved');assert.deepEqual(await rect(foot),f,foot+' moved');
   console.log('PASS fixed',scroll,head,foot);
  };
  await call('app_start',{width:1100,height:820});await call('app_mode',{mode:'reader'});
  const files=[];for(let i=1;i<=16;i++)files.push((await call('test_input',{kind:'text',name:`별의 여행 ${String(i).padStart(2,'0')}권.txt`,content:Array.from({length:80},(_,j)=>`${i}권의 ${j+1}번째 문단. 달빛이 비치는 길을 따라 천천히 걸었다.`).join('\n')})).path);
  await call('dialog_queue',{kind:'open',answers:[files]});await call('ui_click',{target:'testid:reader-add-text'});
  await check('window.__readerStore.getState().books.length===16');
  await fixed('reader-shelf-scroll','reader-heading','reader-controls');
  await check('document.querySelector("[data-testid=reader-shelf-scroll]").scrollTop>0');
  await call('ui_scroll',{target:'testid:reader-shelf-scroll',to:'top'});
  await call('ui_click',{target:'testid:reader-library-manage'});
  await call('ui_click',{target:'testid:reader-library-book',index:0});await call('ui_click',{target:'testid:reader-library-book',index:1});
  await call('ui_set',{target:'testid:reader-group-name',value:'별의 여행'});await call('ui_click',{target:'testid:reader-group-apply'});
  await check('window.__readerStore.getState().books.filter(b=>b.group==="별의 여행").length===2');
  await call('ui_click',{target:'testid:reader-book-group'});
  await check('document.querySelectorAll("[data-testid=reader-library-book]").length===2');
  await call('ui_click',{target:'testid:reader-group-rename'});await call('ui_set',{target:'testid:reader-group-name',value:'별의 여행 시리즈'});await call('ui_click',{target:'저장',exact:true});
  await check('window.__readerStore.getState().books.filter(b=>b.group==="별의 여행 시리즈").length===2');
  await call('ui_click',{target:'testid:reader-view-list'});
  await call('ui_click',{target:'testid:reader-library-book',index:0});
  await fixed('reader-body','reader-heading','reader-controls');
  await call('ui_click',{target:'testid:reader-library'});
  await call('ui_click',{target:'testid:reader-view-compact'});
  await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-grouped-compact.png'});
  await call('ui_click',{target:'testid:reader-view-list'});
  await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-grouped-list.png'});
  await call('ui_wait',{code:'document.querySelector("[data-testid=reader-view-list]")?.getAttribute("aria-pressed")==="true"',timeoutMs:5000});
  await call('app_restart');await call('app_mode',{mode:'reader'});
  await check('window.__readerStore.getState().books.filter(b=>b.group==="별의 여행 시리즈").length===2 && document.querySelector("[data-testid=reader-view-list]")?.getAttribute("aria-pressed")==="true"');
  await call('ui_click',{target:'testid:reader-book-group'});await call('ui_click',{target:'testid:reader-library-manage'});await call('ui_click',{target:'testid:reader-library-book',index:0});await call('ui_click',{target:'testid:reader-group-clear'});
  await check('window.__readerStore.getState().books.length===16 && window.__readerStore.getState().books.filter(b=>b.group==="별의 여행 시리즈").length===1');
  await call('window_resize',{width:800,height:600});await fixed('reader-shelf-scroll','reader-heading','reader-controls');
  await call('ui_screenshot',{savePath:process.cwd()+'/_local/reader-fixed-narrow.png'});
  const tone=await call('test_input',{kind:'tone',seconds:10});
  await call('app_mode',{mode:'music'});await call('ui_drop_files',{target:'testid:source-card',paths:[tone.path]});
  await check('window.__afStore.getState().fileInfo!==null');
  for(const mode of ['music','conversation','transcribe','split']) {
   await call('app_mode',{mode});await fixed('workspace-content','workspace-heading','workspace-dock');
   await check('document.querySelector("[data-testid=workspace-dock]").getBoundingClientRect().height>0');
  }
  await call('ui_screenshot',{savePath:process.cwd()+'/_local/workspace-fixed-tracks.png'});
  await call('app_mode',{mode:'dub'});await fixed('workspace-content','workspace-heading','song-controls');
  await call('app_mode',{mode:'tts'});await call('ui_click',{target:'testid:add-generation-card'});
  await check('!!document.querySelector("[data-testid=pick-voice-confirm]") && !document.querySelector("[data-testid=pick-voice-confirm]").disabled');
  await call('ui_click',{target:'testid:pick-voice-confirm'});await fixed('workspace-content','workspace-heading','join-bar');
  await call('app_mode',{mode:'music'});await check('document.querySelector("[data-testid=join-bar]")===null');
  const errors=await call('errors');assert.equal(errors.count,0,JSON.stringify(errors));
 } finally {await c.call('app_stop');await c.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
