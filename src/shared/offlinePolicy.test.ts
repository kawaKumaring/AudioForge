import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { OFFLINE_ENV, applyOfflineEnv, localTranslateModel, isLocalUrl } from './offlinePolicy.ts'
// @ts-ignore TS5097
import { rendererCsp } from './cspPolicy.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('★오프라인 설정을 덮어쓴다 — 바깥에서 꺼 두었어도 켠다', () => {
  const env: Record<string, string | undefined> = { HF_HUB_OFFLINE: '0', PATH: 'x' }
  const changed = applyOfflineEnv(env)
  for (const [k, v] of Object.entries(OFFLINE_ENV)) assert.equal(env[k], v, k)
  assert.ok(changed.includes('HF_HUB_OFFLINE'))
  assert.equal(env.PATH, 'x', '다른 값을 건드렸다')
  assert.deepEqual(applyOfflineEnv(env), [], '두 번째에는 바꿀 것이 없어야 한다')
})

test('★구글 번역은 받지 않는다 — 로컬로 돌린다', () => {
  assert.equal(localTranslateModel('google'), '600m')
  assert.equal(localTranslateModel('GOOGLE'), '600m')
  assert.equal(localTranslateModel('1.3b'), '1.3b')
  assert.equal(localTranslateModel('llm'), 'llm')
  assert.equal(localTranslateModel(undefined), '600m')
})

test('★로컬 주소만 통과 — 바깥 주소는 막는다', () => {
  for (const u of ['http://localhost:5173/', 'ws://localhost:5173/@vite', 'http://127.0.0.1:8188/x', 'http://[::1]:3000/',
    'file:///E:/a.html', 'local-file://E:/a.wav', 'devtools://devtools/bundled/x', 'data:,x', 'blob:http://localhost/x']) {
    assert.equal(isLocalUrl(u), true, u)
  }
  for (const u of ['https://translate.googleapis.com/translate_a/single', 'https://huggingface.co/api/models/x',
    'https://redirector.gvt1.com/edgedl/chrome/dict/ko-3-0.bdic', 'http://192.168.0.5/', 'wss://example.com/', 'https://localhost.evil.com/', '이상한 주소']) {
    assert.equal(isLocalUrl(u), false, u)
  }
})

// ★화면 보안 정책 — 바깥 주소가 들어 있지 않고, 제품에서는 eval 을 허락하지 않는다(크롬 보안 경고의 원인).
test('화면 보안 정책은 바깥 주소를 허락하지 않는다', () => {
  const csp = rendererCsp()
  assert.ok(!/unsafe-eval/.test(csp), '제품 정책이 eval 을 허락한다')
  const hosts = [...csp.matchAll(/(?:https?|wss?):\/\/([^\s;:/]+)/g)].map((x) => x[1])
  assert.deepEqual([...new Set(hosts)].filter((h) => h !== 'localhost' && h !== '127.0.0.1'), [], `바깥 주소: ${hosts}`)
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /object-src 'none'/)
})

test('검사로 띄운 앱만 eval 을 더 허락한다 — 바깥 연결 규칙은 같다', () => {
  const prod = rendererCsp(), e2e = rendererCsp({ e2e: true })
  assert.match(e2e, /unsafe-eval/)
  assert.equal(e2e.replace(" 'unsafe-eval'", ''), prod, 'eval 말고 다른 것이 달라졌다')
})

test('화면이 뜨는 첫 순간에 정책을 건다 — 정적 HTML 에 두 벌을 두지 않는다', () => {
  const html = readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf-8')
  assert.ok(!/http-equiv="Content-Security-Policy"/.test(html), '정적 정책과 겹치면 두 정책의 교집합이 걸린다')
  const main = readFileSync(path.join(ROOT, 'src', 'renderer', 'main.tsx'), 'utf-8')
  assert.ok(main.indexOf('applyRendererCsp(') > 0 && main.indexOf('applyRendererCsp(') < main.indexOf('createRoot('), '렌더보다 먼저 걸지 않는다')
})

// ★코드에 바깥 주소가 새로 생기면 울린다 — 설치·안내용 주소만 적어 둔 자리에 둔다.
test('실행 코드에 바깥 주소로 요청하는 곳이 없다', () => {
  const bad: string[] = []
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(n) || /\.test\./.test(n)) continue
      const t = readFileSync(p, 'utf-8')
      for (const line of t.split(/\r?\n/)) {
        const s = line.trim()
        if (s.startsWith('//') || s.startsWith('*')) continue
        if (/(fetch|net\.request|axios|https?\.get)\s*\(\s*['"`]https?:\/\/(?!localhost|127\.0\.0\.1)/.test(s)) bad.push(`${path.relative(ROOT, p)}: ${s.slice(0, 80)}`)
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(bad, [])
  const py = readFileSync(path.join(ROOT, 'python', 'transcribe_worker.py'), 'utf-8')
  assert.ok(!/googleapis/.test(py), '전사 작업자에 구글 번역 주소가 남아 있다')
})
