const assert = require('node:assert/strict');
const { McpClient } = require('../../tools/mcp/client.cjs');
(async () => {
  const c = new McpClient();
  await c.start();
  const call = async (name, args = {}) => {
    const r = await c.call(name, args);
    if (r.isError) throw Error(r.text);
    return r.json;
  };
  const check = async code => {
    const r = await call('ui_wait', { code, timeoutMs: 8000 });
    assert.equal(r.met, true, code);
    console.log('PASS', code);
  };
  try {
    await call('app_start', { width: 1200, height: 820 });
    await check('!!document.querySelector("[data-testid=audioforge-welcome]") && !document.querySelector("[data-testid=workspace-shell]")');
    await check('document.querySelector("[data-testid=welcome-character]")?.naturalWidth > 0');
    await call('ui_screenshot', { savePath: 'welcome.png' });
    await call('window_resize', { width: 800, height: 600 });
    await check('document.documentElement.scrollWidth <= innerWidth');
    await call('ui_click', { target: 'testid:welcome-start' });
    await check('!!document.querySelector("[data-testid=source-open]") && !document.querySelector("[data-testid=welcome-character]")');
    await call('ui_click', { target: 'testid:source-open' }); // empty dialog queue means cancel
    await check('window.__afStore.getState().status === "idle" && !window.__afStore.getState().fileInfo');
    const tone = await call('test_input', { kind: 'tone', seconds: 1 });
    await call('dialog_queue', { kind: 'open', answers: [tone.path] });
    await call('ui_click', { target: 'testid:source-open' });
    await check('!!window.__afStore.getState().fileInfo && !document.querySelector("[data-testid=welcome-character]")');
    await call('ui_click', { target: 'testid:source-close' });
    await check('!!document.querySelector("[data-testid=source-open]") && !document.querySelector("[data-testid=welcome-character]")');
    await call('ui_drop_files', { target: 'testid:source-open', paths: [tone.path] });
    await check('!!window.__afStore.getState().fileInfo && window.__afStore.getState().status === "idle"');
    await call('window_resize', { width: 1200, height: 820 });
    await check('getComputedStyle(document.querySelector("[data-testid=workspace-shell]")).backgroundImage === "none" && getComputedStyle(document.querySelector("[data-testid=source-card]")).backgroundImage === "none" && getComputedStyle(document.querySelector("[data-testid=workspace-sidebar]")).backgroundImage.includes("linear-gradient")');
    await call('ui_screenshot', { savePath: 'workspace-theme.png' });
    await call('ui_click', { target: 'testid:open-app-options' });
    await call('ui_screenshot', { savePath: 'settings-theme.png' });
    const errors = await call('errors');
    assert.equal(errors.count, 0, JSON.stringify(errors));
  } finally {
    await c.call('app_stop');
    await c.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
