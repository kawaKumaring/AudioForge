// 검사도 **C 드라이브로 가지 않는다.**
//
// ★왜 (2026-09-28 지시): "가장 중요한건 6번이다. C 드라이브로 가지 않아야한다."
//   검사는 격리 userData·입력물 복사본·분리 중간물을 시스템 임시 폴더에 만들고 있었다.
//   실패한 실행은 정리를 건너뛰므로 **잔해가 계속 쌓였다**(폴더 규칙 문서에 적어 둔 그대로).
//
// ★한 줄로 막는 이유 (실측): `os.tmpdir()` 은 부를 때마다 TEMP/TMP 를 다시 읽고,
//   이 프로세스가 띄우는 Electron·파이썬 자식은 env 를 그대로 물려받는다.
//   그래서 60개 넘는 검사 파일을 고치지 않아도 이 한 곳이면 전부 따라온다.
//
// ★이름을 짧게 둔 이유: 저장소 경로가 이미 79자다. 윈도우 경로 상한(260)까지
//   여유가 얼마 없어 `test-temp` 대신 `tmp` 로 둔다.
//
// 쓰는 자리 — `test/e2e/_e2e-helper.mjs` 맨 위, `scripts/verify.mjs` 맨 위,
// 그리고 단위 검사는 `npm test` 의 `--import` 로.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const TEST_TEMP_ROOT = path.join(ROOT, '_local', 'tmp')

fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true })
// 셋 다 바꾼다 — Node 는 TEMP/TMP 를, 파이썬은 TMPDIR 을 먼저 본다.
process.env.TEMP = TEST_TEMP_ROOT
process.env.TMP = TEST_TEMP_ROOT
process.env.TMPDIR = TEST_TEMP_ROOT
