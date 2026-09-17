// 교정본 저장 — **최초 인식 결과 옆에** 따로 쓴다.
//
// ★원래 파일(<base>.txt / .srt / _timestamps.txt)은 건드리지 않는다. 교정본은
//   `<base>_corrected.txt` / `<base>_corrected.srt` 로 **새로** 쓴다. 그래야 "고치기 전"
//   으로 언제든 돌아갈 수 있다.
// ★실패를 삼키지 않는다. 쓰지 못하면 사유를 그대로 돌려준다(경로는 보내지 않는다).
import { ipcMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

export function registerTranscriptIpc(): void {
  ipcMain.handle('transcript:save-corrected', async (
    _e, outputDir: string, base: string, txt: string, srt: string | null,
  ) => {
    try {
      if (typeof outputDir !== 'string' || !outputDir) {
        return { ok: false, reason: '저장할 폴더를 알 수 없습니다.' }
      }
      if (typeof base !== 'string' || !base || /[\/:*?"<>|]/.test(base)) {
        return { ok: false, reason: '저장 이름이 올바르지 않습니다.' }
      }
      if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
      const written: string[] = []
      const txtPath = join(outputDir, `${base}_corrected.txt`)
      writeFileSync(txtPath, String(txt ?? ''), 'utf-8')
      written.push(basename(txtPath))
      let srtPath: string | null = null
      if (typeof srt === 'string' && srt.length > 0) {
        srtPath = join(outputDir, `${base}_corrected.srt`)
        writeFileSync(srtPath, srt, 'utf-8')
        written.push(basename(srtPath))
      }
      return { ok: true, files: written, dir: dirname(txtPath), txtPath, srtPath }
    } catch (err) {
      // 사유는 그대로, 경로는 빼고 — 쓰지 못했다는 사실을 숨기지 않는다.
      const m = err instanceof Error ? err.message : String(err)
      return { ok: false, reason: `교정본을 저장하지 못했습니다 — ${m.split(',')[0]}` }
    }
  })
}
