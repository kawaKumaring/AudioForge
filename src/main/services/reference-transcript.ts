// 참조 전사 sidecar — 실제 ref_text 를 앱 소유 위치에 남기는 유일한 권위.
//
// 왜 필요한가: manifest 는 transcript_sha256(해시)만 담는다. 해시로는 원문을 되살릴 수 없고,
// Qwen 의 ICL 경로는 ref_text 를 실제로 요구한다. renderer 메모리와 원본 폴더 옆 session.json
// 은 durable 권위가 아니다(앱이 소유하지 않고 원본 위치에 종속된다).
//
// 계약:
//   · 위치는 clipId 에서 결정적으로 유도한다 — <root>/transcripts/<clipId>.json.
//     manifest 에 경로를 넣지 않아도 찾을 수 있고, manifest 스키마는 그대로다.
//   · 정규화와 해시는 reference_library 계약 함수를 그대로 쓴다(주입). 새 규칙을 만들지 않는다.
//   · 읽을 때마다 sha256(normalize(text)) 가 manifest 의 transcript_sha256 과 같은지 확인한다.
//     다르면 쓰지 않는다 — x_vector_only 자동 강등도, 기본 문구 대체도, 다른 참조의 전사를
//     끌어다 쓰는 것도 하지 않는다.
//   · text 는 사용자 음성의 내용이다. 목록 응답·로그·오류 문구에 싣지 않는다.
//     main 의 생성 서비스만 실제 text 를 읽는다.
//
// ⚠️ 값 import 를 하지 않는다(타입만). node --test 가 이 파일을 직접 로드한다.
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const TRANSCRIPT_SCHEMA_VERSION = 1
export const TRANSCRIPT_DIR_NAME = 'transcripts'
/** sidecar 에 허용되는 필드 — 이 목록이 전부다(경로 필드는 없다). */
export const TRANSCRIPT_FIELDS = ['schemaVersion', 'clipId', 'transcriptSha256', 'text', 'language'] as const

export interface TranscriptSidecar {
  schemaVersion: number
  clipId: string
  transcriptSha256: string
  text: string
  language: string
}

export type TranscriptFailure =
  | 'TRANSCRIPT_MISSING'        // sidecar 파일이 없다
  | 'TRANSCRIPT_CORRUPT'        // JSON·스키마·clipId 불일치·링크 등
  | 'TRANSCRIPT_HASH_MISMATCH'  // 내용 해시가 manifest 와 다르다
  | 'TRANSCRIPT_CONFLICT'       // 같은 clipId 인데 다른 전사를 덮어쓰려 한다

export type TranscriptStatus = 'present' | TranscriptFailure

export type TranscriptRead =
  | { ok: true; sidecar: TranscriptSidecar }
  | { ok: false; reason: TranscriptFailure }

/** 정규화·해시는 reference_library 계약이 단일 권위다. 여기서 다시 정의하지 않는다. */
export interface TranscriptContract {
  normalizeTranscript: (text: string | null | undefined) => string
  sha256HexOfString: (text: string) => string
}

export interface TranscriptStore {
  readonly dirPath: string
  /** 전사 문자열로 sidecar 를 만든다. 해시는 계약 함수로 계산한다. */
  build: (clipId: string, text: string, language: string) => TranscriptSidecar
  /** manifest 의 transcript_sha256 과 대조하며 읽는다. */
  read: (clipId: string, expectedSha256: string) => TranscriptRead
  /** 목록 표시용 상태만. text 를 돌려주지 않는다. */
  statusOf: (clipId: string, expectedSha256: string) => TranscriptStatus
  /** staging 에 temp 를 쓰고 즉시 되읽어 검증한다. 반환은 temp 경로. */
  writeStagingSidecar: (stagingDir: string, sidecar: TranscriptSidecar) => string
  /** temp → durable 원자적 이동(같은 볼륨). */
  promote: (tempPath: string, clipId: string) => string
  /** 같은 clipId 에 다른 전사가 이미 있으면 TRANSCRIPT_CONFLICT. 없으면 null. */
  conflictWith: (sidecar: TranscriptSidecar) => TranscriptFailure | null
  remove: (clipId: string) => boolean
  /** manifest 가 모르는 sidecar 들(고아). clipId 목록을 받는다. */
  listOrphans: (knownClipIds: readonly string[]) => string[]
}

const CLIP_ID_RE = /^[0-9a-f]{16}$/
const SHA256_RE = /^[0-9a-f]{64}$/

function writeDurable(path: string, data: string): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 이 경로가 transcripts 폴더 '직접 자식'인 실제 일반 파일인가(링크·외부 realpath 거부). */
function isOwnedRegularFile(dir: string, path: string): boolean {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return false
    return dirname(realpathSync(path)) === realpathSync(dir)
  } catch {
    return false
  }
}

