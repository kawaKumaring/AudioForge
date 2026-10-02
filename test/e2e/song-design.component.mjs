import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
const root=process.cwd(), require=createRequire(path.join(root,'package.json'))
const {build}=require('esbuild'),{chromium}=require('playwright')
const bundle=await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import Song from './src/renderer/components/SongWorkspace';
import {useAppStore} from './src/renderer/stores/app.store';
window.store=useAppStore;window.mount=()=>createRoot(document.getElementById('root'));
window.app=window.mount();window.app.render(<Song/>);
window.remount=()=>{window.app.unmount();window.app=window.mount();window.app.render(<Song/>)};
`,loader:'tsx',resolveDir:root},bundle:true,write:false,format:'iife',jsx:'automatic',tsconfig:path.join(root,'tsconfig.web.json'),define:{'process.env.NODE_ENV':'"development"'}})
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1000,height:800}})
const errors=[];page.on('pageerror',e=>errors.push(e.message));let count=0
const pass=s=>{count++;console.log('PASS',s)}
try{
await page.setContent(`<style>:root{--bg-base:#101116;--bg-card:#1a1c25;--bg-elevated:#252733;--border-subtle:#333541;--border-accent:#655189;--accent:#9968f2;--accent-light:#c2a7fa;--accent-glow:#a080fa16;--text-primary:#ececf2;--text-muted:#9198ad;--amber:#dbb172;--rose:#ec8d99}*{box-sizing:border-box}body{margin:24px;background:#101116;color:#ececf2;font:14px Arial}</style><div id="root"></div>`)
await page.evaluate(()=>{
 window.pick='song.mp3';window.calls=[];window.fail=false;
 window.api={audio:{selectFile:async(...args)=>{window.calls.push(args);return window.pick},getFileInfo:async path=>{if(window.fail)throw Error('failure');return {path,name:path.split('/').pop(),duration:123,format:path.split('.').pop(),sampleRate:44100,channels:2}}},utils:{getPathForFile:f=>f.name},song:{onProgress:()=>()=>{},onError:()=>()=>{},onCancelled:()=>()=>{}}};      // 진행·오류·취소 구독(2026-09-27 추가 — 대역에 빠져 있었다)
})
await page.addScriptTag({content:bundle.outputFiles[0].text})
await page.getByTestId('song-cards').waitFor()
assert.equal(await page.locator('details').count(),0)
const a=await page.getByRole('region',{name:'원곡',exact:true}).boundingBox(),b=await page.getByRole('region',{name:'목소리',exact:true}).boundingBox()
assert.equal(a.y,b.y);assert.ok(a.width<500);pass('넓은 창은 두 입력 카드를 나란히 배치한다')
await page.screenshot({path:path.join(process.env.TEMP,'af-song-empty.png')})
await page.getByRole('button',{name:'원곡 음원 또는 영상 선택'}).click()
await page.getByText('song.mp3',{exact:true}).waitFor();pass('음원 파일을 원곡 카드로 불러온다')
// 노래 변환은 2026-09-27 엔진에 연결됐다 — 막는 기준은 '실행할 수 없는 입력' 이다(songRequestFault). 예전 '미연결 엔진' 확인을 그 뜻대로 바꿨다.
const runBtn=page.getByRole('button',{name:'노래 변환',exact:true})
assert.equal(await runBtn.isDisabled(),true);assert.equal(await runBtn.getAttribute('title'),'목소리를 고르세요');pass('목소리가 없으면 실행할 수 없게 막고 사유를 툴팁으로 보인다')
await page.evaluate(()=>window.pick='voice.mp4')
await page.getByRole('button',{name:'목소리 음원 또는 영상 선택'}).click()
await page.getByText('voice.mp4',{exact:true}).waitFor()
assert.deepEqual(await page.evaluate(()=>window.calls),[[false,'source'],[false,'voice']]);pass('목소리는 별도 선택 통로로 영상도 불러온다')
assert.equal(await runBtn.isDisabled(),false);pass('원곡과 목소리가 갖춰지면 실행할 수 있다')
await page.evaluate(()=>{window.fail=true;window.pick='bad.wav'})
await page.getByRole('button',{name:'원곡 파일 변경'}).click()
await page.getByRole('alert').waitFor();assert.equal(await page.getByText('song.mp3',{exact:true}).count(),1);pass('불러오기 실패 시 이전 원곡을 보존한다')
await page.evaluate(()=>{window.fail=false;window.remount()})
await page.getByText('voice.mp4',{exact:true}).waitFor();assert.equal(await page.getByText('song.mp3',{exact:true}).count(),1);pass('메뉴 왕복 후 두 파일 선택을 유지한다')
await page.getByRole('button',{name:'원곡 파일 닫기'}).click()
await page.getByRole('button',{name:'원곡 음원 또는 영상 선택'}).waitFor()
await page.getByTestId('song-source-input').evaluate(el=>{const dt=new DataTransfer();dt.items.add(new File(['fixture'],'drop.mkv'));el.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}))})
await page.getByText('drop.mkv',{exact:true}).waitFor();pass('드래그한 영상 파일이 해당 카드에 들어간다')
await page.evaluate(()=>window.store.setState({status:'processing'}))
assert.equal(await page.getByRole('button',{name:'원곡 파일 변경'}).isDisabled(),true)
assert.equal(await page.getByRole('tab',{name:'기존 더빙'}).isDisabled(),true);pass('작업 중 파일 변경과 탭 전환을 잠근다')
await page.evaluate(()=>window.store.setState({status:'idle'}))
await page.setViewportSize({width:430,height:800})
const narrowA=await page.getByRole('region',{name:'원곡',exact:true}).boundingBox(),narrowB=await page.getByRole('region',{name:'목소리',exact:true}).boundingBox()
assert.ok(narrowB.y>=narrowA.y+narrowA.height)
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);pass('좁은 창은 세로로 전환하고 가로 넘침이 없다')
await page.screenshot({path:path.join(process.env.TEMP,'af-song-narrow.png')})
assert.deepEqual(errors,[]);pass('런타임 오류 없음')
console.log(JSON.stringify({passed:count,scope:'Actual React components; mocked file IPC, no conversion engine'}))
}finally{await browser.close()}
