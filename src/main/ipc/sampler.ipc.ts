// 감정 샘플러 IPC — 논리 ID 만 오가는 얇은 계층.
//
// 규칙은 서비스가 갖는다: 캐시 규칙은 sampler-cache, 요청 해석은 sampler-request,
// 실행 오케스트레이션은 sampler-generation. 여기서는 입력을 검증해 넘기고
// 응답에서 경로·전사·대본을 걷어내는 일만 한다.
//
// audio.ipc 를 import 하지 않는다(순환 의존 회피). 실행기는 adapter 로 주입받는다.
import { ipcMain } from 'electron'
import { resolveSamplerRequest, type SamplerConfigInput, type SamplerRequestDeps } from '../services/sampler-request'
import type { SamplerCache } from '../services/sampler-cache'
import type { SamplerRunner } from '../services/sampler-generation'
import { createSamplerGenerator } from '../services/sampler-generation'
import {
  SAMPLER_CHANNELS, samplerPreviewUrl,
  type SamplerCacheKeyRequest, type SamplerGenerateFailure, type SamplerGenerateRequest,
  type SamplerGenerateResponse, type SamplerInventoryResponse,
  type SamplerPreviewUrlResponse, type SamplerRemoveResponse,
} from '../../shared/samplerApi'

export interface SamplerIpcDeps {
  cache: SamplerCache
  runner: SamplerRunner
  requestDeps: SamplerRequestDeps
  settings: () => SamplerConfigInput
  /** 선택된 참조의 논리 ID. renderer 가 보낸 값보다 이쪽을 신뢰한다. */
  readSelectedReferenceId: () => string | null
  /** 합성·분석이 돌고 있어 지금 실행할 수 없으면 사유, 가능하면 null. */
  busyReason: () => string | null
  makeRunId: () => string
}

const KEY_RE = /^[0-9a-f]{64}$/
const ID_RE = /^[0-9a-f]{16}$/

export function registerSamplerIpc(deps: SamplerIpcDeps): void {
  const generator = createSamplerGenerator({
    cache: deps.cache,
    runner: deps.runner,
    makeRunId: deps.makeRunId,
  })

  ipcMain.handle(
    SAMPLER_CHANNELS.generate,
    async (_event, request: SamplerGenerateRequest): Promise<SamplerGenerateResponse> => {
      const rowId = String(request?.rowId ?? '')
      const asked = String(request?.referenceId ?? '').trim().toLowerCase()
      // renderer 가 보낸 참조 id 는 '무엇을 고른 상태였는지' 확인용일 뿐이고,
      // 실제 권위는 main 이 들고 있는 선택 상태다.
      const selected = deps.readSelectedReferenceId()
      if (!selected || !ID_RE.test(selected) || (asked && asked !== selected)) {
        return { ok: false, rowId, reason: 'NO_REFERENCE_SELECTED' }
      }

      if (deps.busyReason()) return { ok: false, rowId, reason: 'BUSY' }

      const resolved = resolveSamplerRequest(deps.requestDeps, {
        referenceId: selected, rowId, settings: deps.settings(),
      })
      if (!resolved.ok) return { ok: false, rowId, reason: resolved.reason }

      const run = await generator.generate(resolved)
      if (run.status === 'ready') {
        return { ok: true, rowId, cacheKey: run.cacheKey, reused: run.reused }
      }
      const reason: SamplerGenerateFailure =
        run.status === 'cancelled' ? 'CANCELLED'
          : run.status === 'limitExceeded' ? 'LIMIT_EXCEEDED'
            : (run.reason as SamplerGenerateFailure) ?? 'RUN_FAILED'
      return { ok: false, rowId, reason }
    },
  )

  ipcMain.handle(SAMPLER_CHANNELS.inventory, (): SamplerInventoryResponse => ({
    keys: deps.cache.inventory(),
  }))

  ipcMain.handle(
    SAMPLER_CHANNELS.remove,
    (_event, request: SamplerCacheKeyRequest): SamplerRemoveResponse => {
      const key = String(request?.cacheKey ?? '').trim().toLowerCase()
      if (!KEY_RE.test(key)) return { ok: false, reason: 'INVALID_KEY' }
      const res = deps.cache.remove(key)
      if (res.ok) return { ok: true }
      // 삭제 경로에서 나올 수 있는 사유만 밖으로 내보낸다(공개 계약을 좁게 유지).
      const reason = res.reason === 'NOT_FOUND' || res.reason === 'NOT_OWNED' || res.reason === 'INVALID_KEY'
        ? res.reason : 'DELETE_FAILED'
      return { ok: false, reason }
    },
  )

  ipcMain.handle(
    SAMPLER_CHANNELS.previewUrl,
    (_event, request: SamplerCacheKeyRequest): SamplerPreviewUrlResponse => {
      const key = String(request?.cacheKey ?? '').trim().toLowerCase()
      if (!KEY_RE.test(key)) return { ok: false, reason: 'INVALID_KEY' }
      const found = deps.cache.resolveFile(key)
      if (!found.ok) {
        return { ok: false, reason: found.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'NOT_OWNED' }
      }
      // 주소에는 키만 들어간다. 실제 경로는 프로토콜 핸들러가 main 안에서 다시 해석한다.
      return { ok: true, url: samplerPreviewUrl(key) }
    },
  )
}

/**
 * local-file 프로토콜의 캐시 전용 형식을 실제 경로로 바꾼다.
 * 64자리 소문자 hex 만 받고, 캐시 루트 밖은 어떤 경우에도 열지 않는다.
 * 이 함수가 null 을 주면 호출부는 요청을 거절해야 한다.
 */
export function resolveSamplerPreviewPath(cache: SamplerCache, rest: string): string | null {
  const key = String(rest ?? '').trim().toLowerCase()
  if (!KEY_RE.test(key)) return null
  const found = cache.resolveFile(key)
  return found.ok ? found.filePath : null
}
