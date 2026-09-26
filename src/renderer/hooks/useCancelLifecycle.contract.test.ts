// 취소 handshake 가 **모든 작업 소유 화면**에 걸려 있는지 — 파일 하나가 아니라 전체를 본다.
//
// ★왜 전역이어야 하나(2026-09-24 2차 감사)
//   취소 배선이 `ProcessButton` 안에만 있었고, 계약 검사도 그 파일만 읽었다.
//   그래서 **두 번째 작업 소유자**(일반 탭)가 같은 통로에 들어와 성공 경로만
//   배선했을 때 아무 검사도 울리지 않았다. 일반 탭에서 취소가 실패하면 화면이
//   한 글자도 말하지 않고 '만드는 중' 에 멈췄고, 탭·모드 단추까지 잠겨
//   **앱을 다시 켜는 것 말고 빠져나올 길이 없었다.**
//
//   파일 이름을 적어 두는 검사는 세 번째 화면이 생기면 또 놓친다.
//   그래서 "작업을 시작하는 모든 화면" 을 스스로 찾아 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(HERE, '..')

function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(name)) continue
      if (/\.test\.(ts|tsx)$/.test(name)) continue
      out.push({ rel: path.relative(RENDERER, p).split(path.sep).join('/'), text: readFileSync(p, 'utf-8') })
    }
  }
  walk(RENDERER)
  return out
}

/** 주석 줄을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
const codeOf = (text: string): string =>
  text.split('\n').filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

// ★"작업을 시작하면 배선하라" 는 너무 무디다 — 공용 실행 단추가 **함께 뜨는** 화면은
//   그 단추가 이미 듣고 있다(예: 대화 구간 화면). 그래서 규칙을 구멍이 실제로 생기는
//   자리로 좁힌다: **공용 단추를 감추는 모드**는 제 화면이 직접 들어야 한다.
//   그 모드 목록은 App.tsx 가 정하므로 **거기서 읽어 온다** — 새 모드를 목록에 넣는
//   순간(= 구멍이 생기는 변경) 이 검사가 울린다.
//   ★한 모드가 화면을 **갈아 끼울 수도** 있다(2026-09-26). 합성은 이제 기본이 생성 카드이고
//     '이전 작업' 을 고르면 예전 작업실이 뜬다. 둘 다 같은 모드 안에서 공용 단추 없이 뜨므로
//     **둘 다** 직접 들어야 한다. 그래서 값이 목록이다.
const OWN_CANCEL_SCREENS: Record<string, string[]> = {
  // 합성 일반 탭(고급 탭은 ProcessButton 을 직접 그린다) + 그 앞에 서는 생성 카드 화면.
  tts: ['components/LabWorkspace.tsx', 'components/SynthesisCardWorkspace.tsx'],
  lab: ['components/LabWorkspace.tsx'],
  dub: ['components/DubWorkspace.tsx'],
}

test('공용 실행 단추를 감추는 모드 목록이 바뀌면 여기서 멈춘다', () => {
  const app = readFileSync(path.join(RENDERER, 'App.tsx'), 'utf-8')
  const line = app.split(/\r?\n/).find((l) => l.includes('const showSharedRun'))
  assert.ok(line, 'App.tsx 에서 showSharedRun 을 찾지 못했다 — 규칙이 옮겨갔다')
  const modes = [...line!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(modes, Object.keys(OWN_CANCEL_SCREENS).sort(),
    '공용 실행 단추를 감추는 모드가 바뀌었다 — 그 화면이 취소 실패를 직접 듣는지 확인하고 이 목록을 갱신하세요')
})

test('공용 단추가 없는 화면은 취소 lifecycle 을 스스로 배선한다', () => {
  const bad: string[] = []
  for (const rel of new Set(Object.values(OWN_CANCEL_SCREENS).flat())) {
    const code = codeOf(readFileSync(path.join(RENDERER, rel), 'utf-8'))
    if (!code.includes('useCancelLifecycle(')) bad.push(rel)
  }
  assert.deepEqual(bad, [],
    `취소가 실패하면 이 화면들이 '만드는 중' 에 갇힌다 — useCancelLifecycle 을 쓰세요: ${bad.join(', ')}`)
})

test('취소를 부르는 자리는 반환값을 버리지 않는다', () => {
  const bad: string[] = []
  for (const f of sources()) {
    for (const line of codeOf(f.text).split('\n')) {
      if (/void\s+window\.api\.audio\.cancel\s*\(/.test(line)) {
        bad.push(`${f.rel}: ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(bad, [],
    `미수락 사유가 사라진다 — requestCancel() 로 받아 화면에 반영하세요:\n${bad.join('\n')}`)
})

// ★훅 자신이 세 이벤트를 모두 듣는지. 하나라도 빠지면 그것을 쓰는 화면 전부가 같이 눈먼다.
test('훅은 세 이벤트를 모두 구독한다', () => {
  const code = codeOf(readFileSync(path.join(HERE, 'useCancelLifecycle.ts'), 'utf-8'))
  for (const ev of ['onCancelling(', 'onCancelled(', 'onCancelFailed(']) {
    assert.ok(code.includes(`api.${ev}`), `${ev} 를 듣지 않는다`)
  }
})

// ★훅이 처리까지 가지면 화면마다 다른 규칙이 깨진다.
//   고급 탭의 finishCancelled 는 결과 목록까지 비운다 — 일반 탭에 그대로 걸면
//   "취소해도 이미 만든 것은 그대로" 라는 규칙이 무너진다.
test('훅은 처리 내용을 갖지 않는다 — 화면 store 를 직접 건드리지 않는다', () => {
  const code = codeOf(readFileSync(path.join(HERE, 'useCancelLifecycle.ts'), 'utf-8'))
  for (const forbidden of ['useAppStore', 'useLabStore', 'finishCancelled', 'setCancelFailed']) {
    assert.ok(!code.includes(forbidden),
      `훅이 ${forbidden} 를 직접 부른다 — 처리는 부르는 쪽 콜백이어야 한다`)
  }
})

// ★취소해도 이미 만든 것은 그대로 — 회피성 제거 방지.
test('일반 탭은 취소해도 만든 것을 지키겠다고 말한다', () => {
  const code = readFileSync(path.join(RENDERER, 'components', 'LabWorkspace.tsx'), 'utf-8')
  assert.ok(code.includes('이미 만든 결과와 고른 것은 그대로 있습니다'),
    '취소 시 테이크·채택 보존 약속이 사라졌다')
})
