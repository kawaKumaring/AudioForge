// RIFF/WAVE 검증기 단위테스트 — 전부 합성 바이트. 파일·오디오·GPU 없음.
//
// 지키는 것:
//   1) 44바이트 고정 헤더를 가정하지 않는다(앞에 다른 청크가 와도 읽는다)
//   2) 잘린 파일을 정상으로 읽지 않는다(청크가 파일 밖으로 나가면 거부)
//   3) 정수 PCM 만 받아들이고, float·해석 불가 extensible 은 거부한다
//   4) 유한성은 포맷 판정에서 나온다 — 샘플 스캔 경로를 만들지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectWavContainer,
  wavSamplesAreFinite,
  WAV_VALIDATION_CODES,
} from './wavContainer.ts'

// ── 합성 WAV 빌더 ───────────────────────────────────────────────────────────

interface ChunkSpec { id: string; body: Uint8Array }

function chunk(id: string, body: Uint8Array): ChunkSpec {
  return { id, body }
}

function fmtBody(opts: {
  format?: number
  channels?: number
  sampleRate?: number
  bits?: number
  blockAlign?: number
  extensible?: { cbSize: number; subFormat: number } | null
} = {}): Uint8Array {
  const format = opts.format ?? 1
  const channels = opts.channels ?? 1
  const sampleRate = opts.sampleRate ?? 24000
  const bits = opts.bits ?? 16
  const blockAlign = opts.blockAlign ?? (channels * bits) / 8
  const ext = opts.extensible ?? null
  const size = ext ? 40 : 16
  const b = new Uint8Array(size)
  const dv = new DataView(b.buffer)
  dv.setUint16(0, format, true)
  dv.setUint16(2, channels, true)
  dv.setUint32(4, sampleRate, true)
  dv.setUint32(8, sampleRate * blockAlign, true)
  dv.setUint16(12, blockAlign, true)
  dv.setUint16(14, bits, true)
  if (ext) {
    dv.setUint16(16, ext.cbSize, true)
    dv.setUint16(24, ext.subFormat, true)   // SubFormat GUID 앞 2바이트 = 실제 인코딩
  }
  return b
}

function buildWav(chunks: readonly ChunkSpec[], opts: { riffSize?: number; wave?: string } = {}): Uint8Array {
  let payload = 4   // 'WAVE'
  for (const c of chunks) payload += 8 + c.body.length + (c.body.length % 2)
  const total = 8 + payload
  const b = new Uint8Array(total)
  const dv = new DataView(b.buffer)
  const put = (s: string, at: number): void => {
    for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i)
  }
  put('RIFF', 0)
  dv.setUint32(4, opts.riffSize ?? payload, true)
  put(opts.wave ?? 'WAVE', 8)
  let at = 12
  for (const c of chunks) {
    put(c.id, at)
    dv.setUint32(at + 4, c.body.length, true)
    b.set(c.body, at + 8)
    at += 8 + c.body.length + (c.body.length % 2)
  }
  return b
}

/** ref-trim 계약이 만드는 형태: mono / 24kHz / 16bit 정수 PCM. */
function goodClip(frames = 24000): Uint8Array {
  return buildWav([chunk('fmt ', fmtBody()), chunk('data', new Uint8Array(frames * 2))])
}

// ── 1) 정상 경로 ────────────────────────────────────────────────────────────

test('정상: mono/24k/16bit 정수 PCM 의 사실을 정확히 읽는다', () => {
  const res = inspectWavContainer(goodClip(24000))
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.facts.sampleRate, 24000)
  assert.equal(res.facts.channelCount, 1)
  assert.equal(res.facts.bitsPerSample, 16)
  assert.equal(res.facts.frameCount, 24000)
  assert.equal(res.facts.durationMs, 1000)
  assert.equal(res.facts.integerPcm, true)
  assert.equal(wavSamplesAreFinite(res.facts), true)
})

test('정상: fmt 앞에 다른 청크가 있어도 읽는다(44바이트 고정 가정 금지)', () => {
  const wav = buildWav([
    chunk('LIST', new Uint8Array([1, 2, 3, 4, 5, 6])),
    chunk('fmt ', fmtBody()),
    chunk('fact', new Uint8Array([0, 0, 0, 0])),
    chunk('data', new Uint8Array(4800 * 2)),
  ])
  const res = inspectWavContainer(wav)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.facts.frameCount, 4800)
  assert.equal(res.facts.durationMs, 200)
})

