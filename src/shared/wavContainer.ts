// RIFF/WAVE 컨테이너 검증 — 순수 모듈(fs·DOM·타이머 없음). 바이트만 보고 사실만 낸다.
//
// 왜 필요한가: 참조 클립을 영속 저장소로 승격하기 전에 "이 파일이 정말 우리가 만든 규격의
// 클립인가"를 확인해야 한다. reference_library 계약의 3단계 검증(VERIFY_STAGING_CLIP)은
// decodable / all_samples_finite / sample_rate / channel_count / duration_ms / clip_sha256 을
// 요구하는데, 그 중 앞의 두 가지를 이 모듈이 판정한다.
//
// 유한성(all_samples_finite)에 대한 입장:
//   정수 PCM 은 표현 가능한 모든 값이 유한하다 — NaN·Inf 라는 비트 패턴 자체가 없다.
//   그래서 "컨테이너 구조가 정상이고 정수 PCM 이다"가 확인되면 유한성은 **포맷에서 따라 나오는
//   사실**이지 별도 측정 대상이 아니다. 반대로 IEEE float WAV 는 NaN·Inf 를 담을 수 있으므로
//   샘플을 훑어 받아들이는 길을 아예 만들지 않고 거부한다(WAV_ENCODING_UNSUPPORTED).
//   peak 같은 통계값을 유한성의 증거로 쓰지 않는다 — 누적 방식에 따라 NaN 이 조용히 삼켜진다.
//
// 44 바이트 고정 헤더를 가정하지 않는다. 청크를 경계 검사하며 순회한다(LIST/fact 등이 앞에
// 끼어들어도 정상 동작해야 하고, 잘린 파일을 정상으로 읽어서도 안 된다).
//
// ⚠️ 이 코드들은 main 서비스의 진단 어휘다. reference_library 계약의 가드 코드
//    (REFERENCE_GUARD_CODES)를 늘리지 않는다 — 검증 실패는 계약상 CLIP_VERIFICATION_FAILED
//    하나로 수렴하고, 아래 코드는 "왜 실패했는가"를 사람에게 설명하기 위해서만 함께 전달한다.

export const WAV_VALIDATION_CODES = [
  'INVALID_WAV_CONTAINER',        // RIFF/WAVE 서명이 아님
  'WAV_TRUNCATED',                // 선언된 길이보다 파일이 짧음(청크가 파일 밖으로 나감)
  'WAV_FMT_MISSING',              // fmt 청크 없음 또는 규격 미달
  'WAV_DATA_MISSING',             // data 청크 없음
  'WAV_ENCODING_UNSUPPORTED',     // 정수 PCM 이 아님(float·압축·해석 불가 extensible)
  'WAV_FRAME_ALIGNMENT_INVALID',  // blockAlign 불일치 또는 data 길이가 프레임 배수가 아님
  'WAV_EMPTY',                    // 프레임 0개
] as const
export type WavValidationCode = (typeof WAV_VALIDATION_CODES)[number]

export interface WavFormatFacts {
  sampleRate: number
  channelCount: number
  bitsPerSample: number
  frameCount: number
  durationMs: number
  /** 정수 PCM 인가. true 면 모든 샘플이 유한하다는 뜻이다(포맷에서 따라 나온다). */
  integerPcm: boolean
}

export type WavInspection =
  | { ok: true; facts: WavFormatFacts }
  | { ok: false; code: WavValidationCode }

const WAVE_FORMAT_PCM = 0x0001
const WAVE_FORMAT_EXTENSIBLE = 0xfffe
/** 정수 PCM 으로 허용하는 샘플 폭. 이 밖은 규격 밖으로 보고 거부한다. */
const ALLOWED_BITS = [8, 16, 24, 32]

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8)
}

function u32(bytes: Uint8Array, at: number): number {
  // >>> 0 : 최상위 비트가 선 값이 음수가 되지 않게.
  return ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0)
}

function fail(code: WavValidationCode): WavInspection {
  return { ok: false, code }
}

