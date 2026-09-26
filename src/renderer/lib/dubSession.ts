import type { DubFrontResult, DubRenderResult } from '../../shared/dubbing'
import type { CommittedRef } from '../../shared/voicePreparation'

/** 현재 더빙 한 개의 화면 상태. 앱 실행 중 메뉴 왕복에만 쓰며 디스크에는 저장하지 않는다. */
export interface DubSession {
  videoPath: string
  workDir: string
  workRoot: string
  front: DubFrontResult | null
  edits: Record<number, string>
  takes: Record<number, string>
  tailCut: Record<number, boolean>
  report: DubRenderResult | null
  voice: { path: string; ref: CommittedRef | null; message: string }
  register: '' | 'casual' | 'polite'
}

export function createDubSession() {
  let current: DubSession = {
    videoPath: '', workDir: '', workRoot: '', front: null,
    edits: {}, takes: {}, tailCut: {}, report: null,
    voice: { path: '', ref: null, message: '' }, register: 'casual',
  }
  return {
    read: (): DubSession => current,
    write: (next: DubSession): void => {
      // 명시된 작업 데이터만 보존한다. busy/재생/진행 메시지/콜백은 이곳에 들어오지 않는다.
      current = {
        videoPath: next.videoPath, workDir: next.workDir, workRoot: next.workRoot,
        front: next.front, edits: next.edits, takes: next.takes, tailCut: next.tailCut,
        report: next.report, voice: next.voice, register: next.register,
      }
    },
  }
}

// 화면이 언마운트되어도 살아 있는 단 하나의 슬롯. 새 앱 실행에서는 빈 상태로 시작한다.
export const dubSession = createDubSession()
