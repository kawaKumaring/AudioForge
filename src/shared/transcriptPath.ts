/**
 * 받아쓴 파일을 읽을 때의 **경계** — 결과 폴더 밖으로 나가지 않는다.
 *
 * 규칙을 본체(IPC)가 아니라 여기 두는 이유: 본체는 electron 을 물어 검사가 무거워진다.
 * 판정은 순수 함수여야 마음껏 검사할 수 있다.
 */
import { isAbsolute, join, resolve, sep } from 'node:path'

export const DIALOGUE_TRANSCRIPT_CHANNEL = 'dialogue:read-transcript'
/** 받아쓴 구간 파일은 작다. 이보다 크면 우리가 만든 것이 아니다. */
export const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024

/** 폴더 바로 아래의 이 이름을 읽어도 되는가. 안 되면 사유를 돌려준다. */
export function transcriptFault(dir: string, name: string): string {
  if (!dir || !isAbsolute(dir)) return 'DIR_NOT_ABSOLUTE'
  if (!name) return 'NAME_EMPTY'
  if (name.includes('/') || name.includes('\\')) return 'NAME_HAS_PATH'
  if (name === '.' || name === '..' || name.startsWith('..')) return 'NAME_TRAVERSAL'
  if (!/\.txt$/i.test(name)) return 'NAME_NOT_TEXT'
  const full = resolve(join(dir, name))
  const base = resolve(dir)
  if (full !== join(base, name) || !full.startsWith(base + sep)) return 'OUT_OF_DIR'
  return ''
}

