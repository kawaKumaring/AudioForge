// 사이드카 이벤트 허용목록/스키마 검증 계약 — Electron·Python·GPU 없이 순수 함수만 검증한다.
//
// 지키려는 것:
//   1) 허용목록은 정확히 셋. 그 밖은 통과 없음(pass-through 금지).
//   2) 경로·오디오 샘플·전사 본문·프롬프트가 envelope 로 한 글자도 새지 않는다.
//      Python 이 회귀해 본문을 다시 실어 보내는 상황을 시뮬레이션해 확인한다.
//   3) 잘못된 payload 는 throw 가 아니라 구조화된 reasonCode 로 거절된다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIDECAR_KINDS,
  SIDECAR_ENVELOPE_VERSION,
  SIDECAR_IPC_CHANNEL,
  MAX_SPEAKER_SLOTS,
  isSidecarKind,
  safeToken,
  auditEnvelope,
  validateSidecarEvent,
  validateMusicP1Shadow,
  validateDialogueSidecar,
  validateAsrTranscriptSidecar,
  type SidecarEnvelope
} from './sidecarEvents.ts'

// ── 실제 Python 방출 형태를 그대로 본뜬 픽스처 ────────────────────────────────
// music_worker._p1_shadow_probe / conversation_worker._build_dialogue_sidecar_payload
// + _attach_interpretation / transcribe_worker._asr_sidecar_payload 기준.

function musicEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'music_p1_shadow',
    status: 'OK',
    offsetFrames: 12,
    polarity: 1,
    gain: 0.998231,
    baselineError: 0.031,
    candidateError: 0.012,
    improvement: 0.019,
    candidateEligible: true,
    elapsedMs: 8.412,
    ...over
  }
}

function dialogueEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'dialogueSidecar',
    schema: 'audioforge/dialogue-canonical',
    schemaVersion: '1.0.0',
    sidecar: {
      schema: 'audioforge/dialogue-canonical',
      schema_version: '1.0.0',
      speakers: ['화자 A', '화자 B'],
      source: { pipeline: 'argmax-mask', frame_rate: '50' },
      segments: [
        {
          start: 0.0, end: 1.2, speakers: ['화자 A'], posterior: { '화자 A': 1.0 },
          confidence: 1.0, status: 'OK', is_backchannel: false, is_overlap: false, words: []
        },
        {
          start: 1.2, end: 1.5, speakers: ['화자 B'], posterior: { '화자 B': 1.0 },
          confidence: 1.0, status: 'OK', is_backchannel: true, is_overlap: false, words: []
        },
        {
          start: 1.5, end: 3.0, speakers: ['화자 A', '화자 B'],
          posterior: { '화자 A': 0.6, '화자 B': 0.4 },
          confidence: 0.6, status: 'REVIEW', is_backchannel: false, is_overlap: true, words: []
        }
      ]
    },
    speakerMeta: [
      { id: '화자 A', trackAvailable: true, trackIndex: 0, reviewRequired: false },
      { id: '화자 B', trackAvailable: false, trackIndex: null, reviewRequired: true }
    ],
    interpretation: {
      schemaVersion: '1.0.0',
      status: 'available',
      experimental: true,
      segments: [{ start: 0, end: 1.2, speakers: ['화자 A'], words: [] }],
      summary: { overlapCount: 1, unknownCount: 0, reviewCount: 2 },
      thresholds: {
        reviewBelow: 0.5,
        unknownBelow: 0.25,
        overlapMinPosterior: 0.3,
        note: 'synthetic 검증값 — 실제 정확도 확정값 아님'
      },
      source: { pipeline: 'posterior-interpret', frameRate: '50' }
    },
    ...over
  }
}

function asrEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'asrTranscriptSidecar',
    schema: 'audioforge/asr-canonical',
    schemaVersion: '1.0.0',
    language: 'ko',
    segmentCount: 2,
    provenance: {
      hallucination_silence_threshold: '2.0',
      model: 'large-v3',
      rms_threshold: '0.01',
      task: 'transcribe'
    },
    segments: [
      {
        start: 0.0, end: 1.5, confidence: 0.94, status: 'OK', has_words: true,
        words: [{ start: 0.0, end: 0.4, probability: 0.99 }],
        no_speech_prob: 0.01, avg_logprob: -0.203, language: 'ko'
      }
    ],
    summary: {
      segment_count: 2, word_count: 7, total_duration_sec: 3.5, language: 'ko',
      status_counts: { OK: 1, LOW_CONFIDENCE: 1 }, has_provenance: true
    },
    ...over
  }
}

function okEnvelope(result: ReturnType<typeof validateSidecarEvent>): SidecarEnvelope {
  assert.equal(result.ok, true, `수용될 payload 인데 거절됨: ${JSON.stringify(result)}`)
  return (result as { ok: true; envelope: SidecarEnvelope }).envelope
}

function rejectionOf(result: { ok: boolean }): string {
  assert.equal(result.ok, false, '거절돼야 하는 payload 가 통과됨')
  return (result as { ok: false; reasonCode: string }).reasonCode
}

// ── 허용목록 ─────────────────────────────────────────────────────────────────

test('허용목록은 정확히 세 종류뿐', () => {
  assert.deepEqual([...SIDECAR_KINDS], [
    'music_p1_shadow',
    'dialogueSidecar',
    'asrTranscriptSidecar'
  ])
  assert.equal(SIDECAR_KINDS.length, 3)
  for (const k of SIDECAR_KINDS) assert.equal(isSidecarKind(k), true)
  // Python 이 실제로 내보내는 '이웃' 이벤트들 — 허용목록에 없으므로 절대 통과하면 안 된다.
  for (const k of ['dialogueSidecarError', 'asrTranscriptSidecarError', 'progress', 'result']) {
    assert.equal(isSidecarKind(k), false, `${k} 는 허용목록에 없어야 한다`)
  }
  assert.equal(SIDECAR_IPC_CHANNEL, 'audio:sidecar')
})

// ── 세 종류 정상 검증·정규화 ─────────────────────────────────────────────────

test('music_p1_shadow: 정상 검증·정규화 (payload 는 schemaVersion 을 선언하지 않는다)', () => {
  const env = okEnvelope(validateSidecarEvent(musicEvent(), 7))
  assert.equal(env.kind, 'music_p1_shadow')
  assert.equal(env.schemaVersion, SIDECAR_ENVELOPE_VERSION)
  assert.equal(env.payloadSchemaVersion, null, 'music_worker 는 스키마 버전을 담지 않는다')
  assert.equal(env.status, 'ok')
  assert.equal(env.sequence, 7)
  assert.equal(env.reasonCode, undefined)
  assert.deepEqual(env.metrics, {
    probeStatus: 'OK',
    candidateEligible: true,
    offsetFrames: 12,
    polarity: 1,
    gain: 0.998231,
    baselineError: 0.031,
    candidateError: 0.012,
    improvement: 0.019,
    elapsedMs: 8.412
  })
})

test('music_p1_shadow: 진단 상태별 envelope status/reasonCode 매핑', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['OK', 'ok', undefined],
    ['P1_SHADOW_SKIPPED', 'unavailable', 'probe-skipped'],
    ['P1_SHADOW_ERROR', 'degraded', 'probe-error'],
    ['MUSIC_P1_NOT_CALIBRATED', 'unavailable', 'probe-not-calibrated']
  ]
  for (const [probeStatus, status, reasonCode] of cases) {
    const env = okEnvelope(validateSidecarEvent(musicEvent({ status: probeStatus }), 1))
    assert.equal(env.status, status, probeStatus)
    assert.equal(env.reasonCode, reasonCode, probeStatus)
    assert.equal((env.metrics as { probeStatus: string }).probeStatus, probeStatus)
  }
})

