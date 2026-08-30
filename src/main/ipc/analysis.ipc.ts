import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import {
  ANALYSIS_CANCEL_CHANNEL, ANALYSIS_CHANNEL, toAnalysisResult,
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

export function registerAnalysisIpc(deps: { pythonPath: () => string }): AnalysisWorker {
  worker = new AnalysisWorker({
    spawn: spawn as never,
    pythonPath: deps.pythonPath,
    scriptPath: () => join(__dirname, '..', '..', 'python', 'analysis_worker.py'),
  })

  ipcMain.handle(ANALYSIS_CHANNEL, async (_e, req: AnalysisRequest): Promise<AnalysisResponse> => {
    const requestId = String(req?.requestId ?? '')
    const text = typeof req?.text === 'string' ? req.text : ''
    if (!requestId) {
      return { ok: false, requestId, code: 'ANALYSIS_FAILED', reason: 'MISSING_REQUEST_ID' }
    }
    const raw = await worker!.analyze({
      requestId, text,
      mode: req?.mode, referenceConditioningMode: req?.referenceConditioningMode,
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
  return worker
}

/** 앱 종료 정리. 남은 요청은 취소로 답하고 프로세스를 닫는다. */
export function disposeAnalysisIpc(): void {
  worker?.dispose()
  worker = null
}
