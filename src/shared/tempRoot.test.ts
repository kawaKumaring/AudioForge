import { test } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import {
  TEMP_DIR_NAME, TEMP_ENV_KEYS, planTempRoot, redirectTemp, ourTempNames, OUR_TEMP_PREFIXES,
// @ts-ignore TS5097
} from './tempRoot.ts'

test('임시 자리는 데이터 자리 아래다', () => {
  assert.equal(planTempRoot('E:\\앱\\AudioForge_data\\audio-forge-dev'),
    'E:\\앱\\AudioForge_data\\audio-forge-dev\\' + TEMP_DIR_NAME)
  assert.equal(planTempRoot('/home/x/data'), '/home/x/data/' + TEMP_DIR_NAME)
})

test('끝에 붙은 구분자는 자리를 바꾸지 않는다', () => {
  assert.equal(planTempRoot('E:\\앱\\데이터\\'), 'E:\\앱\\데이터\\' + TEMP_DIR_NAME)
  assert.equal(planTempRoot('/a/b//'), '/a/b/' + TEMP_DIR_NAME)
})

test('자리를 모르면 아무것도 정하지 않는다', () => {
  assert.equal(planTempRoot(''), '')
  assert.equal(planTempRoot('   '), '')
})

test('★세 변수를 모두 돌린다 — 하나라도 빠지면 그쪽만 옛 자리로 간다', () => {
  const env: Record<string, string | undefined> = { TEMP: 'C:\\옛자리', TMP: 'C:\\옛자리' }
  const got = redirectTemp('E:\\앱\\temp', env)
  assert.equal(got, 'E:\\앱\\temp')
  for (const k of TEMP_ENV_KEYS) assert.equal(env[k], 'E:\\앱\\temp', k + ' 가 안 바뀌었다')
})

test('★빈 자리로는 돌리지 않는다 — 임시 파일이 현재 폴더에 쏟아진다', () => {
  const env: Record<string, string | undefined> = { TEMP: 'C:\\옛자리', TMP: 'C:\\옛자리', TMPDIR: undefined }
  assert.equal(redirectTemp('  ', env), '')
  assert.equal(env.TEMP, 'C:\\옛자리')
  assert.equal(env.TMP, 'C:\\옛자리')
  assert.equal(env.TMPDIR, undefined)
})

test('옛 자리에서 우리 것만 고른다', () => {
  const listed = [
    'audioforge_config_abc.json', 'audioforge_e2e_1', 'audioforge-e2e-userdata-9',
    'audioforge_split_tok_1', 'audioforge_ens_xx', 'audioforge_diarize_z.json',
    '남의폴더', 'chrome_BITS_1', 'npm-cache', 'af.txt', 'affinity-designer',
  ]
  assert.deepEqual(ourTempNames(listed), [
    'audioforge_config_abc.json', 'audioforge_e2e_1', 'audioforge-e2e-userdata-9',
    'audioforge_split_tok_1', 'audioforge_ens_xx', 'audioforge_diarize_z.json',
  ])
})

test('★짧은 접두로 싸잡지 않는다 — 남의 파일을 지운다', () => {
  for (const p of OUR_TEMP_PREFIXES) {
    assert.ok(p.length >= 11, `접두가 너무 짧다: ${p}`)
    assert.ok(p.startsWith('audioforge'), `우리 이름으로 시작하지 않는다: ${p}`)
  }
  // 이름이 비슷하기만 한 것은 고르지 않는다.
  assert.deepEqual(ourTempNames(['affinity-designer', 'af-', 'af_mp_옛잔해', 'audioforge']), [])
})

test('빈 목록이면 지울 것도 없다', () => {
  assert.deepEqual(ourTempNames([]), [])
})
