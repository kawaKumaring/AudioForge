import '../_temp-root.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
const root = process.cwd(), require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright')
const bundle = await build({ stdin: { contents: `
import React, {useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
import Editor from './src/renderer/components/ExpressionPromptEditor';
import Palette from './src/renderer/components/ExpressionPalette';
function App(){const [texts,setTexts]=useState(['처음 대사 끝','다른 카드']),[target,setTarget]=useState(-1),[locked,setLocked]=useState(false);const insert=useRef({});
window.texts=texts;window.openCard=i=>setTarget(i);window.lock=()=>setLocked(true);window.restore=(t)=>setTexts(t);
return <><div style={{width:340}}>{texts.map((t,i)=><Editor key={i} label={'대사'+i} value={t} disabled={locked} change={s=>setTexts(p=>p.map((x,j)=>i===j?s:x))} register={fn=>{if(fn)insert.current[i]=fn;else delete insert.current[i]}} activate={fn=>{setTarget(i);insert.current[i]=fn}}/>)}</div><Palette target={target<0?'':'카드'+target} disabled={locked} supported={true} close={()=>{}} insert={cue=>insert.current[target]?.(cue)}/></>}
createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: root }, bundle: true, write: false, jsx: 'automatic', format: 'iife', tsconfig: path.join(root, 'tsconfig.web.json') })
const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
let count = 0; const pass = s => { count++; console.log('통과', s) }; const errors=[];page.on('pageerror',e=>errors.push(e.message))
try {
await page.setContent('<style>body{background:#14151b;color:white}*{box-sizing:border-box}:root{--bg-base:#14151b;--bg-card:#21232c;--border-subtle:#444;--text-primary:white;--text-secondary:white;--accent-glow:#394}</style><div id="root"></div>')
await page.addScriptTag({ content: bundle.outputFiles[0].text })
const editor=page.getByRole('textbox',{name:'대사0'}), happy=page.getByRole('button',{name:'기쁨',exact:true})
await editor.waitFor();assert.equal(await happy.isDisabled(),true);pass('대상 없는 도구는 삽입을 막는다')
await page.evaluate(()=>window.openCard(1));await happy.click();assert.equal(await page.evaluate(()=>window.texts[1]),'[기쁨]다른 카드');assert.equal(await page.evaluate(()=>window.texts[0]),'처음 대사 끝');pass('카드 도구에서 바로 열어도 그 카드만 바뀐다')
await page.evaluate(()=>window.restore(['처음 대사 끝','다른 카드']))
await editor.evaluate(el=>{el.focus();const r=document.createRange();r.setStart(el.firstChild,3);r.setEnd(el.firstChild,5);const s=getSelection();s.removeAllRanges();s.addRange(r);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})
await happy.click();assert.equal(await page.evaluate(()=>window.texts[0]),'처음 [기쁨]대사 끝');pass('선택한 원문을 지우지 않고 선택 앞에 표시를 넣는다')
await happy.click();assert.equal(await page.evaluate(()=>window.texts[0]),'처음 [기쁨]대사 끝');assert.equal(await editor.locator('[data-expression-token]').count(),1);pass('같은 자리에서 다시 눌러도 감정 표시가 두 개 쌓이지 않는다')
assert.equal(await editor.locator('[data-expression-token]').innerText(),'😊');assert.equal((await editor.innerText()).includes('[기쁨]'),false);pass('대사 안에는 단어 대신 아이콘을 보여 준다')
assert.match(await happy.getAttribute('title'),/기쁨.*밝고/);assert.equal(await editor.locator('[data-expression-token]').getAttribute('title'),await happy.getAttribute('title'));pass('도구와 대사 표시의 툴팁이 같다')
await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>window.texts[0]),'처음 대사 끝');await page.keyboard.press('Control+Shift+z');assert.equal(await page.evaluate(()=>window.texts[0]),'처음 [기쁨]대사 끝');pass('아이콘 삽입도 되돌리기와 다시 적용을 따른다')
await editor.click();await page.keyboard.type('새 글');assert.match(await page.evaluate(()=>window.texts[0]),/새 글/);assert.equal(await page.getByRole('region',{name:'감정 도구',exact:true}).count(),1);assert.equal(await page.locator('dialog').count(),0);pass('도구를 연 상태에서 배경 대사 입력이 계속된다')
await page.getByRole('textbox',{name:'대사1'}).click();await page.getByRole('button',{name:'슬픔',exact:true}).click();assert.match(await page.evaluate(()=>window.texts[1]),/\[슬픔\]/);pass('다른 카드를 선택하면 삽입 대상도 바뀐다')
await page.evaluate(()=>window.restore(['안녕[화남]\n다시','다른 카드']));await editor.locator('[data-expression-token="[화남]"]').waitFor();assert.equal(await editor.locator('[data-expression-token]').innerText(),'😠');assert.equal(await editor.innerText(),'안녕😠\n다시');pass('저장된 대사 복원은 아이콘과 줄바꿈을 보존한다')
await page.evaluate(()=>window.restore(['안녕[기쁨]😊 다시','다른 카드']));await editor.locator('[data-expression-token="[기쁨]😊"]').waitFor();assert.equal(await editor.innerText(),'안녕😊 다시');assert.equal(await page.evaluate(()=>window.texts[0]),'안녕[기쁨]😊 다시');pass('기존 이모지와 표시는 하나로 보이지만 저장 원문은 지우지 않는다')
await page.evaluate(()=>window.restore(['안녕[화남]\n다시','다른 카드']));await editor.locator('[data-expression-token="[화남]"]').waitFor()
await page.evaluate(()=>window.restore(['안녕😊 다시','다른 카드']));await editor.evaluate(el=>{el.focus();const r=document.createRange();r.setStart(el.firstChild,2);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))});await happy.click();assert.equal(await page.evaluate(()=>window.texts[0]),'안녕[기쁨]😊 다시');assert.equal(await editor.innerText(),'안녕😊 다시');pass('이모지 옆에 새 표시를 넣어도 즉시 하나로 보이고 원문은 유지된다')
await page.evaluate(()=>window.restore(['안녕[화남]\n다시','다른 카드']));await editor.locator('[data-expression-token="[화남]"]').waitFor()
const handle=page.getByRole('button',{name:'감정 도구 이동'}), before=await handle.boundingBox();await page.mouse.move(before.x+30,before.y+12);await page.mouse.down();await page.mouse.move(before.x-90,before.y+60,{steps:8});await page.mouse.up();const after=await handle.boundingBox();assert.ok(after.x<before.x-80);pass('도구를 드래그해도 배경 편집창은 이동하지 않는다')
await handle.focus();await page.keyboard.press('ArrowLeft');assert.ok((await handle.boundingBox()).x<after.x);pass('키보드로도 도구 위치를 바꾼다')
await page.setViewportSize({width:360,height:640});await page.waitForFunction(()=>{const b=document.querySelector('[data-testid="expression-palette"]').getBoundingClientRect();return b.left>=0&&b.right<=innerWidth});pass('좁은 창에서도 도구가 창 밖으로 나가지 않는다')
await editor.evaluate(el=>{el.focus();const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);window.copyText='';const dt=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,clipboardData:dt}));window.copyText=dt.getData('text/plain')});assert.equal(await page.evaluate(()=>window.copyText),'안녕[화남]\n다시');pass('복사에는 이모지 대신 복원 가능한 연출 표시와 원문이 남는다')
await editor.evaluate(el=>{const dt=new DataTransfer();dt.setData('text/plain','<img src=x> 한국어');dt.setData('text/html','<img src=x onerror="alert(1)">');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:dt}))});assert.equal(await editor.locator('img').count(),0);assert.match(await page.evaluate(()=>window.texts[0]),/<img src=x> 한국어/);pass('붙여 넣은 HTML도 실행 없이 원문 글자로 남는다')
await page.evaluate(()=>window.restore(['[기쁨]안녕','다른 카드']));await editor.locator('[data-expression-token="[기쁨]"]').waitFor();await editor.evaluate(el=>{el.focus();const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);const dt=new DataTransfer();el.dispatchEvent(new ClipboardEvent('cut',{bubbles:true,clipboardData:dt}));window.cutText=dt.getData('text/plain')});assert.equal(await page.evaluate(()=>window.cutText),'[기쁨]안녕');assert.equal((await page.evaluate(()=>window.texts[0])).trim(),'');pass('잘라내기에도 원문과 복원 가능한 표시가 함께 남는다')
await page.setViewportSize({width:360,height:200});await page.waitForFunction(()=>{const b=document.querySelector('[data-testid="expression-palette"]').getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight});pass('높이가 낮은 창에서도 도구 전체가 창 안에 들어간다')
await page.evaluate(()=>window.lock());assert.equal(await happy.isDisabled(),true);assert.equal(await editor.getAttribute('contenteditable'),'false');pass('생성 중에는 삽입과 대사 변경을 함께 막는다')
assert.deepEqual(errors,[]);pass('브라우저 실행 오류 없음')
console.log('감정 도구 검사',count,'건 통과')
}finally{await browser.close()}
