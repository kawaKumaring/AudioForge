/**
 * 음높이 곡선 — 화면이 보고 맞출 수 있게 곡선을 내주고, 손잡이를 먹인다.
 *
 * ★왜 이 통로가 생겼나 (2026-09-26)
 *   따라부르기 결과가 기계음이 나는데, 무엇이 잘못됐는지 **숫자로는 가려내지 못했다.**
 *   품질 지표를 여섯 번 골랐고 여섯 번 다 빗나갔다 — 마지막에는 자연스러운 원본과
 *   찢어지는 결과물에 완전히 같은 값이 나왔다.
 *   그런데 그림으로 그리니 한눈에 달랐다. **보이면 고를 필요가 없다.**
 *
 * ★판단은 여기에 없다
 *   빚는 규칙은 `python/pitch_shape.py`, 소리에 잇는 것은 `python/pitch_apply.py` 다.
 *   이 파일은 **부르고 건네기만** 한다.
 */
import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'

export interface PitchReply<T> { ok: boolean; data?: T; error?: string }

const ok = <T>(data: T): PitchReply<T> => ({ ok: true, data })
const fail = (e: unknown): PitchReply<never> => ({
  ok: false, error: e instanceof Error ? e.message : String(e),
})

/** 한 번에 얼마나 볼까 — 곡 전체를 매번 재면 느리다. 사람은 구간으로 맞춘다. */
export const PREVIEW_SEC = 20

function scriptPath(): string {
  // 개발선은 소스 옆, 배포판은 자원 폴더 — 앱의 다른 다리와 같은 규칙.
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..')
  return join(base, 'python', 'pitch_cli.py')
}

/** 파이썬을 부르고 JSON 을 받아 온다. 실패는 **사유를 들고** 올라간다. */
function runCli(python: string, args: string[]): Promise<Record<string, unknown>> {
  const out = join(tmpdir(), `af-pitch-${process.pid}-${Date.now()}.json`)
  return new Promise((resolve, reject) => {
    execFile(python, ['-X', 'utf8', scriptPath(), ...args, '--out', out],
      { windowsHide: true, maxBuffer: 1 << 20 }, (err) => {
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(readFileSync(out, 'utf-8')) } catch { /* 없을 수 있다 */ }
        try { rmSync(out, { force: true }) } catch { /* 지우기 실패는 넘긴다 */ }
        if (parsed && parsed.ok === false) { reject(new Error(String(parsed.error))); return }
        if (err && !parsed) { reject(new Error(err.message.slice(0, 300))); return }
        if (!parsed) { reject(new Error('음높이를 읽지 못했습니다')); return }
        resolve(parsed)
      })
  })
}

export function registerPitchIpc(getPython: () => string): void {
  /** 곡선 하나 — 화면이 그린다. */
  ipcMain.handle('pitch:curve', async (
    _e, audio: string, seconds?: number,
  ): Promise<PitchReply<unknown>> => {
    try {
      if (!audio) throw new Error('소리 파일을 고르세요')
      return ok(await runCli(getPython(), [
        'curve', '--audio', audio, '--seconds', String(seconds ?? PREVIEW_SEC),
      ]))
    } catch (e) { return fail(e) }
  })

  /** 손잡이를 먹여 새 소리를 만든다. 빚은 곡선도 함께 돌려준다. */
  ipcMain.handle('pitch:reshape', async (
    _e, audio: string, dest: string,
    knobs: { smooth?: number; spread?: number; shift?: number },
    seconds?: number,
  ): Promise<PitchReply<unknown>> => {
    try {
      if (!audio || !dest) throw new Error('소리 파일과 저장 자리가 필요합니다')
      return ok(await runCli(getPython(), [
        'reshape', '--audio', audio, '--dest', dest,
        '--seconds', String(seconds ?? PREVIEW_SEC),
        '--smooth', String(knobs?.smooth ?? 0),
        '--spread', String(knobs?.spread ?? 1),
        '--shift', String(knobs?.shift ?? 0),
      ]))
    } catch (e) { return fail(e) }
  })

  /** 프로그램이 손잡이를 맞춰 준다 — 사람이 이어받아 돌릴 **같은 손잡이**다. */
  ipcMain.handle('pitch:fit', async (
    _e, target: string, audio: string, seconds?: number,
  ): Promise<PitchReply<unknown>> => {
    try {
      if (!target || !audio) throw new Error('맞출 대상과 원본이 필요합니다')
      return ok(await runCli(getPython(), [
        'fit', '--target', target, '--audio', audio,
        '--seconds', String(seconds ?? PREVIEW_SEC),
      ]))
    } catch (e) { return fail(e) }
  })
}
