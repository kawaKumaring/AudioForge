// PNG 원본에서 Windows 다중 크기 ICO와 창 아이콘을 재현한다. 네트워크/모델 불필요.
const fs = require('node:fs'); const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
 const root = path.resolve(__dirname, '..'); const dir = path.join(root, 'build/branding');
 const artwork = fs.readFileSync(path.join(dir, 'audioforge-character-source.png'));
 const browser = await chromium.launch({ headless: true });
 try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent('<style>html,body{margin:0;background:transparent}img{display:block;width:100%;height:100%;object-fit:contain}</style><img src="data:image/png;base64,' + artwork.toString('base64') + '">');
  await page.locator('img').evaluate(img => img.decode());
  const sizes = [16, 24, 32, 48, 64, 128, 256]; const frames = [];
  for (const size of [...sizes, 512]) {
   await page.setViewportSize({ width: size, height: size });
   const png = await page.screenshot({ omitBackground: true });
   if (size === 512) fs.writeFileSync(path.join(dir, 'audioforge.png'), png); else frames.push(png);
  }
  const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => { const at = 6 + i * 16; header[at] = header[at+1] = size === 256 ? 0 : size; header.writeUInt16LE(1, at+4); header.writeUInt16LE(32, at+6); header.writeUInt32LE(frames[i].length, at+8); header.writeUInt32LE(offset, at+12); offset += frames[i].length; });
  fs.writeFileSync(path.join(dir, 'audioforge.ico'), Buffer.concat([header, ...frames]));
  fs.mkdirSync(path.join(root, 'src/renderer/public'), {recursive:true});
  fs.copyFileSync(path.join(dir,'audioforge.png'),path.join(root,'src/renderer/public/audioforge-character.png'));
  console.log('AudioForge character icon: 7 ICO sizes + PNG');
 } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
