// 감정 샘플 캐시 저장소 — 앱 소유 userData 아래에만 존재한다.
//
// 레이아웃:
//   <root>/<64 hex cacheKey>.wav        완성된 샘플(이것만 '캐시 히트'다)
//   <root>/staging/<runId>/             이 실행 전용 staging(같은 볼륨 → rename 이 원자적)
//
// 규칙:
//   · 파일명은 정확히 64자리 소문자 hex + .wav. 점·슬래시가 들어갈 수 없어 traversal 이 성립하지 않는다.
//   · 완성 전 결과는 절대 final 이름을 갖지 않는다. staging 에서 검증을 통과한 것만 rename 된다.
//   · 실패·취소·부분 산출물은 등록하지 않는다 — 캐시에 있다는 것은 '들을 수 있다'는 뜻이어야 한다.
//   · 경로·미디어 바이트·전사는 반환값에도 로그에도 넣지 않는다.
//
// ⚠️ 값 import 를 하지 않는다(타입만). node --test 가 이 파일을 직접 로드한다.
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { WavFormatFacts, WavInspection, WavValidationCode } from '../../shared/wavContainer'

export const SAMPLER_CACHE_DIR_NAME = 'emotion-sampler-cache'
export const SAMPLER_STAGING_DIR_NAME = 'staging'
/** 무음 판정 기준 — 정수 PCM 최대 진폭이 이 비율 이하면 소리가 없다고 본다. */
const SILENCE_PEAK_RATIO = 0.0005

export interface SamplerCacheContract {
  inspectWavContainer: (bytes: Uint8Array) => WavInspection
  wavSamplesAreFinite: (facts: WavFormatFacts) => boolean
}

export type SamplerCacheRejection =
  | 'INVALID_KEY'          // 64 hex 가 아니다 — 파일시스템에 닿기 전에 막는다
  | 'NOT_FOUND'
  | 'NOT_OWNED'            // 링크·다른 위치를 가리킨다
  | 'DELETE_FAILED'
  | 'CLIP_INVALID'         // WAV 구조가 규격 밖
  | 'CLIP_SILENT'          // 소리가 없다(실패한 생성의 흔한 결과)
  | 'PUBLISH_FAILED'

export type SamplerPublishResult =
  | { ok: true; cacheKey: string }
  | { ok: false; reason: SamplerCacheRejection; wavCode?: WavValidationCode }

export interface SamplerCache {
  readonly rootDir: string
  /** 이 실행 전용 staging 디렉터리를 만들고 경로를 준다(main 내부 전용). */
  createStagingDir(runId: string): string
  /** staging 산출물을 검증하고 통과한 것만 final 로 원자적 이동. */
  publish(cacheKey: string, stagedPath: string): SamplerPublishResult
  /** 존재하는 캐시 키 목록(결정적 순서). 경로·크기·시각은 주지 않는다. */
  inventory(): string[]
  has(cacheKey: string): boolean
  /** main 내부 전용 — 재생 URL 해석용 절대 경로. preload 로 내보내지 않는다. */
  resolveFile(cacheKey: string): { ok: true; filePath: string } | { ok: false; reason: SamplerCacheRejection }
  remove(cacheKey: string): { ok: true } | { ok: false; reason: SamplerCacheRejection }
  /** 이 run 의 staging 을 통째로 정리한다(성공·실패 무관하게 부른다). */
  sweepStaging(runId: string): boolean
}

const KEY_RE = /^[0-9a-f]{64}$/
const RUN_RE = /^[0-9a-f]{8,32}$/

/** 정수 PCM 샘플을 훑어 최대 진폭을 구한다. 구조 검증을 통과한 바이트만 들어온다. */
function peakRatio(bytes: Uint8Array, facts: WavFormatFacts): number {
  const bytesPerSample = facts.bitsPerSample / 8
  const full = 2 ** (facts.bitsPerSample - 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // data 청크 위치를 다시 찾는다(구조는 이미 검증됐다).
  let at = 12
  let dataAt = -1
  let dataSize = 0
  while (at + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
    const size = view.getUint32(at + 4, true)
    if (id === 'data') { dataAt = at + 8; dataSize = size; break }
    at = at + 8 + size + (size % 2)
  }
  if (dataAt < 0) return 0

  let peak = 0
  const end = Math.min(dataAt + dataSize, bytes.byteLength)
  for (let p = dataAt; p + bytesPerSample <= end; p += bytesPerSample) {
    let v: number
    if (facts.bitsPerSample === 8) v = bytes[p] - 128            // 8bit 는 unsigned
    else if (facts.bitsPerSample === 16) v = view.getInt16(p, true)
    else if (facts.bitsPerSample === 24) {
      const raw = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)
      v = raw & 0x800000 ? raw - 0x1000000 : raw
    } else v = view.getInt32(p, true)
    const abs = Math.abs(v)
    if (abs > peak) peak = abs
  }
  return peak / full
}