/** 허용 필드만 있고 형식이 맞는가. 여분 필드가 하나라도 있으면 거부한다. */
export function parseTranscriptSidecar(raw: unknown, clipId: string): TranscriptSidecar | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const extra = Object.keys(obj).filter((k) => !(TRANSCRIPT_FIELDS as readonly string[]).includes(k))
  if (extra.length > 0) return null
  if (obj.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION) return null
  if (typeof obj.clipId !== 'string' || obj.clipId !== clipId) return null
  if (typeof obj.transcriptSha256 !== 'string' || !SHA256_RE.test(obj.transcriptSha256)) return null
  if (typeof obj.text !== 'string') return null
  if (typeof obj.language !== 'string') return null
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    clipId: obj.clipId,
    transcriptSha256: obj.transcriptSha256,
    text: obj.text,
    language: obj.language,
  }
}

export function createTranscriptStore(contract: TranscriptContract, rootDir: string): TranscriptStore {
  const dir = join(resolve(rootDir), TRANSCRIPT_DIR_NAME)
  const fileOf = (clipId: string): string => join(dir, `${clipId}.json`)

  const readRaw = (clipId: string): TranscriptSidecar | 'missing' | 'corrupt' => {
    if (!CLIP_ID_RE.test(clipId)) return 'corrupt'
    const p = fileOf(clipId)
    if (!existsSync(p)) return 'missing'
    if (!isOwnedRegularFile(dir, p)) return 'corrupt'
    try {
      const parsed = parseTranscriptSidecar(JSON.parse(readFileSync(p, 'utf-8')), clipId)
      return parsed ?? 'corrupt'
    } catch {
      return 'corrupt'
    }
  }

  const store: TranscriptStore = {
    dirPath: dir,

    build(clipId, text, language) {
      const normalized = contract.normalizeTranscript(text)
      return {
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        clipId,
        transcriptSha256: contract.sha256HexOfString(normalized),
        text,                       // 원문 그대로 — 해시는 정규화본으로 계산한다(계약과 같은 순서)
        language: language ?? '',   // 모르는 언어를 임의 기본값으로 바꾸지 않는다
      }
    },

    read(clipId, expectedSha256) {
      const got = readRaw(clipId)
      if (got === 'missing') return { ok: false, reason: 'TRANSCRIPT_MISSING' }
      if (got === 'corrupt') return { ok: false, reason: 'TRANSCRIPT_CORRUPT' }
      // 저장된 해시가 스스로와 맞는지 먼저 본다(파일 안에서의 자기모순 검출).
      const actual = contract.sha256HexOfString(contract.normalizeTranscript(got.text))
      if (actual !== got.transcriptSha256) return { ok: false, reason: 'TRANSCRIPT_CORRUPT' }
      // manifest 가 아는 해시와 같은지 본다(참조와 전사의 짝이 맞는지).
      if (expectedSha256 && actual !== expectedSha256) return { ok: false, reason: 'TRANSCRIPT_HASH_MISMATCH' }
      return { ok: true, sidecar: got }
    },

    statusOf(clipId, expectedSha256) {
      const res = store.read(clipId, expectedSha256)
      return res.ok ? 'present' : res.reason
    },

    writeStagingSidecar(stagingDir, sidecar) {
      mkdirSync(stagingDir, { recursive: true })
      const temp = join(stagingDir, `${sidecar.clipId}.json`)
      writeDurable(temp, JSON.stringify(sidecar, null, 2))
      // 되읽어 검증한다 — 승격 전에 깨진 것을 옮기지 않는다.
      const back = parseTranscriptSidecar(JSON.parse(readFileSync(temp, 'utf-8')), sidecar.clipId)
      if (!back || back.transcriptSha256 !== sidecar.transcriptSha256 || back.text !== sidecar.text) {
        throw new Error('TRANSCRIPT_CORRUPT')
      }
      return temp
    },

    promote(tempPath, clipId) {
      mkdirSync(dir, { recursive: true })
      const durable = fileOf(clipId)
      renameSync(tempPath, durable)   // 같은 볼륨 — 원자적
      return durable
    },

    conflictWith(sidecar) {
      const got = readRaw(sidecar.clipId)
      if (got === 'missing') return null
      if (got === 'corrupt') return null   // 손상본은 덮어써도 잃을 내용이 없다
      return got.transcriptSha256 === sidecar.transcriptSha256 ? null : 'TRANSCRIPT_CONFLICT'
    },

    remove(clipId) {
      if (!CLIP_ID_RE.test(clipId)) return false
      const p = fileOf(clipId)
      if (!existsSync(p)) return true          // 지울 것이 없으면 이미 목표 상태다
      if (!isOwnedRegularFile(dir, p)) return false
      try {
        unlinkSync(p)
        return true
      } catch {
        return false
      }
    },

    listOrphans(knownClipIds) {
      const known = new Set(knownClipIds)
      try {
        return readdirSync(dir)
          .filter((n) => /^[0-9a-f]{16}\.json$/.test(n))
          .map((n) => n.slice(0, 16))
          .filter((id) => !known.has(id))
          .sort()
      } catch {
        return []
      }
    },
  }
  return store
}
