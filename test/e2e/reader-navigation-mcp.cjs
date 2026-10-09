// 실제 앱·실제 TXT 입출력. 합성 엔진을 시작하지 않고 긴 본문의 탐색과 배치를 검사한다.
const { McpClient } = require('../../tools/mcp/client.cjs');
(async () => {
  const c = new McpClient(); await c.start();
  try {
    // ★ui_click 은 대상이 없어도 오류로 끝나지 않는다(clicked:false) — 실패로 본다(2026-10-03).
    const call = async (name, args = {}) => { const r = await c.call(name, args); if (r.isError) throw Error(r.text); if (name === 'ui_click' && r.json && r.json.clicked === false) throw Error('누를 대상 없음: ' + args.target); return r.json; };
    const check = async code => { const r = await call('ui_wait', { code, timeoutMs: 10000 }); if (!r.met) throw Error(code); console.log('PASS', code); };
    await call('app_start', { width: 1100, height: 820 }); await call('app_mode', { mode: 'reader' });
    // 낭독 화면이 실제로 뜬 뒤에 찍는다 — 바로 찍으면 앞 화면(음악 작업실)이 찍혔다(2026-10-03 캡처 확인).
    await check('!!document.querySelector("[data-testid=reader-workspace]") && !!document.querySelector("[data-testid=reader-library-dialog]")');
    await call('ui_screenshot', { savePath: 'reader-empty-redesign.png' });
    const file = await call('test_input', { kind: 'text', name: '밤의 도서관 — 긴 소설.txt', content: Array.from({length:5000}, (_, i) => `${i+1}번째 문단. 창밖에는 비가 내리고 있었다. 책장을 넘기는 소리가 고요한 방 안을 채웠다.`).join('\n') });
    await call('dialog_queue', {kind:'open', answers:[[file.path]]}); await call('ui_click', {target:'testid:reader-add-text'});
    await check('document.querySelector("[data-testid=reader-body]")?.dataset.windowed === "1"');
    await call('ui_click', {target:'testid:reader-find'}); await call('ui_set', {target:'testid:reader-find-input',value:'4901번째'});
    await call('ui_click', {target:'testid:reader-find-result'});
    await check('(()=>{const b=document.querySelector("[data-testid=reader-body]").getBoundingClientRect();const p=document.querySelector("[data-index=\\"4900\\"]")?.getBoundingClientRect();return p && p.top>=b.top-1 && p.bottom<=b.bottom+1})()');
    await call('ui_click', {target:'testid:reader-library'}); await call('ui_click', {target:'testid:reader-resume'});
    await check('(()=>{const b=document.querySelector("[data-testid=reader-body]").getBoundingClientRect();const p=document.querySelector("[data-index=\\"4900\\"]")?.getBoundingClientRect();return p && p.top>=b.top-1 && p.bottom<=b.bottom+1})()');
    await call('ui_set', {target:'testid:reader-position',value:25}); await call('ui_key', {target:'testid:reader-position',keys:'Enter'});
    await check('window.__readerStore.getState().books[0].position===25');
    await call('window_resize', {width:800,height:600});
    await check('(()=>{const b=document.querySelector("[data-testid=reader-body]").getBoundingClientRect();const f=document.querySelector("[data-testid=reader-controls]").getBoundingClientRect();return b.height>150 && b.bottom<=f.top && f.bottom<=innerHeight+2 && document.documentElement.scrollWidth<=innerWidth})()');
    await call('ui_screenshot', {savePath:'reader-long-narrow.png'});
    const errors = await call('errors'); if (errors.count) throw Error(JSON.stringify(errors));
  } finally { await c.call('app_stop'); await c.close(); }
})().catch(e => {console.error(e);process.exitCode=1});
