import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import assert from 'node:assert/strict'
import path from 'node:path'
import {createRequire} from 'node:module'
const root=process.cwd(),require=createRequire(path.join(root,'package.json'))
const{build}=require('esbuild'),{chromium}=require('playwright')
const wav=Buffer.alloc(44+24000*10*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=44;i<wav.length;i+=2)wav.writeInt16LE(Math.sin(i*.03)*3000,i)
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React from 'react';import{createRoot}from'react-dom/client';import Split from './src/renderer/components/SplitEditor';import Options from './src/renderer/components/Options';import{useAppStore}from './src/renderer/stores/app.store';window.store=useAppStore;useAppStore.setState({mode:'split',fileUrl:window.wav,fileInfo:{path:'fixture.wav',name:'fixture.wav',duration:10,channels:1,sampleRate:24000,format:'wav'}});function App(){const mode=useAppStore(s=>s.mode);return mode==='split'?<Split/>:<Options/>}createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',tsconfig:path.join(root,'tsconfig.web.json')})
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:900,height:800}});let checks=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));const pass=s=>{checks++;console.log('PASS',s)}
try{
await page.setContent('<style>*{box-sizing:border-box}body{margin:24px;background:#101116;color:#eee;font:14px Arial}:root{--bg-base:#101116;--bg-card:#1b1d26;--bg-elevated:#272a35;--border-subtle:#383b48;--border-accent:#6c538d;--accent:#a77cf0;--accent-light:#c8aff8;--accent-glow:#9976ed18;--text-primary:#eee;--text-secondary:#bac1d2;--text-muted:#939aae;--amber:#edc46d;--rose:#f89}</style><div id="root"></div>')
await page.evaluate(wav=>{window.wav=wav;window.api={settings:{get:async()=>({}),set:async()=>({ok:true})}}},'data:audio/wav;base64,'+wav.toString('base64'))
await page.addScriptTag({content:bundle.outputFiles[0].text})
await page.waitForFunction(()=>!document.querySelector('[aria-label="분할 파형 재생"]').disabled)
assert.equal(await page.getByRole('textbox').count(),0);pass('실제 WAV 파형 로드·기본 화면에서 시간 입력 숨김')
const wave=page.getByTestId('split-edit-wave'),box=await wave.boundingBox()
await page.mouse.dblclick(box.x+box.width*.4,box.y+40)
await page.waitForFunction(()=>window.store.getState().splitMarkers.length===1);pass('파형 더블클릭으로 기존 분할 저장 계약에 지점 전달')
await page.mouse.click(box.x+box.width*.7,box.y+40)
await page.getByRole('button',{name:'＋ 현재 위치에서 나누기',exact:true}).click()
await page.waitForFunction(()=>window.store.getState().splitMarkers.length===2)
assert.equal(await page.getByTestId('split-piece').count(),3);pass('현재 위치 추가 후 세 조각 미리보기')
await page.getByRole('button',{name:'＋ 현재 위치에서 나누기',exact:true}).click();assert.equal(await page.evaluate(()=>window.store.getState().splitMarkers.length),2);pass('같은 위치 중복 추가 방지')
await page.getByRole('button',{name:'시간 목록 붙여넣기',exact:true}).click();assert.equal(await page.getByRole('textbox').count(),3);pass('기존 시간 목록 입력을 선택해서 사용')
await page.getByRole('button',{name:'파형 편집',exact:true}).click()
await page.screenshot({path:path.join(process.env.TEMP,'af-split-visual.png')})
await page.evaluate(()=>window.store.setState({status:'processing'}));await page.waitForFunction(()=>document.querySelector('fieldset').disabled);assert.equal(await page.getByRole('button',{name:'전체 삭제',exact:true}).isDisabled(),true);pass('실행 중 분할 편집 잠금')
await page.evaluate(()=>window.store.setState({status:'idle',mode:'music'}));await page.getByRole('button',{name:'보컬 · 반주',exact:true}).click();assert.equal(await page.evaluate(()=>window.store.getState().demucsModel),'roformer');pass('음악 빠른 선택이 기존 모델 설정과 연결')
await page.evaluate(()=>window.store.setState({mode:'conversation'}));await page.getByRole('group',{name:'대화 인원'}).getByRole('button',{name:'3명',exact:true}).click();assert.equal(await page.evaluate(()=>window.store.getState().nSpeakers),3);pass('대화 인원 설정 바로 변경')
await page.evaluate(()=>window.store.setState({mode:'transcribe'}));await page.getByRole('combobox',{name:'빠른 음성 언어'}).selectOption('ko');assert.equal(await page.evaluate(()=>window.store.getState().whisperLang),'ko');pass('텍스트 추출 음성 언어 바로 변경')
await page.setViewportSize({width:400,height:800});await page.getByRole('button',{name:/옵션/}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);pass('좁은 창 세부 옵션 가로 넘침 없음')
assert.deepEqual(errors,[]);pass('런타임 오류 없음');console.log(JSON.stringify({passed:checks,scope:'Real WaveSurfer decode with synthetic WAV; no processing engine'}))
}finally{await browser.close()}