test('정상: 홀수 크기 청크의 패딩 1바이트를 건너뛴다', () => {
  const wav = buildWav([
    chunk('LIST', new Uint8Array([9, 9, 9])),      // 홀수 → 패딩 1
    chunk('fmt ', fmtBody()),
    chunk('data', new Uint8Array(1200 * 2)),
  ])
  const res = inspectWavContainer(wav)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.facts.frameCount, 1200)
})

test('정상: 24bit·32bit 정수 PCM 도 정수로 인정한다', () => {
  for (const bits of [8, 16, 24, 32]) {
    const align = bits / 8
    const wav = buildWav([
      chunk('fmt ', fmtBody({ bits })),
      chunk('data', new Uint8Array(100 * align)),
    ])
    const res = inspectWavContainer(wav)
    assert.equal(res.ok, true, `${bits}bit`)
    if (!res.ok) continue
    assert.equal(res.facts.bitsPerSample, bits)
    assert.equal(wavSamplesAreFinite(res.facts), true, `${bits}bit 유한`)
  }
})

test('정상: PCM 으로 해석되는 extensible 은 받아들인다', () => {
  const wav = buildWav([
    chunk('fmt ', fmtBody({ format: 0xfffe, extensible: { cbSize: 22, subFormat: 1 } })),
    chunk('data', new Uint8Array(2400 * 2)),
  ])
  const res = inspectWavContainer(wav)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.facts.integerPcm, true)
})

// ── 2) 컨테이너 거부 ────────────────────────────────────────────────────────

test('거부: RIFF/WAVE 서명이 아니면 INVALID_WAV_CONTAINER', () => {
  assert.deepEqual(inspectWavContainer(new Uint8Array(0)), { ok: false, code: 'INVALID_WAV_CONTAINER' })
  assert.deepEqual(inspectWavContainer(new Uint8Array(11)), { ok: false, code: 'INVALID_WAV_CONTAINER' })
  const notWave = buildWav([chunk('fmt ', fmtBody()), chunk('data', new Uint8Array(2))], { wave: 'AVI ' })
  assert.deepEqual(inspectWavContainer(notWave), { ok: false, code: 'INVALID_WAV_CONTAINER' })
})

test('거부: 파일이 선언된 길이보다 짧으면 WAV_TRUNCATED', () => {
  const full = goodClip(1000)
  // (a) RIFF 가 실제보다 큰 크기를 주장
  const lying = full.slice()
  new DataView(lying.buffer).setUint32(4, full.length * 2, true)
  assert.deepEqual(inspectWavContainer(lying), { ok: false, code: 'WAV_TRUNCATED' })
  // (b) data 청크 payload 가 파일 밖으로 나감(꼬리를 잘라냄)
  const cut = full.slice(0, full.length - 500)
  new DataView(cut.buffer).setUint32(4, cut.length - 8, true)
  assert.deepEqual(inspectWavContainer(cut), { ok: false, code: 'WAV_TRUNCATED' })
})

test('거부: fmt 없음 / data 없음', () => {
  const noFmt = buildWav([chunk('data', new Uint8Array(64))])
  assert.deepEqual(inspectWavContainer(noFmt), { ok: false, code: 'WAV_FMT_MISSING' })

  const noData = buildWav([chunk('fmt ', fmtBody())])
  assert.deepEqual(inspectWavContainer(noData), { ok: false, code: 'WAV_DATA_MISSING' })

  const shortFmt = buildWav([chunk('fmt ', new Uint8Array(10)), chunk('data', new Uint8Array(64))])
  assert.deepEqual(inspectWavContainer(shortFmt), { ok: false, code: 'WAV_FMT_MISSING' })
})

// ── 3) 인코딩 거부 — float 를 스캔해서 받아들이는 길은 없다 ──────────────────

test('거부: IEEE float WAV 는 샘플을 보지 않고 거부한다', () => {
  const floatWav = buildWav([
    chunk('fmt ', fmtBody({ format: 3, bits: 32 })),
    chunk('data', new Uint8Array(100 * 4)),
  ])
  assert.deepEqual(inspectWavContainer(floatWav), { ok: false, code: 'WAV_ENCODING_UNSUPPORTED' })
})

