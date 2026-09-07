// 사라진 참조 클립을 합성 직전에 **스스로 다시 만든다.**
//
// 왜: 예전에는 확정한 클립 파일이 없으면 합성이 "확정한 참조 클립이 만료되었습니다 — 참조 구간을
// 다시 확정하세요" 로 끝났다. 사용자는 인물마다 구간을 손으로 다시 확정해야 했다.
// 그런데 우리는 그 클립을 다시 만들 재료를 이미 다 갖고 있다 — 원본 경로와 확정 구간이다.
// 그러니 물어볼 것이 없다. 다시 만들고 그대로 이어서 합성한다.
//
// '만료' 는 시간 문제가 아니었다: 클립 폴더가 지워지면(다른 인스턴스의 시작 정리·OS 임시파일 청소·
// 수동 삭제) 파일이 사라진다. 위치를 앱 전용 폴더로 옮겨 원인을 줄였고, 이 훅은 그래도 사라진
// 경우의 회복이다. 둘은 별개다 — 원인 제거와 회복을 함께 둔다.
//
// 규칙
//  · **구간이 확정된 슬롯만** 다시 만든다. 구간이 없으면(원본 전체 사용) 만들 것이 없다.
//  · 원본이 없으면 다시 만들 수 없다 — 그 슬롯은 건드리지 않고 사유를 그대로 남긴다(조용한 성공 금지).
//  · 다시 만들기가 실패하면 합성을 막지 않는다. 기존 오류 경로가 그대로 사유를 말한다.
import { useCallback } from 'react'

import { useAppStore } from '@/stores/app.store'

export interface ClipRecoveryReport {
  /** 다시 만든 슬롯 수. */
  rebuilt: number
  /** 사라졌는데 다시 만들지 못한 슬롯(원본 없음·트림 실패). */
  failed: string[]
  /** 확인한 슬롯 수. */
  checked: number
}

interface Slot {
  key: string                 // 'default' | 'spk:<id>'
  label: string               // 사람에게 보일 이름
  source: string              // 원본 경로
  clip: string                // 지금 쓰고 있다고 알고 있는 클립 경로
  region: { start: number; duration: number } | null
  apply: (clip: string) => void
}

/** 파일이 살아 있는가 — 지문이 빈 문자열이면 없거나 읽을 수 없다. */
async function alive(path: string): Promise<boolean> {
  if (!path) return false
  try { return String((await window.api.audio.fingerprintReference(path)) || '') !== '' } catch { return false }
}

export function useClipRecovery(opts: {
  speakerLabelOf: (id: string) => string
  ttsEngine: string
}) {
  const { speakerLabelOf, ttsEngine } = opts

  return useCallback(async (
    onProgress?: (message: string) => void,
  ): Promise<ClipRecoveryReport> => {
    const s = useAppStore.getState()
    const slots: Slot[] = []
    // 기본 목소리
    if (s.ttsReferenceClip && s.ttsReferenceRegion && s.fileInfo?.path) {
      slots.push({
        key: 'default', label: '기본 목소리',
        source: s.fileInfo.path, clip: s.ttsReferenceClip, region: s.ttsReferenceRegion,
        apply: (clip) => useAppStore.getState().setTtsRefState({ clip }),
      })
    }
    // 인물별 목소리
    for (const [id, st] of Object.entries(s.ttsSpeakerRefState)) {
      if (!st?.clip || !st.region || !st.source) continue
      slots.push({
        key: 'spk:' + id, label: speakerLabelOf(id),
        source: st.source, clip: st.clip, region: st.region,
        apply: (clip) => useAppStore.getState().setSpeakerRefState(id, { clip }),
      })
    }

    const report: ClipRecoveryReport = { rebuilt: 0, failed: [], checked: slots.length }
    for (const slot of slots) {
      if (await alive(slot.clip)) continue                 // 멀쩡하다 — 손대지 않는다
      if (!(await alive(slot.source))) {                    // 원본이 없으면 다시 만들 수 없다
        report.failed.push(`${slot.label}: 원본 파일을 찾을 수 없습니다`)
        continue
      }
      onProgress?.(`${slot.label}의 목소리 구간을 다시 준비합니다...`)
      try {
        const raw = await window.api.audio.trimReference(
          slot.source, slot.region!.start, slot.region!.duration, slot.key, { ttsEngine },
        ) as Record<string, unknown>
        const clip = typeof raw?.clip_path === 'string' ? raw.clip_path : ''
        const failedCall = raw?.status === 'failed' || typeof raw?.code === 'string'
        if (!clip || failedCall) {
          report.failed.push(`${slot.label}: 구간을 다시 만들지 못했습니다`)
          continue
        }
        slot.apply(clip)
        report.rebuilt += 1
      } catch (e) {
        report.failed.push(`${slot.label}: ${(e as Error)?.message || '구간 재생성 실패'}`)
      }
    }
    return report
  }, [speakerLabelOf, ttsEngine])
}