test('music_p1_shadow: 수치 없는 축약 emit(NOT_CALIBRATED)도 통과 — 선택 필드는 그냥 없다', () => {
  const env = okEnvelope(validateSidecarEvent(
    { type: 'music_p1_shadow', status: 'MUSIC_P1_NOT_CALIBRATED', candidateEligible: false }, 1))
  assert.deepEqual(env.metrics, { probeStatus: 'MUSIC_P1_NOT_CALIBRATED', candidateEligible: false })
})

test('dialogueSidecar: 정상 검증·정규화 (집계만 남고 세그먼트/라벨은 사라진다)', () => {
  const env = okEnvelope(validateSidecarEvent(dialogueEvent(), 3))
  assert.equal(env.kind, 'dialogueSidecar')
  assert.equal(env.payloadSchemaVersion, '1.0.0')
  assert.equal(env.status, 'ok')
  assert.equal(env.sequence, 3)
  assert.deepEqual(env.metrics, {
    speakerCount: 2,
    segmentCount: 3,
    backchannelCount: 1,
    overlapCount: 1,
    frameRate: 50,
    speakers: [
      { trackIndex: 0, trackAvailable: true, reviewRequired: false },
      { trackIndex: null, trackAvailable: false, reviewRequired: true }
    ],
    interpretation: {
      status: 'available',
      experimental: true,
      overlapCount: 1,
      unknownCount: 0,
      reviewCount: 2,
      reviewBelow: 0.5,
      unknownBelow: 0.25,
      overlapMinPosterior: 0.3
    }
  })
  // 표시용 한글 라벨('화자 A')과 thresholds.note 자유 텍스트는 통과하지 않는다.
  const json = JSON.stringify(env)
  assert.equal(json.includes('화자'), false)
  assert.equal(json.includes('synthetic'), false)
})

test('dialogueSidecar: 해석 실패(unavailable) → degraded + interpretation-unavailable, errorCode만 보존', () => {
  const ev = dialogueEvent({
    interpretation: {
      schemaVersion: '1.0.0',
      status: 'unavailable',
      experimental: true,
      segments: [],
      summary: { overlapCount: 0, unknownCount: 0, reviewCount: 0 },
      thresholds: { reviewBelow: 0.5, unknownBelow: 0.25, overlapMinPosterior: 0.3, note: 'x y' },
      source: { pipeline: 'posterior-interpret' },
      errorCode: 'ValueError'
    }
  })
  const env = okEnvelope(validateSidecarEvent(ev, 1))
  assert.equal(env.status, 'degraded')
  assert.equal(env.reasonCode, 'interpretation-unavailable')
  assert.equal((env.metrics as { interpretation: { errorCode: string } }).interpretation.errorCode, 'ValueError')
})

test('dialogueSidecar: interpretation 블록 자체가 없어도 통과하되 degraded 로 표시', () => {
  const ev = dialogueEvent()
  delete ev.interpretation
  const env = okEnvelope(validateSidecarEvent(ev, 1))
  assert.equal(env.status, 'degraded')
  assert.equal(env.reasonCode, 'interpretation-unavailable')
  assert.equal((env.metrics as { interpretation: unknown }).interpretation, null)
})

test('asrTranscriptSidecar: 정상 검증·정규화 (segments 배열은 통째로 버려진다)', () => {
  const env = okEnvelope(validateSidecarEvent(asrEvent(), 11))
  assert.equal(env.kind, 'asrTranscriptSidecar')
  assert.equal(env.payloadSchemaVersion, '1.0.0')
  assert.equal(env.status, 'ok')
  assert.equal(env.sequence, 11)
  assert.deepEqual(env.metrics, {
    language: 'ko',
    segmentCount: 2,
    wordCount: 7,
    totalDurationSec: 3.5,
    statusCounts: { LOW_CONFIDENCE: 1, OK: 1 },
    hasProvenance: true,
    model: 'large-v3',
    task: 'transcribe',
    hallucinationSilenceSec: 2.0,
    rmsThreshold: 0.01
  })
  assert.equal(JSON.stringify(env).includes('probability'), false, 'word 타이밍 배열은 남지 않는다')
})

