// Browser interaction test for the actual component; engine capabilities here are test fixtures only.
// No app store, synthesis IPC, model loading, or user audio is touched.
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
const root = process.argv[2] || process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from './src/renderer/components/PerformanceScriptEditor';
import { plainDocument } from './src/shared/performanceDocument';
function Fixture() {
 const [doc,setDoc]=useState(plainDocument('나는 네가 와서 좋았는데, 너는 아니었나 봐.'));
 window.testDocument=doc; window.replaceDocument=setDoc;
 return <Editor value={doc} onChange={setDoc} choices={[
  {id:'anger',label:'화를 터뜨리며',tone:'intense',verified:true},
  {id:'sadness',label:'울먹이며',tone:'cool',verified:true,strengths:['low','normal'],transitions:['immediate']},
  {id:'joy',label:'기쁨',verified:false,reason:'검증 대기'},
 ]}/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
const bundle = await build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}})
const browser = await chromium.launch({headless:true})
const page = await browser.newPage({viewport:{width:800,height:600}})
const errors=[]
page.on('pageerror',e=>errors.push(e.message))
const checks=[]
const passed=name=>{checks.push(name);console.log('PASS',name)}
try {
 await page.setContent('<style>body{margin:32px;background:#13141b;color:#eee;font-family:Arial,sans-serif}button:disabled{cursor:not-allowed}button:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #ba9fff;outline-offset:2px}</style><div id="root"></div>')
 await page.addScriptTag({content:bundle.outputFiles[0].text})
 const text=page.getByRole('textbox',{name:'대사'})
 await text.waitFor()
 const select=async(start,end)=>{
  await text.focus()
  await text.evaluate((el,[s,e])=>{el.setSelectionRange(s,e);el.dispatchEvent(new Event('select',{bubbles:true}))},[start,end])
 }
 const doc=()=>page.evaluate(()=>window.testDocument)
 const original=(await doc()).text
 await select(8,12)
 await text.press('Alt+Enter')
 await page.getByRole('dialog',{name:'구절 연출'}).waitFor()
 assert.equal(await page.getByRole('button',{name:'기쁨',exact:true}).isDisabled(),true)
 assert.equal(await page.getByRole('button',{name:'적용',exact:true}).isDisabled(),true)
 passed('미검증 감정과 빈 선택은 적용할 수 없다')
 assert.equal(await page.getByTestId('acting-excerpt').innerText(),original.slice(8,12))
 assert.equal(await page.getByRole('button',{name:'해제',exact:true}).isDisabled(),true)
 passed('선택한 대사만 연출 창에 표시하고 없는 연출은 해제하지 않는다')
 await page.getByRole('button',{name:'화를 터뜨리며',exact:true}).click()
 assert.equal(await page.getByRole('combobox').count(),0)
 await page.getByRole('button',{name:'적용',exact:true}).click()
 await page.getByRole('dialog').waitFor({state:'detached'})
 assert.equal((await doc()).text,original)
 assert.deepEqual((await doc()).ranges,[{start:8,end:12,acting:{emotion:'anger'}}])
 passed('구절 감정 적용은 대사에 태그를 넣지 않는다')
 await text.press('Control+z')
 assert.equal((await doc()).ranges.length,0)
 await text.press('Control+Shift+z')
 assert.equal((await doc()).ranges.length,1)
 passed('키보드 되돌리기와 다시 적용이 감정도 복원한다')
 await select(0,0)
 await text.press('X')
 assert.equal((await doc()).ranges[0].start,9)
 passed('실제 타이핑 후 감정 구간이 이동한다')
 await select(9,13)
 await text.press('Tab')
 assert.equal(await page.getByRole('button',{name:'선택 구절 연출'}).evaluate(el=>el===document.activeElement),true)
 await page.keyboard.press('Enter')
 await page.getByRole('dialog').waitFor()
 await page.getByRole('button',{name:'울먹이며',exact:true}).click()
 assert.equal(await page.getByRole('group',{name:'감정 강도'}).count(),1)
 await page.getByRole('button',{name:'은은하게',exact:true}).click()
 assert.equal(await page.getByRole('button',{name:'은은하게',exact:true}).getAttribute('aria-pressed'),'true')
 assert.equal(await page.getByRole('button',{name:'기쁨',exact:true}).isDisabled(),true)
 assert.equal(await page.getByRole('button',{name:'서서히',exact:true}).count(),0)
 await page.keyboard.press('Escape')
 assert.equal((await doc()).ranges[0].acting.emotion,'anger')
 passed('키보드로 팝업에 접근하며 Esc는 변경을 취소한다')
 // Chromium's IME protocol exercises composition/input events, not an OS Korean keyboard.
 await select(10,10)
 const cdp=await page.context().newCDPSession(page)
 const beforeIME=await doc()
 await cdp.send('Input.imeSetComposition',{text:'ㅎ',selectionStart:1,selectionEnd:1})
 await cdp.send('Input.imeSetComposition',{text:'하',selectionStart:1,selectionEnd:1})
 assert.deepEqual(await doc(),beforeIME)
 await cdp.send('Input.insertText',{text:'한'})
 await page.waitForFunction(rev=>window.testDocument.revision===rev+1,beforeIME.revision)
 assert.equal((await doc()).text,beforeIME.text.slice(0,10)+'한'+beforeIME.text.slice(10))
 await text.press('Control+z')
 assert.equal((await doc()).text,beforeIME.text)
 passed('한글 조합 중에는 저장하지 않고 확정 후 한 번에 되돌린다')
 await select(9,13)
 await text.press('Alt+Enter')
 const old=await doc()
 await page.evaluate(()=>window.replaceDocument({text:'새 작업',ranges:[],revision:99}))
 await page.getByRole('dialog').waitFor({state:'detached'})
 assert.equal((await doc()).text,'새 작업')
 passed('외부 작업 전환은 이전 감정 팝업을 무효화한다')
 await page.evaluate(()=>window.replaceDocument({text:'가가가',ranges:[{start:1,end:2,acting:{emotion:'anger'}}],revision:100}))
 await page.waitForFunction(()=>document.querySelector('textarea').value==='가가가')
 await select(1,1)
 await text.press('Backspace')
 assert.equal((await doc()).text,'가가')
 assert.deepEqual((await doc()).ranges,[{start:0,end:1,acting:{emotion:'anger'}}])
 passed('반복 글자를 지워도 실제 삭제 위치에 맞게 감정이 이동한다')
 await page.evaluate(()=>{document.body.style.zoom='1.5'})
 await select(0,2)
 await text.press('Alt+Enter')
 const bounds=await page.getByRole('dialog').boundingBox()
 assert.ok(bounds && bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=800 && bounds.y+bounds.height<=600,JSON.stringify(bounds))
 passed('800×600 · 150% 확대에서 팝업이 화면 안에 놓인다')
 const excerpt=await page.getByTestId('acting-excerpt').innerText()
 assert.equal(excerpt,'가가')
 await page.getByRole('button',{name:'울먹이며',exact:true}).click()
 await page.getByRole('button',{name:'은은하게',exact:true}).click()
 await page.getByRole('button',{name:'적용',exact:true}).click()
 assert.equal((await doc()).ranges[0].acting.strength,'low')
 await text.press('Control+z')
 assert.equal((await doc()).ranges[0].acting.emotion,'anger')
 passed('세기 적용과 되돌리기는 실제 연출 기록에 반영된다')
 await page.evaluate(()=>{document.body.style.zoom='1'})
 await page.setViewportSize({width:390,height:640})
 await select(0,2)
 await text.press('Alt+Enter')
 const narrow=await page.getByRole('dialog').boundingBox()
 assert.ok(narrow && narrow.x>=0 && narrow.x+narrow.width<=390)
 passed('좁은 창에서도 연출 선택과 적용에 접근할 수 있다')
 if (process.env.AF_EDITOR_SCREENSHOT) await page.screenshot({path:process.env.AF_EDITOR_SCREENSHOT,animations:'disabled'})
 assert.deepEqual(errors,[])
 passed('브라우저 런타임 오류 없음')
 console.log(JSON.stringify({passed:checks.length,checks,scope:'Headless Chromium component; no engine or full Electron flow'}))
} finally {await browser.close()}
