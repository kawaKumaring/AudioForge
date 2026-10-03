import '../_temp-root.mjs'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { createServer } from 'node:http'
const result = await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {useReaderFollow} from './src/renderer/hooks/useReaderFollow';
import SpeakerControl from './src/renderer/components/SpeakerControl';
import * as boost from './src/renderer/lib/playbackBoost';
import * as volume from './src/renderer/lib/playbackVolume';
import WaveSurfer from 'wavesurfer.js';
window.api={settings:{get:async()=>({}),set:async()=>({ok:true})}};
Object.assign(window,{boost,volume,WaveSurfer});
const text=Array.from({length:100},(_,i)=>String(i).padStart(3,'0')+' hello').join('\\n');
window.cursor=0; const caret=()=>window.cursor, paragraphAt=()=>0, offsets=[0];
function Test(){const body=React.useRef(null);const f=useReaderFollow({body,playing:true,enabled:true,visible:true,documentId:'test',caret,paragraphAt,offsets,reveal:()=>{}});window.follow=f;
return <><div ref={body} id="body" onWheel={f.markUserScroll} style={{height:240,width:400,overflow:'auto',whiteSpace:'pre-wrap',lineHeight:'24px'}}><div data-index="0">{text}</div></div><SpeakerControl id="test"/><div id="wave"/></>}
createRoot(document.getElementById('root')).render(<Test/>);
`},bundle:true,write:false,format:'iife',jsx:'automatic',tsconfig:'tsconfig.web.json'});
const code=result.outputFiles[0].text;const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script>'+code.replaceAll('</script','<\\/script')+'</script>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});let count=0;const check=(v,m)=>{assert.ok(v,m);console.log('PASS',m);count++};try{
const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.follow);
const top=()=>page.locator('#body').evaluate(e=>e.scrollTop);
await page.evaluate(()=>window.cursor=40);await page.waitForTimeout(900);check(await top()===0,'보이는 줄에서는 화면 고정');
await page.evaluate(()=>window.cursor=80);await page.waitForTimeout(1000);const moved=await top();check(moved>60,'하단에 가까워지면 한 번 전진');
await page.evaluate(()=>window.cursor=90);await page.waitForTimeout(900);check(Math.abs(await top()-moved)<2,'다음 줄도 보이면 다시 이동하지 않음');
await page.evaluate(()=>window.cursor=80);await page.waitForTimeout(900);check(Math.abs(await top()-moved)<2,'작은 타이밍 역행이 화면 역행을 일으키지 않음');
await page.locator('#body').hover();await page.mouse.wheel(0,120);await page.waitForTimeout(200);const manual=await top();await page.evaluate(()=>window.cursor=400);await page.waitForTimeout(3300);check(await top()===manual&&await page.evaluate(()=>window.follow.followPaused),'직접 스크롤 뒤 3초가 지나도 끌어당기지 않음');await page.evaluate(()=>window.follow.resumeFollow());await page.waitForTimeout(1000);check(await top()>manual,'명시적으로 복귀하면 읽는 곳으로 이동');
await page.locator('[data-testid=test-mute]').click({button:'right'});await page.locator('[data-testid=quick-boost]').fill('2');await page.locator('[data-testid=quick-boost]').press('ArrowRight');await page.locator('[data-testid=quick-boost]').press('ArrowLeft');check(await page.evaluate(()=>window.boost.getPlaybackBoost())===2,'우클릭으로 실제 증폭 값 변경');
await page.keyboard.press('Escape');check(await page.getByRole('dialog',{name:'스피커 옵션'}).count()===0,'Escape로 메뉴 닫기');
// 낮은 진폭의 WAV를 실제 HTMLAudio와 WaveSurfer로 재생하고 출력 GainNode를 관측한다.
await page.evaluate(()=>{const proto=AudioContext.prototype, original=proto.createGain;window.gains=[];proto.createGain=function(){const gain=original.call(this);window.gains.push(gain);return gain};const n=44100*4,b=new ArrayBuffer(44+n*2),v=new DataView(b),write=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));write(0,'RIFF');v.setUint32(4,36+n*2,true);write(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,44100,true);v.setUint32(28,88200,true);v.setUint16(32,2,true);v.setUint16(34,16,true);write(36,'data');v.setUint32(40,n*2,true);for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(i*2*Math.PI*220/44100)*3000,true);window.url=URL.createObjectURL(new Blob([b],{type:'audio/wav'}));window.audio=window.volume.createManagedAudio(window.url);window.audio.loop=true;window.audio.play();window.rms=()=>{const data=new Float32Array(window.analyser.fftSize);window.analyser.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((s,x)=>s+x*x,0)/data.length)};window.observe=()=>{const gain=window.gains.at(-1);window.analyser=gain.context.createAnalyser();gain.connect(window.analyser)}});
await page.waitForTimeout(350);await page.evaluate(()=>window.observe());await page.waitForTimeout(200);const doubled=await page.evaluate(()=>window.rms());await page.evaluate(()=>window.boost.setPlaybackBoost(1));await page.waitForTimeout(250);const normal=await page.evaluate(()=>window.rms());check(normal>.03&&Math.abs(doubled/normal-2)<.08,'HTMLAudio 출력 진폭이 실제로 2배');
await page.evaluate(()=>{window.boost.setPlaybackBoost(2);window.volume.setPlaybackVolume(0)});await page.waitForTimeout(250);check(await page.evaluate(()=>window.rms())<.0001,'증폭 상태에서도 음소거 가능');await page.evaluate(()=>{window.audio.pause();window.volume.setPlaybackVolume(1);window.boost.setPlaybackBoost(2);window.ws=window.WaveSurfer.create({container:'#wave',backend:'WebAudio'});window.boost.attachPlaybackBoost(window.ws.getMediaElement());return window.ws.load(window.url)});await page.evaluate(()=>{window.observe();return window.ws.play()});await page.waitForTimeout(350);const webdouble=await page.evaluate(()=>window.rms());await page.evaluate(()=>window.boost.setPlaybackBoost(1));await page.waitForTimeout(250);const webnormal=await page.evaluate(()=>window.rms());check(webnormal>.03&&Math.abs(webdouble/webnormal-2)<.08,'WaveSurfer WebAudio 출력도 실제로 2배');check(await page.evaluate(()=>window.boost.getBoostFailure())==='','증폭 오류 없음');
console.log('RESULT',count,'checks · 0 fail');
}finally{await browser.close();server.close()}