// ── 민감정보 차단 (Python 회귀 시뮬레이션) ───────────────────────────────────

const WIN_PATH = 'C:\\Users\\kawae\\AudioForge\\out\\vocals.wav'
const POSIX_PATH = '/home/kawae/audioforge/output/speaker_a.wav'
const TRANSCRIPT = '안녕하세요 오늘 회의는 3분기 실적 발표로 시작하겠습니다 자료는 앞에 배포된 대로입니다'
const PROMPT = 'You are a helpful assistant. Transcribe the following audio verbatim.'
const AUDIO_SAMPLES = [0.0123, -0.0456, 0.0789, -0.1011, 0.1213, -0.1415, 0.1617]

function assertNoLeak(env: SidecarEnvelope): void {
  const json = JSON.stringify(env)
  for (const needle of ['C:\\', 'Users', '/home/', '.wav', '안녕하세요', '회의', 'helpful assistant', '0.0123']) {
    assert.equal(json.includes(needle), false, `envelope 에 '${needle}' 가 새어나왔다: ${json}`)
  }
  assert.equal(auditEnvelope(env), true, 'audit 을 통과해야 한다')
}

test('민감정보: 화이트리스트 밖 최상위 필드(경로·프롬프트·샘플)는 흔적 없이 사라진다', () => {
  const contaminated = {
    outputPath: WIN_PATH,
    inputPath: POSIX_PATH,
    prompt: PROMPT,
    waveform: AUDIO_SAMPLES,
    transcript: TRANSCRIPT
  }
  assertNoLeak(okEnvelope(validateSidecarEvent(musicEvent(contaminated), 1)))
  assertNoLeak(okEnvelope(validateSidecarEvent(dialogueEvent(contaminated), 2)))
  assertNoLeak(okEnvelope(validateSidecarEvent(asrEvent(contaminated), 3)))
})

test('민감정보: 화이트리스트 *안* 필드에 경로/본문/샘플이 들어와도 그 필드만 제거된다', () => {
  // 수치 필드 자리에 오디오 표본 배열 / 경로 문자열이 회귀한 상황.
  const env = okEnvelope(validateSidecarEvent(musicEvent({
    gain: AUDIO_SAMPLES,
    baselineError: WIN_PATH,
    improvement: TRANSCRIPT,
    offsetFrames: POSIX_PATH,
    elapsedMs: PROMPT
  }), 1))
  assertNoLeak(env)
  assert.deepEqual(env.metrics, {
    probeStatus: 'OK',
    candidateEligible: true,
    polarity: 1,
    candidateError: 0.012
  }, '오염된 수치 필드는 전부 사라지고 멀쩡한 것만 남는다')
})

test('민감정보: asr provenance/language 에 경로·본문이 오면 그 필드는 null 이 된다', () => {
  const env = okEnvelope(validateSidecarEvent(asrEvent({
    language: TRANSCRIPT,
    provenance: {
      model: 'C:\\models\\whisper\\large-v3.pt',
      task: '/opt/whisper/transcribe',
      hallucination_silence_threshold: POSIX_PATH,
      rms_threshold: '0.01'
    }
  }), 1))
  assertNoLeak(env)
  const m = env.metrics as Record<string, unknown>
  assert.equal(m.language, null)
  assert.equal(m.model, null)
  assert.equal(m.task, null)
  assert.equal(m.hallucinationSilenceSec, null)
  assert.equal(m.rmsThreshold, 0.01, '멀쩡한 이웃 필드는 살아남는다')
})

