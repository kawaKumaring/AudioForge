import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import {
  ANALYSIS_CANCEL_CHANNEL, ANALYSIS_CHANNEL, ANALYSIS_PREWARM_CHANNEL, toAnalysisResult,
  type AnalysisRequest, type AnalysisResponse,
} from '../../shared/inputAnalysis'
import { AnalysisWorker, sha256Hex } from '../services/analysis-worker'

/**
 * 입력 분석 read-only IPC.
 *
 * 여기서 하는 일은 세 가지뿐이다 — 상주 worker 에 넘기고, 스키마를 맞추고, 늦은 응답을 버린다.
 * 분석 실패는 **오류가 아니라 상태**다: 합성은 그대로 가능해야 하므로 예외를 던지지 않고
 * 언제나 구조화된 응답을 돌려준다.
 */
let worker: AnalysisWorker | null = null

/** 진단 한 줄. 사용자 원문은 절대 넣지 않는다 — 신원·상태·수치만. */
function note(event: string, fields: Record<string, unknown>): void {
  try { console.log('[analysis]', event, JSON.stringify(fields)) } catch { /* 무시 */ }
}

export function registerAnalysisIpc(deps: { pythonPath: () => string }): AnalysisWorker {
  worker = new AnalysisWorker({
    spawn: spawn as never,
    pythonPath: deps.pythonPath,
    scriptPath: () => join(__dirname, '..', '..', 'python', 'analysis_worker.py'),
    // 진단은 사유 코드와 수치만 남긴다 — 사용자 원문은 넘어오지 않는다(계약).
    onEvent: note,
  })

  ipcMain.handle(ANALYSIS_CHANNEL, async (_e, req: AnalysisRequest): Promise<AnalysisResponse> => {
    const requestId = String(req?.requestId ?? '')
    const text = typeof req?.text === 'string' ? req.text : ''
    if (!requestId) {
      return { ok: false, requestId, code: 'ANALYSIS_FAILED', reason: 'MISSING_REQUEST_ID' }
    }
    // 요청 하나가 어디까지 갔는지 화면 밖에서 읽을 수 있어야 한다. 같은 증상을 세 번
    // 추적하는 동안 renderer 로그만 있고 main·worker 구간이 비어 있었다.
    // 남기는 것은 **신원과 수치뿐** — requestId·SHA 앞자리·상태·코드·소요 시간이다.
    const t0 = Date.now()
    const raw = await worker!.analyze({
      requestId, text,
      mode: req?.mode, referenceConditioningMode: req?.referenceConditioningMode,
    })
    note('ipc', {
      requestId, sha8: sha256Hex(text).slice(0, 8),
      // worker 가 되돌려준 신원 — 이 값이 있으면 Python 까지 갔다 왔다는 뜻이다.
      workerRequestId: typeof raw?.request_id === 'string' ? raw.request_id : null,
      ok: raw?.ok === true, code: raw?.ok === true ? undefined : String(raw?.code ?? '?'),
      ms: Date.now() - t0,
    })
    if (!raw || raw.ok !== true) {
      const code = String(raw?.code ?? 'ANALYSIS_FAILED')
      return {
        ok: false, requestId,
        code: (['WORKER_UNAVAILABLE', 'WORKER_TIMEOUT', 'SUPERSEDED', 'SOURCE_SHA_MISMATCH',
          'CANCELLED'].includes(code) ? code : 'ANALYSIS_FAILED') as never,
        reason: typeof raw?.message === 'string' ? String(raw.message) : undefined,
      }
    }
    const result = toAnalysisResult(requestId, raw)
    if (!result) {
      return { ok: false, requestId, code: 'SCHEMA_MISMATCH' }
    }
    // worker 가 준 SHA 와 우리가 보낸 원문의 SHA 가 다르면 그 결과는 다른 입력의 것이다.
    if (result.sourceSha256 !== sha256Hex(text)) {
      return { ok: false, requestId, code: 'SOURCE_SHA_MISMATCH' }
    }
    return { ok: true, requestId, result }
  })

  ipcMain.handle(ANALYSIS_CANCEL_CHANNEL, () => ({ cancelled: worker!.cancelPending() }))
  // 낮은 우선순위 준비. 실패는 조용히 false 이고 사용자 작업을 막지 않는다.
  ipcMain.handle(ANALYSIS_PREWARM_CHANNEL, async () => ({ ready: await worker!.prewarm() }))
  return worker
}

/** 앱 종료 정리. 남은 요청은 취소로 답하고 프로세스를 닫는다. */
export function disposeAnalysisIpc(): void {
  worker?.dispose()
  worker = null
}
