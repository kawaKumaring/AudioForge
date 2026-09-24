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

/**
 * 앱이 **폴더째 들고 있는** 모델. 코드에 이름이 안 적혀도 싣고 있으면 조건을 확인해야 한다.
 *
 * ★왜 생겼나(2026-09-24 2차 감사)
 *   이 검사는 소스에서 `조직/모델` 문자열을 찾는다. 그런데 모델을 앱 안으로 들이면서
 *   그 문자열이 **사라졌다** — 이제 로컬 경로로 연다. 즉 내재화를 잘 할수록
 *   검사의 눈이 멀었다. 실제로 pyannote community-1 은 앱이 들고 있는데도
 *   인벤토리에 **아예 없었다.**
 *
 *   externals/ 는 .gitignore 라 장비마다 있을 수도 없을 수도 있다. 없으면 건너뛰되
 *   **건너뛴 사실을 말한다** — 조용히 통과하면 없는 보증을 있다고 믿게 된다.
 */
export function bundledDirs(root = ROOT, ls = readdirSync, stat = statSync) {
  const base = path.join(root, "externals", "diarization_models")
  try {
    return ls(base).filter((n) => !n.startsWith(".") && stat(path.join(base, n)).isDirectory())
  } catch {
    return null   // 이 장비에는 externals 가 없다
  }
}

export function auditLicenses(inventory, referenced, bundled = null) {
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
  // 앱이 폴더째 들고 있는 모델 — 코드에 이름이 없어도 조건을 확인한다.
  const byDir = new Map((inventory.models || [])
    .filter((m) => m.bundled_dir).map((m) => [m.bundled_dir, m]))
  if (bundled === null) {
    notices.push("앱 안 모델 폴더(externals/diarization_models)가 없어 대조하지 못했다 — 이 실행에는 그 보증이 없다")
  } else {
    for (const dir of bundled) {
      const m = byDir.get(dir)
      if (!m) { errors.push(`앱이 싣고 있는데 인벤토리에 없는 모델: externals/diarization_models/${dir}`); continue }
      const lic = String(m.license || "").trim()
      if (!lic || lic === "UNVERIFIED") {
        if (m.default_path) errors.push(`조건 미확인 모델을 기본 경로로 싣고 있다: ${m.id}`)
        else notices.push(`조건 미확인(선택 경로, 앱이 싣고 있음): ${m.id} — 배포 전 확인하거나 뺀다`)
      }
      if (m.non_commercial === true && commercial) {
        errors.push(`상업 배포 선언 상태인데 비상업 조건 모델을 싣고 있다: ${m.id} (${lic})`)
      }
    }
  }
  for (const m of inventory.models || []) {
    // 앱 안 모델은 **경로로** 열므로 코드에 이름이 없는 것이 정상이다 — 정리 후보가 아니다.
    if (!referenced.has(m.id) && m.default_path && !m.bundled_dir) {
      notices.push(`인벤토리에 있으나 코드가 참조하지 않는다(기본 경로 표기): ${m.id} — 표기 정리 후보`)
    }
  }
  return { errors, notices, commercial, checked: referenced.size, declared: byId.size,
           bundled: bundled === null ? null : bundled.length }
}

if (import.meta.url === `file:///${process.argv[1].split(path.sep).join('/')}`
    || process.argv[1]?.endsWith('check-model-licenses.mjs')) {
  const inventory = JSON.parse(readFileSync(path.join(ROOT, 'model-licenses.json'), 'utf-8'))
  const referenced = referencedModels(sourceFiles())
  const r = auditLicenses(inventory, referenced, bundledDirs())
  console.log(`모델 조건 검사 — 코드 참조 ${r.checked}개 · 앱 안 폴더 ${r.bundled === null ? '확인 못 함' : r.bundled + '개'} · 인벤토리 ${r.declared}개 · 배포 선언 ${r.commercial ? '상업' : '비상업'}`)
  for (const n of r.notices) console.log(`  · ${n}`)
  for (const e of r.errors) console.log(`  ❌ ${e}`)
  if (r.errors.length) {
    console.log(`\n실패 ${r.errors.length}건 — model-licenses.json 을 갱신하거나 해당 모델을 빼야 한다.`)
    process.exit(1)
  }
  console.log('\n통과 — 코드가 쓰는 모델 전부가 인벤토리에 있고 기본 경로에 조건 미확인 모델이 없다.')
}
