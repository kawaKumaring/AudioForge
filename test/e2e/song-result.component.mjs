import assert from 'node:assert/strict'
import path from 'node:path'
import {createRequire} from 'node:module'
const root=process.cwd(),require=createRequire(path.join(root,'package.json'))
const {build}=require('esbuild'),{chromium}=require('playwright')
const mock=`export default {create(){const events={};const w={t:0,playing:false,duration:10,volume:0,destroyed:false,on(k,f){(events[k]??=[]).push(f)},emit(k,v){events[k]?.forEach(f=>f(v))},setVolume(v){this.volume=v},setOptions(){},async load(url){this.url=url;if(window.delay){await new Promise(r=>window.release=r)}this.emit('ready',10)},setTime(t){this.t=t;this.emit('timeupdate',t)},getCurrentTime(){return this.t},getDuration(){return this.duration},isPlaying(){return this.playing},async play(){this.playing=true;this.emit('play')},pause(){this.playing=false;this.emit('pause')},destroy(){this.pause();this.destroyed=true}};window.players.push(w);return w}}`
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Card from './src/renderer/components/SongResultCard';import{setPlaybackVolume}from './src/renderer/lib/playbackVolume';window.volume=setPlaybackVolume;function App(){const[r,setR]=useState({id:'one',title:'노래.wav',originalAudioPath:'original.wav',mixPath:'mix.wav'});const[d,setD]=useState(false);window.result=setR;window.disable=setD;return <Card result={r} disabled={d} onSave={async r=>{window.saved=r;if(window.saveFail)throw Error('fail')}} onOpenFolder={async r=>window.folder=r}/>};createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,write:false,format:'iife',jsx:'automatic',plugins:[{name:'wave-test-double',setup(b){b.onResolve({filter:/^wavesurfer.js$/},()=>({path:'wave',namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:mock,loader:'js'}))}}]})
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:700,height:500}});let checks=0;const pass=s=>{checks++;console.log('PASS',s)};const errors=[];page.on('pageerror',e=>errors.push(e.message))
try{
await page.setContent('<style>body{background:#11131a;color:#eee;font:14px Arial;margin:24px}*{box-sizing:border-box}:root{--bg-card:#1c1e27;--bg-base:#101116;--bg-elevated:#262936;--border-subtle:#383b47;--accent-light:#c2a7fa;--text-muted:#9399ad;--text-primary:#eee;--accent-glow:#b08aff18;--border-accent:#8261b5;--rose:#f99}</style><div id="root"></div>')
await page.evaluate(()=>{window.players=[];window.api={audio:{getFileUrl:async p=>p}}})
await page.addScriptTag({content:bundle.outputFiles[0].text});await page.waitForFunction(()=>document.querySelector('[data-state]')?.dataset.state==='ready')
assert.equal(await page.evaluate(()=>window.players[0].url),'mix.wav');pass('변환본을 기본으로 준비')
await page.evaluate(()=>{window.players.at(-1).setTime(4);window.volume(.35)})
await page.getByRole('button',{name:'비교 재생',exact:true}).click()
await page.getByRole('button',{name:'원곡',exact:true}).click()
await page.waitForFunction(()=>window.players.at(-1).url==='original.wav')
assert.deepEqual(await page.evaluate(()=>[window.players[0].destroyed,window.players.at(-1).t,window.players.at(-1).playing,window.players.at(-1).volume]),[true,4,true,.35]);pass('전환 시 이전 재생 해제·같은 시간 이어 재생·공용 음량 유지')
await page.evaluate(()=>window.disable(true));await page.waitForFunction(()=>!window.players.at(-1).playing);assert.equal(await page.evaluate(()=>window.players.at(-1).playing),false);pass('비활성화 시 재생 정지')
await page.evaluate(()=>{window.disable(false);window.delay=true})
await page.getByRole('button',{name:'변환본',exact:true}).click()
await page.waitForFunction(()=>typeof window.release==='function')
await page.evaluate(()=>{window.delay=false;window.result({id:'two',title:'새 결과',originalAudioPath:'original2.wav',mixPath:'mix2.wav'})})
await page.waitForFunction(()=>window.players.at(-1).url==='mix2.wav');await page.evaluate(()=>window.release())
assert.deepEqual(await page.evaluate(()=>[window.players.at(-1).t,window.players.at(-1).playing]),[0,false]);pass('새 결과는 자동 재생하지 않고 늦은 이전 응답 무시')
await page.getByRole('button',{name:'파일로 저장'}).click();assert.equal(await page.evaluate(()=>window.saved.id),'two')
await page.getByRole('button',{name:'결과 폴더 열기'}).click();assert.equal(await page.evaluate(()=>window.folder.id),'two');pass('저장·폴더 콜백에 표시 중인 결과 전달')
await page.evaluate(()=>window.saveFail=true);await page.getByRole('button',{name:'파일로 저장'}).click();await page.getByRole('alert').waitFor();pass('저장 실패 표시')
await page.setViewportSize({width:360,height:500});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);pass('좁은 화면 가로 넘침 없음')
await page.screenshot({path:path.join(process.env.TEMP,'af-song-result.png')});assert.deepEqual(errors,[]);pass('런타임 오류 없음')
console.log(JSON.stringify({passed:checks,scope:'Actual React component, WaveSurfer test double; no real audio decoding or sound quality validation'}))
}finally{await browser.close()}
