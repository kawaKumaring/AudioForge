// 실제 Electron + 내부 MCP. 설정 전달은 실제 store, 결과는 검사용 합성 WAV를 주입한다(엔진 미실행).
const assert=require('node:assert/strict');
const {McpClient}=require('../../tools/mcp/client.cjs');
(async()=>{const c=new McpClient();await c.start();try{
 const call=async(name,args={})=>{const r=await c.call(name,args);if(r.isError)throw Error(r.text);return r.json};
 const check=async code=>{const r=await call('ui_wait',{code,timeoutMs:8000});assert.equal(r.met,true,code);console.log('PASS',code)};
 const shot=async name=>{await call('ui_wait',{code:'document.getAnimations().every(a=>a.playState!=="running" || a.effect?.getTiming().iterations===Infinity)',timeoutMs:2500});await call('ui_screenshot',{savePath:process.cwd()+`/_local/design-${name}.png`})};
 await call('app_start',{width:1100,height:820});await call('app_mode',{mode:'music'});
 const tone=await call('test_input',{kind:'tone',seconds:30});await call('ui_drop_files',{target:'testid:source-card',paths:[tone.path]});
 await check('!!window.__afStore.getState().fileInfo && Array.from(document.querySelectorAll("button")).some(b=>b.getAttribute("aria-label")==="보컬 · 반주")');
 await call('ui_click',{target:'보컬 · 반주',exact:true});await check('window.__afStore.getState().demucsModel==="roformer"');await shot('music');
 const before=await call('js_eval',{code:'document.querySelector("[data-testid=workspace-content]").scrollTop'});
 await call('ui_click',{target:'testid:processing-options'});await check('!!document.querySelector("dialog[open]")');
 await call('ui_click',{target:'보컬 Mel-Band',exact:true});await check('window.__afStore.getState().demucsModel==="roformer_melband"');await shot('settings');
 await call('ui_key',{keys:'Escape'});await check('!document.querySelector("dialog[open]")');
 assert.equal(await call('js_eval',{code:'document.querySelector("[data-testid=workspace-content]").scrollTop'}),before);
 await check('document.activeElement?.dataset.testid==="processing-options"');
 for(const mode of ['conversation','transcribe','split']){await call('app_mode',{mode});await shot(mode)}
 await call('app_mode',{mode:'conversation'});await call('ui_click',{target:'5명',exact:true});await check('window.__afStore.getState().nSpeakers===5');
 await call('window_resize',{width:800,height:600});await shot('conversation-narrow');
 await check('document.documentElement.scrollWidth<=innerWidth && document.querySelector("[data-testid=workspace-content]").scrollWidth<=document.querySelector("[data-testid=workspace-content]").clientWidth');
 await call('ui_click',{target:'testid:processing-options'});await shot('settings-narrow');
 await check('(()=>{const d=document.querySelector("dialog[open]");const b=d.querySelector(".af-card-modal-body");return getComputedStyle(d).display==="flex" && d.getBoundingClientRect().bottom<=innerHeight && b.scrollHeight>=b.clientHeight})()');
 await call('ui_key',{keys:'Escape'});
 await call('app_mode',{mode:'music'});
 const paths=[];for(let i=0;i<4;i++)paths.push((await call('test_input',{kind:'tone',seconds:4,freq:200+i*100})).path);
 const tracks=['vocals','drums','bass','other'].map((name,i)=>({name,label:['보컬','드럼','베이스','그 외'][i],path:paths[i]}));
 await call('js_eval',{code:`window.__afStore.setState({tracks:${JSON.stringify(tracks)},status:'done',resultMode:'music',outputDir:null})`});
 await call('ui_click',{target:'testid:workspace-show-results'});await shot('results-narrow');
 await call('ui_click',{target:'testid:tracks-select-none'});await check('document.querySelector("[data-testid=result-export]").disabled');
 await call('ui_click',{target:'testid:tracks-select-all'});await check('Array.from(document.querySelectorAll("[data-testid=track-keep]")).every(e=>e.checked)');
 await call('ui_click',{target:'testid:track-menu',index:0});await shot('result-menu');
 await check('(()=>{const m=document.querySelector("[data-testid=track-menu-list]").getBoundingClientRect();const hit=document.elementFromPoint(m.left+10,m.top+10);return !!hit?.closest("[role=menu]")})()');
 await call('ui_click',{target:'testid:track-menu-only'});await check('Array.from(document.querySelectorAll("[data-testid=track-keep]")).filter(e=>e.checked).length===1');
 await call('window_resize',{width:1100,height:820});await call('ui_click',{target:'testid:workspace-show-results'});await shot('results');
 const errors=await call('errors');assert.equal(errors.count,0,JSON.stringify(errors));
}finally{await c.call('app_stop');await c.close()}})().catch(e=>{console.error(e);process.exitCode=1});
