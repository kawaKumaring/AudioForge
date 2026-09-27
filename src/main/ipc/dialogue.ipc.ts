/**
 * 대화 작업실이 **자기 결과 폴더 안의 받아쓴 파일**을 읽는 통로.
 *
 * 하는 일은 하나다 — 그 폴더 바로 아래의 파일 하나를 글자로 돌려준다.
 * 어디까지 읽어도 되는지는 `shared/transcriptPath` 가 정한다(여기서 다시 쓰지 않는다).
 *
 * ★밖으로 아무것도 보내지 않는다. 읽어서 같은 앱의 화면에만 준다.
 */
import { ipcMain } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DIALOGUE_TRANSCRIPT_CHANNEL, TRANSCRIPT_MAX_BYTES, transcriptFault,
} from '../../shared/transcriptPath'

export function registerDialogueIpc(): void {
  ipcMain.handle(DIALOGUE_TRANSCRIPT_CHANNEL, (_e, dir: unknown, name: unknown) => {
    if (typeof dir !== 'string' || typeof name !== 'string') return ''
    if (transcriptFault(dir, name)) return ''
    const full = join(resolve(dir), name)
    try {
      const st = statSync(full)
      if (!st.isFile() || st.size > TRANSCRIPT_MAX_BYTES) return ''
      return readFileSync(full, 'utf-8')
    } catch {
      return ''     // 없으면 없는 것이다 — 화면은 '대본 없음' 으로 그린다
    }
  })
}
