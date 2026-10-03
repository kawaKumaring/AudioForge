/**
 * 낭독이 저장하는 두 가지 — **읽던 자리(책 파일)** 와 **읽기 설정(설정 파일의 한 칸)**. 둘 다 화면 밖에서 저장한다.
 *
 * ★왜 (2026-10-02 관리자 검수 재현): 둘 다 화면 안 effect 의 타이머였다. 문단을 누르고 600ms 안에 메뉴를 옮기면 위치가 디스크에 남지 않았고
 *   (메모리 25 · 디스크 0), 서재 보기를 바꾸고 바로 옮기면 설정 파일의 값이 null 이었다. 규칙은 `writeBehind` 에 있다.
 */
import { createWriteBehind } from './writeBehind'
import { READER_PREFS_STORAGE_KEY } from '../../shared/readerText'
import { saveSetting } from '../../shared/saveSetting'

/** 책 하나가 파일 하나다 — 열쇠는 책 번호. */
export const bookSaver = createWriteBehind<unknown>({
  delayMs: 600,
  retryDelays: [2000, 5000, 15000],
  write: async (key, value) => {
    const r = await window.api.works.write('books', key, value)
    return r.ok ? '' : (r.why || 'WRITE_FAILED')
  },
  writeSync: (key, value) => {
    const r = window.api.works.writeSync('books', key, value)
    return r?.ok ? '' : (r?.why || 'WRITE_FAILED')
  },
})

/** 읽기 설정은 열쇠가 하나다. */
export const PREFS_KEY = 'prefs'
export const prefsSaver = createWriteBehind<unknown>({
  delayMs: 250,
  retryDelays: [2000, 5000, 15000],
  write: async (_key, value) => (await saveSetting(window.api.settings.set, READER_PREFS_STORAGE_KEY, value)) ?? '',
  writeSync: (_key, value) => {
    const r = window.api.settings.setSync(READER_PREFS_STORAGE_KEY, value) as { ok?: boolean; code?: string } | undefined
    return r?.ok === false ? (r.code || 'SAVE_FAILED') : ''
  },
})