/**
 * 정수 PCM WAV 인지 검사하고 형식 사실을 뽑는다. 어떤 경우에도 예외를 던지지 않고
 * 구조화된 코드로 답한다(조용한 통과 금지).
 */
export function inspectWavContainer(bytes: Uint8Array): WavInspection {
  const len = bytes.byteLength
  if (len < 12) return fail('INVALID_WAV_CONTAINER')
  if (ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') return fail('INVALID_WAV_CONTAINER')

  // RIFF 가 선언한 전체 크기(= 파일 크기 - 8)보다 실제 파일이 짧으면 잘린 것이다.
  const riffSize = u32(bytes, 4)
  if (riffSize + 8 > len) return fail('WAV_TRUNCATED')

  let sampleRate = 0
  let channelCount = 0
  let bitsPerSample = 0
  let blockAlign = 0
  let integerPcm = false
  let sawFmt = false
  let dataSize = -1

  // 청크 순회 — 헤더 8바이트와 payload 가 모두 파일 안에 있는지 매번 확인한다.
  let at = 12
  while (at + 8 <= len) {
    const id = ascii(bytes, at)
    const size = u32(bytes, at + 4)
    const body = at + 8
    if (body + size > len) return fail('WAV_TRUNCATED')

    if (id === 'fmt ') {
      if (size < 16) return fail('WAV_FMT_MISSING')
      let format = u16(bytes, body)
      channelCount = u16(bytes, body + 2)
      sampleRate = u32(bytes, body + 4)
      blockAlign = u16(bytes, body + 12)
      bitsPerSample = u16(bytes, body + 14)

      if (format === WAVE_FORMAT_EXTENSIBLE) {
        // 확장 헤더의 SubFormat GUID 앞 2바이트가 실제 인코딩이다. 확장 영역이 없거나
        // 잘려 있으면 '해석되지 않은 extensible' 이므로 받아들이지 않는다.
        if (size < 40) return fail('WAV_ENCODING_UNSUPPORTED')
        const cbSize = u16(bytes, body + 16)
        if (cbSize < 22) return fail('WAV_ENCODING_UNSUPPORTED')
        format = u16(bytes, body + 24)
      }
      if (format !== WAVE_FORMAT_PCM) return fail('WAV_ENCODING_UNSUPPORTED')
      if (!ALLOWED_BITS.includes(bitsPerSample)) return fail('WAV_ENCODING_UNSUPPORTED')
      if (channelCount < 1 || sampleRate < 1) return fail('WAV_FMT_MISSING')
      if (blockAlign !== (channelCount * bitsPerSample) / 8) return fail('WAV_FRAME_ALIGNMENT_INVALID')

      integerPcm = true
      sawFmt = true
    } else if (id === 'data') {
      dataSize = size
    }

    // 청크는 짝수 경계에 정렬된다(홀수 크기 뒤에는 패딩 1바이트).
    at = body + size + (size % 2)
  }

  if (!sawFmt) return fail('WAV_FMT_MISSING')
  if (dataSize < 0) return fail('WAV_DATA_MISSING')
  if (blockAlign < 1) return fail('WAV_FRAME_ALIGNMENT_INVALID')
  if (dataSize % blockAlign !== 0) return fail('WAV_FRAME_ALIGNMENT_INVALID')

  const frameCount = dataSize / blockAlign
  if (frameCount < 1) return fail('WAV_EMPTY')

  return {
    ok: true,
    facts: {
      sampleRate,
      channelCount,
      bitsPerSample,
      frameCount,
      durationMs: Math.round((frameCount / sampleRate) * 1000),
      integerPcm,
    },
  }
}

/**
 * 정수 PCM 으로 확인됐는가 = 모든 샘플이 유한한가.
 * 통계값이 아니라 포맷 판정에서 나오는 결론이라는 점을 이름으로 못 박는다.
 */
export function wavSamplesAreFinite(facts: WavFormatFacts): boolean {
  return facts.integerPcm === true
}
