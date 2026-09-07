// 모델 이용 조건 게이트 — 코드가 쓰는 모델이 인벤토리에 있고 조건이 확인됐는지 본다.
//
// 왜: 예전 인벤토리는 `externals/model-manifest.json` 이었는데 `externals/` 가 .gitignore 라
// 버전관리 밖이었다. 그래서 낡은 채로 남아 **핵심 엔진(Qwen3-TTS)조차 빠져** 있었고,
// 두 항목은 license 가 null 이었다. 어떤 조건의 모델을 싣고 있는지 아무도 확인할 수 없는 상태였다.
//
// 이 검사가 실패시키는 것
//   1. 코드가 참조하는데 `model-licenses.json` 에 없는 모델 — 무엇을 싣는지 모르는 상태
//   2. license 가 UNVERIFIED/빈 값인 모델이 **기본 경로**에 있는 경우
//   3. 상업 배포로 선언(distribution.commercial=true)했는데 비상업 조건 모델이 남아 있는 경우
//
// 실패시키지 않고 알리는 것
//   · 비상업 조건 모델이 기본 경로에 있으나 비상업 배포로 선언된 경우(지금 상태) — 사실만 보고한다.
//   · 인벤토리에 있으나 코드가 더는 참조하지 않는 항목 — 정리 후보.
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** HuggingFace 형식 id. 조직 이름은 우리가 실제로 쓰는 것만 본다(무한 오탐 방지). */
const HF_ORGS = ['facebook', 'openai', 'Qwen', 'nvidia', 'funasr', 'lj1995', 'Plachta',
  'microsoft', 'speechbrain', 'pyannote']
/** HF 형식이 아닌 이름 — 파일명·엔진 이름으로 쓰는 것들. */
const BARE_PATTERNS = [
  /\bhtdemucs(?:_ft)?\b/g,
  /\b(?:model_bs_roformer|mel_band_roformer)[A-Za-z0-9_.]*\.ckpt\b/g,
  /\bwhisper\/(?:large-v3-turbo|large-v3|medium|small|base|tiny)\b/g,
]
/** 코드가 쓰는 짧은 이름 → 인벤토리 id. Whisper 는 코드에서 'large-v3' 처럼만 쓴다. */
const ALIAS = new Map([
  ['large-v3', 'whisper/large-v3'],
  ['large-v3-turbo', 'whisper/large-v3-turbo'],
  ['medium', 'whisper/medium'],
])
const ALIAS_RE = /'(large-v3-turbo|large-v3|medium)'/g

function sourceFiles() {
  const out = []
  const walk = (dir, depth = 0) => {
    if (depth > 4) return
    for (const name of readdirSync(dir)) {
      if (['node_modules', '_local', 'externals', 'out', 'dist', '__pycache__', '.git'].includes(name)) continue
      const full = path.join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full, depth + 1)
      else if (/\.(py|ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$|^test_/.test(name)) out.push(full)
    }
  }
  walk(path.join(ROOT, 'python'))
  walk(path.join(ROOT, 'src'))
  return out
}

export function referencedModels(files, read = (f) => readFileSync(f, 'utf-8')) {
  const found = new Map()   // id -> 처음 발견한 파일(상대경로)
  const orgRe = new RegExp(`\\b(?:${HF_ORGS.join('|')})/[A-Za-z0-9_.-]+`, 'g')
  for (const f of files) {
    // 주석 줄은 보지 않는다 — 한국어 주석의 'Qwen/GPU/모델 로딩 없음' 같은 표현이 모델 id 로 잡혔다(실측 오탐).
    const src = read(f).split(/\r?\n/)
      .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
      .join('\n')
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    ALIAS_RE.lastIndex = 0
    for (const m of src.matchAll(ALIAS_RE)) {
      const id = ALIAS.get(m[1])
      if (id && !found.has(id)) found.set(id, rel)
    }
    for (const re of [orgRe, ...BARE_PATTERNS]) {
      re.lastIndex = 0
      for (const m of src.matchAll(re)) {
        const id = m[0]
        if (!found.has(id)) found.set(id, rel)
      }
    }
  }
  return found
}

export function auditLicenses(inventory, referenced) {
  const byId = new Map((inventory.models || []).map((m) => [m.id, m]))
  const commercial = !!inventory.distribution?.commercial
  const errors = []
  const notices = []
  for (const [id, where] of referenced) {
    const m = byId.get(id)
    if (!m) { errors.push(`인벤토리에 없는 모델: ${id} (${where})`); continue }
    const lic = String(m.license || '').trim()
    if (!lic || lic === 'UNVERIFIED') {
      if (m.default_path) errors.push(`조건 미확인 모델이 기본 경로에 있다: ${id}`)
      else notices.push(`조건 미확인(선택 경로): ${id} — 배포 전 확인하거나 제거한다`)
    }
    if (m.non_commercial === true) {
      if (commercial) errors.push(`상업 배포 선언 상태인데 비상업 조건 모델이 있다: ${id} (${lic})`)
      else notices.push(`비상업 조건${m.default_path ? '(기본 경로)' : ''}: ${id} — ${lic}`)
    }
  }
  for (const m of inventory.models || []) {
    if (!referenced.has(m.id) && m.default_path) {
      notices.push(`인벤토리에 있으나 코드가 참조하지 않는다(기본 경로 표기): ${m.id} — 표기 정리 후보`)
    }
  }
  return { errors, notices, commercial, checked: referenced.size, declared: byId.size }
}

if (import.meta.url === `file:///${process.argv[1].split(path.sep).join('/')}`
    || process.argv[1]?.endsWith('check-model-licenses.mjs')) {
  const inventory = JSON.parse(readFileSync(path.join(ROOT, 'model-licenses.json'), 'utf-8'))
  const referenced = referencedModels(sourceFiles())
  const r = auditLicenses(inventory, referenced)
  console.log(`모델 조건 검사 — 코드 참조 ${r.checked}개 · 인벤토리 ${r.declared}개 · 배포 선언 ${r.commercial ? '상업' : '비상업'}`)
  for (const n of r.notices) console.log(`  · ${n}`)
  for (const e of r.errors) console.log(`  ❌ ${e}`)
  if (r.errors.length) {
    console.log(`\n실패 ${r.errors.length}건 — model-licenses.json 을 갱신하거나 해당 모델을 빼야 한다.`)
    process.exit(1)
  }
  console.log('\n통과 — 코드가 쓰는 모델 전부가 인벤토리에 있고 기본 경로에 조건 미확인 모델이 없다.')
}