test('거부: 해석되지 않은 extensible 과 압축 포맷', () => {
  // 확장 영역이 없는 extensible
  const noExt = buildWav([chunk('fmt ', fmtBody({ format: 0xfffe })), chunk('data', new Uint8Array(64))])
  assert.deepEqual(inspectWavContainer(noExt), { ok: false, code: 'WAV_ENCODING_UNSUPPORTED' })
  // cbSize 가 모자란 extensible
  const shortExt = buildWav([
    chunk('fmt ', fmtBody({ format: 0xfffe, extensible: { cbSize: 0, subFormat: 1 } })),
    chunk('data', new Uint8Array(64)),
  ])
  assert.deepEqual(inspectWavContainer(shortExt), { ok: false, code: 'WAV_ENCODING_UNSUPPORTED' })
  // SubFormat 이 float 인 extensible
  const extFloat = buildWav([
    chunk('fmt ', fmtBody({ format: 0xfffe, bits: 32, extensible: { cbSize: 22, subFormat: 3 } })),
    chunk('data', new Uint8Array(64 * 4)),
  ])
  assert.deepEqual(inspectWavContainer(extFloat), { ok: false, code: 'WAV_ENCODING_UNSUPPORTED' })
  // 압축(예: A-law)
  const alaw = buildWav([chunk('fmt ', fmtBody({ format: 6, bits: 8 })), chunk('data', new Uint8Array(64))])
  assert.deepEqual(inspectWavContainer(alaw), { ok: false, code: 'WAV_ENCODING_UNSUPPORTED' })
  // 규격 밖 샘플 폭
  const odd = buildWav([
    chunk('fmt ', fmtBody({ bits: 12, blockAlign: 2 })),
    chunk('data', new Uint8Array(64)),
  ])
  assert.deepEqual(inspectWavContainer(odd), { ok: false, code: 'WAV_ENCODING_UNSUPPORTED' })
})

// ── 4) 정렬·빈 데이터 ───────────────────────────────────────────────────────

test('거부: blockAlign 이 채널·샘플폭과 어긋나면 WAV_FRAME_ALIGNMENT_INVALID', () => {
  const wav = buildWav([
    chunk('fmt ', fmtBody({ channels: 1, bits: 16, blockAlign: 3 })),
    chunk('data', new Uint8Array(96)),
  ])
  assert.deepEqual(inspectWavContainer(wav), { ok: false, code: 'WAV_FRAME_ALIGNMENT_INVALID' })
})

test('거부: data 길이가 프레임 크기의 배수가 아니면 거부', () => {
  const wav = buildWav([
    chunk('fmt ', fmtBody({ channels: 2, bits: 16 })),   // blockAlign 4
    chunk('data', new Uint8Array(4 * 10 + 2)),           // 배수 아님
  ])
  assert.deepEqual(inspectWavContainer(wav), { ok: false, code: 'WAV_FRAME_ALIGNMENT_INVALID' })
})

test('거부: 프레임이 0개면 WAV_EMPTY', () => {
  const wav = buildWav([chunk('fmt ', fmtBody()), chunk('data', new Uint8Array(0))])
  assert.deepEqual(inspectWavContainer(wav), { ok: false, code: 'WAV_EMPTY' })
})

// ── 5) 어휘 ─────────────────────────────────────────────────────────────────

test('코드 어휘: 중복 없고 모든 코드가 실제로 쓰인다', () => {
  assert.equal(new Set(WAV_VALIDATION_CODES).size, WAV_VALIDATION_CODES.length)
  const produced = new Set<string>()
  const cases: Uint8Array[] = [
    new Uint8Array(4),                                                           // INVALID_WAV_CONTAINER
    (() => { const w = goodClip(100); new DataView(w.buffer).setUint32(4, 99999, true); return w })(), // WAV_TRUNCATED
    buildWav([chunk('data', new Uint8Array(64))]),                               // WAV_FMT_MISSING
    buildWav([chunk('fmt ', fmtBody())]),                                        // WAV_DATA_MISSING
    buildWav([chunk('fmt ', fmtBody({ format: 3, bits: 32 })), chunk('data', new Uint8Array(8))]), // ENCODING
    buildWav([chunk('fmt ', fmtBody({ blockAlign: 3 })), chunk('data', new Uint8Array(96))]),      // ALIGNMENT
    buildWav([chunk('fmt ', fmtBody()), chunk('data', new Uint8Array(0))]),      // WAV_EMPTY
  ]
  for (const bytes of cases) {
    const r = inspectWavContainer(bytes)
    if (!r.ok) produced.add(r.code)
  }
  assert.deepEqual([...produced].sort(), [...WAV_VALIDATION_CODES].sort())
})

test('유한성 판정은 포맷에서만 나온다(샘플 스캔 API 부재)', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./wavContainer.ts', import.meta.url), 'utf-8'))
  for (const banned of ['isFinite', 'isNaN', 'Number.isFinite', 'getFloat32', 'getFloat64']) {
    assert.ok(!src.includes(banned), `${banned} 로 샘플을 훑지 않는다`)
  }
})
