/**
 * 파일 대화상자가 **어느 폴더에서 열릴지 우리가 정한다** — 용도별로 따로 기억한다.
 *
 * ★왜 필요한가(2026-09-25 사용자 신고)
 *   "다른 Electron 툴을 쓰고 나면 불러오는 위치가 그 툴의 폴더로 잡힌다."
 *
 *   대화상자에 시작 폴더를 주지 않으면 운영체제가 정한다. 그 기억은 **실행 파일
 *   이름 단위**로 저장되는데(레지스트리에서 실측), 이 앱은 아직 배포 exe 가 없어
 *   개발 실행이 `electron.exe` 로 뜬다 — 같은 방식으로 띄우는 다른 툴들과
 *   **기억 한 칸을 나눠 쓴다.**
 *
 *   ★그 인과는 아직 실사용으로 확인하지 못했다. 다만 고칠 이유는 인과와 무관하다 —
 *     시작 폴더를 주지 않으면 **어디서 열릴지 우리가 정하지 못한다.**
 *
 * ★적용 범위가 모자랐던 것이지 새 결함이 아니다
 *   2026-08-16 에 같은 신고를 받아 이미 고쳤는데, **아홉 자리 중 한 곳만** 덮었다.
 *   그리고 그 한 곳마저 지금 무력화돼 있었다 — 기억해 둔 폴더가 저장소 이동으로
 *   사라져서 값이 `undefined` 로 떨어지고, 나머지 여덟과 똑같은 상태가 됐다(실측).
 *
 * ★그래서 이 모듈의 핵심은 슬롯이 아니라 **비어서 돌아가지 않는 것**이다.
 *   기억한 폴더가 사라졌으면 **살아 있는 가장 가까운 윗폴더**로 내려앉고,
 *   그것도 없으면 용도별 기본값으로 간다. 마지막까지 빈손으로 돌아가지 않는다.
 *
 * electron 을 import 하지 않는다 — 읽기·쓰기·기본값을 전부 주입받아 `node --test` 로 눌러 본다.
 */
import { existsSync, statSync } from 'fs'
import { dirname } from 'path'

/**
 * 기억하는 용도. **한 통에 몰면 서로를 덮는다** — 영상을 한 번 고르면 다음에 음원을
 * 고를 때 영상 폴더가 뜬다. 그래서 나눈다.
 */
export type FolderSlot =
  | 'source'   // 작업할 음원
  | 'voice'    // 참조 목소리·인물 목소리
  | 'video'    // 더빙할 영상
  | 'export'   // 내보내기·저장
  | 'restore'  // 이전 결과 폴더 열기
  | 'python'   // 파이썬 실행 파일

export const FOLDER_SLOTS: readonly FolderSlot[] =
  ['source', 'voice', 'video', 'export', 'restore', 'python'] as const

/**
 * 설정 파일에 쓰는 이름.
 * ★`source` 만 옛 이름(`lastDir`)을 그대로 쓴다 — 이미 쓰고 있던 값을 버리지 않는다.
 */
export const SLOT_KEY: Record<FolderSlot, string> = {
  source: 'lastDir',
  voice: 'lastVoiceDir',
  video: 'lastVideoDir',
  export: 'lastExportDir',
  restore: 'lastRestoreDir',
  python: 'lastPythonDir',
}

/**
 * 그 용도에 값이 없을 때 **어느 용도를 대신 볼지.**
 * 참조 목소리는 대개 작업 음원과 같은 자리에 있고, 영상도 그렇다.
 * 내보내기·결과 폴더도 원본 근처가 자연스럽다.
 * ★`python` 은 비워 둔다 — 실행 파일을 음원 폴더에서 찾게 하면 더 헷갈린다.
 */
const BORROW: Partial<Record<FolderSlot, FolderSlot>> = {
  voice: 'source',
  video: 'source',
  export: 'source',
  restore: 'source',
}

export interface FolderHost {
  /** 설정에서 읽는다. 없으면 undefined. */
  read: (key: string) => unknown
  /** 설정에 쓴다. 실패해도 던지지 않는다 — 폴더 기억 때문에 작업이 멈추면 안 된다. */
  write: (key: string, value: string) => void
  /** 그 용도의 마지막 보루. 없으면 undefined 를 줘도 된다. */
  fallback: (slot: FolderSlot) => string | undefined
  /** 폴더가 실제로 있는지. 검사에서 갈아 끼운다. */
  exists?: (p: string) => boolean
}

const isDir = (host: FolderHost, p: string): boolean => {
  const fn = host.exists
  if (fn) return fn(p)
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 사라진 폴더에서 **살아 있는 가장 가까운 윗폴더**로 내려앉는다.
 *
 * ★이것이 없으면 폴더 하나가 사라진 순간 운영체제 기억으로 되돌아간다 —
 *   실제로 저장소를 옮긴 뒤 그렇게 됐다. 윗폴더는 대개 사용자가 찾던 그 근처다.
 */
export function nearestExisting(host: FolderHost, path: string | undefined): string | undefined {
  if (!path) return undefined
  let cur = path
  for (let i = 0; i < 40; i++) {
    if (isDir(host, cur)) return cur
    const up = dirname(cur)
    if (!up || up === cur) return undefined
    cur = up
  }
  return undefined
}

/**
 * 이 용도의 대화상자를 **어느 폴더에서 열 것인가.**
 *
 * 순서: 그 용도의 기억 → (사라졌으면) 살아 있는 윗폴더 → 빌려 보는 용도 → 마지막 보루.
 * 어느 것도 없으면 undefined — 그때만 운영체제가 정한다.
 */
export function startDir(host: FolderHost, slot: FolderSlot): string | undefined {
  const seen = new Set<FolderSlot>()
  let cur: FolderSlot | undefined = slot
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const raw = host.read(SLOT_KEY[cur])
    const hit = nearestExisting(host, typeof raw === 'string' && raw ? raw : undefined)
    if (hit) return hit
    cur = BORROW[cur]
  }
  const last = host.fallback(slot)
  return last && isDir(host, last) ? last : undefined
}

/**
 * 사용자가 고른 자리를 기억한다. **폴더만** 남긴다.
 *
 * 값이 없거나 그 폴더가 없으면 아무것도 하지 않는다 — 죽은 경로를 기억하면
 * 다음에 또 빈손이 된다.
 */
export function rememberDir(host: FolderHost, slot: FolderSlot, dir: string | undefined): void {
  if (!dir || !isDir(host, dir)) return
  if (host.read(SLOT_KEY[slot]) === dir) return      // 같은 값을 다시 쓰지 않는다
  try {
    host.write(SLOT_KEY[slot], dir)
  } catch {
    /* 폴더 기억 실패가 작업을 멈추면 안 된다 */
  }
}

/** 고른 **파일** 경로에서 그 폴더를 기억한다. */
export function rememberFile(host: FolderHost, slot: FolderSlot, filePath: string | undefined): void {
  if (!filePath) return
  rememberDir(host, slot, dirname(filePath))
}

/**
 * 저장 대화상자에 줄 값 — **폴더 + 제안할 파일 이름.**
 *
 * ★파일 이름만 주면 폴더는 여전히 운영체제가 정한다. 실제로 두 자리가 그랬다.
 */
export function saveTarget(
  host: FolderHost, slot: FolderSlot, fileName: string,
  join: (a: string, b: string) => string,
): string {
  const dir = startDir(host, slot)
  return dir ? join(dir, fileName) : fileName
}