test('민감정보: dialogue 세그먼트에 전사 본문(words[].text)이 되돌아와도 집계만 나간다', () => {
  const ev = dialogueEvent()
  const sidecar = ev.sidecar as { segments: Array<Record<string, unknown>> }
  sidecar.segments[0].words = [
    { text: TRANSCRIPT, start: 0.0, end: 1.2, speaker: '화자 A', confidence: 0.9 }
  ]
  sidecar.segments[0].sourcePath = WIN_PATH
  const env = okEnvelope(validateSidecarEvent(ev, 1))
  assertNoLeak(env)
  assert.equal((env.metrics as { segmentCount: number }).segmentCount, 3, '개수는 그대로 관측된다')
})

test('민감정보: asr summary.status_counts 의 비-enum 키(경로 등)는 항목째 버려진다', () => {
  const env = okEnvelope(validateSidecarEvent(asrEvent({
    summary: {
      segment_count: 1, word_count: 1, total_duration_sec: 1, language: 'ko',
      status_counts: { OK: 1, [WIN_PATH]: 3, [TRANSCRIPT]: 2 }, has_provenance: true
    }
  }), 1))
  assertNoLeak(env)
  assert.deepEqual((env.metrics as { statusCounts: unknown }).statusCounts, { OK: 1 })
})

test('safeToken: 경로·본문·프롬프트·빈문자·긴문자를 전부 거절한다', () => {
  for (const bad of [WIN_PATH, POSIX_PATH, TRANSCRIPT, PROMPT, '', ' ', 'a'.repeat(65),
    'C:/x', './rel', '../up', 'has space', '화자', 42, null, undefined, AUDIO_SAMPLES]) {
    assert.equal(safeToken(bad), null, `거절돼야 함: ${String(bad)}`)
  }
  for (const good of ['ko', 'large-v3', 'OK', '1.0.0', 'audioforge', 'music_p1_shadow']) {
    assert.equal(safeToken(good), good)
  }
})

test('audit: envelope 에 안전하지 않은 문자열이 섞이면 통과를 취소한다(2차 방어선)', () => {
  const env = okEnvelope(validateSidecarEvent(asrEvent(), 1))
  assert.equal(auditEnvelope(env), true)
  const tampered = { ...env, metrics: { ...env.metrics, model: WIN_PATH } } as unknown as SidecarEnvelope
  assert.equal(auditEnvelope(tampered), false)
})

// ── 구조화 거절 (throw 금지) ─────────────────────────────────────────────────

test('unknown kind → unknown-kind 거절, throw 없음', () => {
  for (const type of ['dialogueSidecarError', 'asrTranscriptSidecarError', 'music_p1_live', 'progress', '']) {
    assert.equal(rejectionOf(validateSidecarEvent({ type, anything: 1 }, 1)), 'unknown-kind', type)
  }
})

test('객체가 아닌 입력 → not-an-object 거절, throw 없음', () => {
  for (const raw of [null, undefined, 42, 'text', true, [1, 2, 3]]) {
    assert.equal(rejectionOf(validateSidecarEvent(raw, 1)), 'not-an-object', String(raw))
  }
})

test('schemaVersion 누락 → schema-version-missing (선언이 필수인 kind 에서만)', () => {
  const dlg = dialogueEvent(); delete dlg.schemaVersion
  assert.equal(rejectionOf(validateSidecarEvent(dlg, 1)), 'schema-version-missing')
  const asr = asrEvent(); delete asr.schemaVersion
  assert.equal(rejectionOf(validateSidecarEvent(asr, 1)), 'schema-version-missing')
  // music 은 애초에 선언하지 않으므로 누락이 정상이다.
  assert.equal(validateSidecarEvent(musicEvent(), 1).ok, true)
})