function isOwnedRegularFile(root: string, path: string): boolean {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return false
    return dirname(realpathSync(path)) === realpathSync(root)
  } catch {
    return false
  }
}

export function createSamplerCache(contract: SamplerCacheContract, rootDir: string): SamplerCache {
  const root = resolve(rootDir)
  const fileOf = (key: string): string => join(root, `${key}.wav`)
  const stagingRoot = (): string => join(root, SAMPLER_STAGING_DIR_NAME)

  const cache: SamplerCache = {
    rootDir: root,

    createStagingDir(runId) {
      if (!RUN_RE.test(runId)) throw new Error('INVALID_RUN_ID')
      const dir = join(stagingRoot(), runId)
      mkdirSync(dir, { recursive: true })   // 실제로 쓸 때만 만든다
      return dir
    },

    publish(cacheKey, stagedPath) {
      if (!KEY_RE.test(cacheKey)) return { ok: false, reason: 'INVALID_KEY' }

      let bytes: Uint8Array
      try {
        bytes = readFileSync(stagedPath)
      } catch {
        return { ok: false, reason: 'PUBLISH_FAILED' }
      }

      const seen = contract.inspectWavContainer(bytes)
      if (!seen.ok) return { ok: false, reason: 'CLIP_INVALID', wavCode: seen.code }
      if (!contract.wavSamplesAreFinite(seen.facts)) return { ok: false, reason: 'CLIP_INVALID' }
      // 실패한 생성이 조용히 무음 파일을 남기는 일이 있다. 그것을 '들을 수 있는 샘플'로 올리지 않는다.
      if (peakRatio(bytes, seen.facts) <= SILENCE_PEAK_RATIO) return { ok: false, reason: 'CLIP_SILENT' }

      try {
        mkdirSync(root, { recursive: true })
        renameSync(stagedPath, fileOf(cacheKey))   // 같은 볼륨 — 원자적. 여기서야 final 이름이 된다.
        return { ok: true, cacheKey }
      } catch {
        return { ok: false, reason: 'PUBLISH_FAILED' }
      }
    },

    inventory() {
      try {
        return readdirSync(root)
          .filter((n) => /^[0-9a-f]{64}\.wav$/.test(n))
          .filter((n) => isOwnedRegularFile(root, join(root, n)))
          .map((n) => n.slice(0, 64))
          .sort()
      } catch {
        return []
      }
    },

    has(cacheKey) {
      return KEY_RE.test(cacheKey) && isOwnedRegularFile(root, fileOf(cacheKey))
    },

    resolveFile(cacheKey) {
      if (!KEY_RE.test(cacheKey)) return { ok: false, reason: 'INVALID_KEY' }
      const p = fileOf(cacheKey)
      if (!existsSync(p)) return { ok: false, reason: 'NOT_FOUND' }
      if (!isOwnedRegularFile(root, p)) return { ok: false, reason: 'NOT_OWNED' }
      return { ok: true, filePath: p }
    },

    remove(cacheKey) {
      if (!KEY_RE.test(cacheKey)) return { ok: false, reason: 'INVALID_KEY' }
      const p = fileOf(cacheKey)
      if (!existsSync(p)) return { ok: false, reason: 'NOT_FOUND' }
      if (!isOwnedRegularFile(root, p)) return { ok: false, reason: 'NOT_OWNED' }
      try {
        unlinkSync(p)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'DELETE_FAILED' }
      }
    },

    sweepStaging(runId) {
      if (!RUN_RE.test(runId)) return false
      const dir = join(stagingRoot(), runId)
      try {
        if (!existsSync(dir)) return true
        const st = lstatSync(dir)
        if (st.isSymbolicLink() || !st.isDirectory()) return false   // 링크는 따라가지 않는다
        rmSync(dir, { recursive: true, force: false })
        return true
      } catch {
        return false
      }
    },
  }
  return cache
}

/** staging 에 바이트를 쓰고 경로를 준다. 내용은 교체 전에 디스크로 밀어 둔다. */
export function writeStagedSample(stagingDir: string, name: string, bytes: Uint8Array): string {
  const p = join(stagingDir, name)
  const fd = openSync(p, 'w')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return p
}

/** 내용 해시 — 캐시 무결성 확인이 필요할 때만 쓴다. */
export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