test('schemaVersion 형식 오류 → schema-version-invalid', () => {
  for (const bad of ['1.0', 'v1.0.0', WIN_PATH, '', 1, null_ish(), { a: 1 }, [1]]) {
    assert.equal(rejectionOf(validateSidecarEvent(dialogueEvent({ schemaVersion: bad }), 1)),
      'schema-version-invalid', String(bad))
  }
  function null_ish(): unknown { return Number.NaN }
})

test('지원하지 않는 major → schema-version-unsupported (조용한 통과 금지)', () => {
  assert.equal(rejectionOf(validateSidecarEvent(dialogueEvent({ schemaVersion: '2.0.0' }), 1)),
    'schema-version-unsupported')
  assert.equal(rejectionOf(validateSidecarEvent(asrEvent({ schemaVersion: '0.9.0' }), 1)),
    'schema-version-unsupported')
  // 같은 major 의 minor/patch 상승은 받아들인다(additive 확장).
  assert.equal(validateSidecarEvent(dialogueEvent({ schemaVersion: '1.4.2' }), 1).ok, true)
})

test('metrics 구조 위반 → metrics-invalid', () => {
  assert.equal(rejectionOf(validateSidecarEvent(musicEvent({ status: 'WAT' }), 1)), 'metrics-invalid')
  assert.equal(rejectionOf(validateSidecarEvent(musicEvent({ status: WIN_PATH }), 1)), 'metrics-invalid')
  const noSidecar = dialogueEvent(); delete noSidecar.sidecar
  assert.equal(rejectionOf(validateSidecarEvent(noSidecar, 1)), 'metrics-invalid')
  assert.equal(rejectionOf(validateSidecarEvent(dialogueEvent({ speakerMeta: 'nope' }), 1)), 'metrics-invalid')
  const noSummary = asrEvent(); delete noSummary.summary
  assert.equal(rejectionOf(validateSidecarEvent(noSummary, 1)), 'metrics-invalid')
  assert.equal(rejectionOf(validateSidecarEvent(asrEvent({ segmentCount: -1 }), 1)), 'metrics-invalid')
})

test('화자 슬롯 상한 초과 → bounds-exceeded (방어적 거절)', () => {
  const many = Array.from({ length: MAX_SPEAKER_SLOTS + 1 }, (_v, i) => ({
    id: `s${i}`, trackAvailable: true, trackIndex: i, reviewRequired: false
  }))
  assert.equal(rejectionOf(validateSidecarEvent(dialogueEvent({ speakerMeta: many }), 1)), 'bounds-exceeded')
})

test('kind 별 검증기는 다른 kind 의 payload 를 받지 않는다', () => {
  assert.equal(rejectionOf(validateMusicP1Shadow(dialogueEvent(), 1)), 'unknown-kind')
  assert.equal(rejectionOf(validateDialogueSidecar(asrEvent(), 1)), 'unknown-kind')
  assert.equal(rejectionOf(validateAsrTranscriptSidecar(musicEvent(), 1)), 'unknown-kind')
})

// ── 결정성 ───────────────────────────────────────────────────────────────────

test('결정적: 같은 입력·같은 sequence → 같은 envelope (시계 의존 없음)', () => {
  const a = okEnvelope(validateSidecarEvent(dialogueEvent(), 5))
  const b = okEnvelope(validateSidecarEvent(dialogueEvent(), 5))
  assert.deepEqual(a, b)
  const c = okEnvelope(validateSidecarEvent(dialogueEvent(), 6))
  assert.equal(c.sequence, 6)
  assert.notDeepEqual(a, c)
})

test('jobId: 안전 토큰이면 보존, 아니면 조용히 제거', () => {
  const good = okEnvelope(validateSidecarEvent(musicEvent({ jobId: 'job-42' }), 1))
  assert.equal(good.jobId, 'job-42')
  const bad = okEnvelope(validateSidecarEvent(musicEvent({ jobId: WIN_PATH }), 1))
  assert.equal(bad.jobId, undefined)
  assertNoLeak(bad)
})
