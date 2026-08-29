# TTS 음역(pitch) 보정 backend 설계 계획

브랜치: `feature/tts-pitch-backend` (origin/develop `0788885`에서 분기)

> **갱신(구현 착수 후)**: 이 문서는 초기 설계다. 확정 계약은
> `origin/design/tts-prosody-integration-contract:doc/work-in-progress/tts-prosody-integration-contract.md`가
> 단일 권위이며 아래 §1.2의 `asetrate+atempo` 폴백은 계약 §7 정정으로 **production에서 완전 제거**됐다.
> production pitch 경로는 **rubberband 단일**, 미지원 시 `PITCH_UNAVAILABLE` 오류(조용한 저품질 폴백 금지).
> 실제 구현은 `python/pitch_shift.py`(helper + 엔진 무관 공통 함수 `place_final_with_pitch`)를 참조.

## 0. 문제 정의

Qwen(qwen3) 합성 결과가 원 화자보다 약간 낮게 들린다. 합성 결과(synthesized.wav)에만
사후 pitch 보정을 걸어 화자 음역을 맞춘다. **속도·길이는 유지**하고 가능한 한 **formant 보존**.

- 범위: -2.0 ~ +2.0 semitone, 기본 0, 0.5 단위(즉 선택지 -2.0/-1.5/-1.0/-0.5/0/+0.5/+1.0/+1.5/+2.0).
- 0이면 어떤 후처리도 걸지 않는다(무변경 경로 = 기존 출력 바이트 그대로).
- 실패 시 기존 synthesized.wav를 절대 손상하지 않는다.

## 1. ffmpeg 실측 결과 (read-only, 2026-08-22)

프로젝트가 쓰는 ffmpeg는 `audio_utils.find_ffmpeg()`가 찾는 WinGet 설치본이다.

- 경로: `%LOCALAPPDATA%/Microsoft/WinGet/Packages/Gyan.FFmpeg_.../ffmpeg-8.1-full_build/bin/ffmpeg.exe`
- 버전: ffmpeg 8.1-full_build (Gyan.dev), static build.
- 빌드 플래그에 **`--enable-librubberband` 포함** → `rubberband` 필터 사용 가능.
  - `ffmpeg -filters` 확인: `rubberband  A->A  Apply time-stretching and pitch-shifting.`
- 그 외 관련 필터: `asetrate`, `atempo`, `aresample`(전부 존재).

### 1.1 rubberband 동작 실측 (24kHz mono sine, 2초)

`rubberband=pitch=<ratio>:formant=preserved`로 실측:

- 길이: 원본 2.000s → +1st 2.000s, +2st 2.000s → **길이 정확 유지**.
- 샘플레이트: 24000 → 24000 → **SR 유지**.
- `formant=preserved` 옵션: 정상 수락(실패 없음).
- F0(zero-crossing 측정): 원본 219.5Hz(목표 220), +1st 234.5Hz(목표 233.08),
  +2st 247.0Hz(목표 246.94) → **실제로 반음 단위로 상승 확인**.

`ratio = 2 ** (semitones / 12)`. 예: +1st = 1.059463, +2st = 1.122462, -0.5st = 0.971532.

### 1.2 대안 정리 (권장순)

1. **rubberband (권장·기본)** — 이 환경에서 지원 확인됨. 길이·SR 유지, formant 보존 옵션 존재,
   시간축 늘임 없이 pitch만 이동. 추가 설치 불필요.
2. **asetrate + atempo + aresample (rubberband 부재 환경용 폴백)** —
   `asetrate=sr*ratio, atempo=1/ratio, aresample=sr`. asetrate가 재생속도까지 바꾸므로
   atempo로 되돌리고 aresample로 SR 복원. 길이는 근사 복원되나 atempo가 위상 보코더라 품질이
   rubberband보다 낮고 **formant 미보존**(성대 특성이 함께 이동). 폴백으로만 문서화.
3. **단순 asetrate 단독 — production 대안으로 제시하지 않음.** pitch와 함께 속도·길이가
   바뀌어(길이=1/ratio 배) "길이 유지" 요구를 위반하고 formant도 이동한다. 품질을 속이는 방식.
4. librosa / pyrubberband 등 Python 라이브러리 — **설치 필요**(현재 미설치, 이번 승인 범위 밖).
   ffmpeg rubberband가 이미 되므로 불필요.

**결론: 이 환경에서는 rubberband 단일 방식으로 요구(길이·SR 유지 + formant 보존)를 전부 충족.**
폴백(asetrate+atempo+aresample)은 rubberband 미탐지 시에만, 품질·formant 한계를 metadata에 명시하며 사용.

## 2. 기존 출력 구조와 끼어들 지점 (read-only 파악)

### 2.1 Qwen 배치 경로 — `tts_worker.py :: _synthesize_qwen_job`

원자적 교체 구조가 이미 완성돼 있어 pitch는 여기에 자연스럽게 얹힌다:

- 실행별 임시 폴더 `job_dir = mkdtemp(prefix=".qwen-job-", dir=output_dir)`를 output_dir **내부**에 만든다
  (동일 파일시스템이라 `os.replace`가 원자적).
- chunk raw → (speed≠1이면 chunk별 `_atempo_segment`) → `_concat_with_boundaries(use, gaps, pending_path)`로
  `job_dir/pending.wav` 생성.
  ※ 갱신(2026-08-29): 이 경로는 더 이상 `_concat_with_silence`(항목마다 무음)를 쓰지 않는다.
  `gaps`는 **원 segment 경계에만** 값이 있고 자동분할 내부 chunk 경계는 항상 `0.0`이다 —
  "문장 안에서도 chunk마다 무음이 들어간다"는 읽기는 사실이 아니다.
- pending을 **검증**(존재/non-empty/SR>0/finite)한 뒤에만 `os.replace(pending_path, final_path)`로
  `output_dir/synthesized.wav` 교체.
- 정상/오류 공통으로 `finally: shutil.rmtree(job_dir)`. 실패 시 `os.replace`에 도달하지 않아
  **기존 synthesized.wav가 보존**된다.

→ **끼어들 지점**: `_concat_with_silence(...)`로 pending.wav를 만든 직후, 검증·`os.replace` **직전**.
pending.wav를 입력으로 pitch 보정본을 `job_dir` 안 다른 임시파일로 만들고, 그 결과를 새 pending으로
삼아 기존 검증·os.replace 흐름을 그대로 통과시킨다. 실패는 명확한 예외 → finally가 job_dir 정리 →
기존 출력 무손상. (speed의 `_atempo_segment`와 완전히 같은 실패 계약)

### 2.2 per-segment 경로 — `synthesize()`의 Qwen 미선택 분기 (F5/GPT-SoVITS/Kokoro)

`segment_*.wav`를 만들고 단일이면 `os.rename(seg, final_path)`, 복수면
`_concat_with_silence(segment_paths, final_path)`로 **final_path에 직접** 쓴다(원자 교체 아님).
pitch를 이 경로에도 적용하려면, 최종 산출을 임시로 만든 뒤 pitch → 임시 → `os.replace(final)`로
바꿔 동일한 무손상 계약을 세운다.

> 이번 문제(원 화자보다 낮음)는 Qwen 경로에서 보고됐다. **1차 구현은 Qwen 경로만** 확실히 하고,
> per-segment 경로는 동일 함수 재사용으로 뒤이어 적용(스코프 분리). 두 경로 모두 "0=무변경, 실패=원본보존"을 지킨다.

### 2.3 metadata 구조 — `_METADATA_KEYS` / `_build_tts_metadata`

- `_METADATA_KEYS`는 고정 키 리스트. `_build_tts_metadata(**kw)`가 모든 키를 채운 dict를 반환(누락 없음).
- 현재 `speed`, `speed_postprocessed`, `silence_gap`, `output_sample_rate` 등이 있고
  **speed 후처리 여부(`speed_postprocessed`)가 pitch가 따라야 할 정확한 선례**다.
- 두 호출 지점: Qwen 경로(`info` dict + `_build_tts_metadata(... **info)`)와 per-segment 경로.

## 3. backend API 계약 초안

### 3.1 신규 모듈 `python/pitch_shift.py` (내가 만들 파일)

```
PITCH_MIN = -2.0
PITCH_MAX = 2.0
PITCH_STEP = 0.5

def clamp_quantize(semitones: float) -> float
    # None/비수치 → 0.0. [-2,2]로 clamp 후 0.5 단위 반올림. 반환은 항상 유효한 스텝값.

def semitones_to_ratio(semitones: float) -> float
    # 2 ** (semitones / 12.0)

def pitch_available(ffmpeg: str | None = None) -> tuple[bool, str]
    # ffmpeg -filters에서 rubberband 유무 → (True, "rubberband") | (False, "asetrate+atempo(폴백)")

def apply_pitch_shift(input_path, semitones, output_path, *, ffmpeg=None, sample_rate=None) -> str
    # semitones==0(양자화 후) → 아무 것도 하지 않고 그대로 통과시키라는 신호로 상위에서 스킵.
    #   (모듈은 방어적으로 0이면 input을 output에 복사하지 않고 예외 대신 "no-op" 반환값/플래그 제공)
    # rubberband 있으면: ffmpeg -i input -filter:a "rubberband=pitch=<ratio>:formant=preserved" output
    # 없으면 폴백 체인. timeout(120s)/OSError/returncode!=0/0바이트 → 부분 출력 삭제 후 RuntimeError.
    # 성공 시 output_path 반환. (_atempo_segment의 _rm_partial 패턴 그대로)
```

- **원자적 교체 방식**: 모듈은 순수하게 "input wav → output wav(임시)"만 만든다. 원자성은 호출부가
  기존처럼 `job_dir` 안 임시 → 검증 → `os.replace(final)`로 책임진다(모듈이 final을 직접 건드리지 않음).
- **실패 시 원본 보존**: 모듈은 실패를 조용히 삼키지 않고 RuntimeError를 던진다. 상위 `finally`가
  job_dir을 정리하고 `os.replace`에 도달하지 못하므로 기존 synthesized.wav가 남는다.
- **무변경 경로**: 상위에서 `clamp_quantize(pitch)==0.0`이면 pitch 단계를 아예 호출하지 않는다
  (speed의 `abs(speed-1)>1e-6` 게이트와 동형). 불필요한 재인코딩·품질 저하 없음.

### 3.2 인터페이스 제안 — **직접 수정하지 않음, 문서로만 제안** (담당 경계 밖)

- `python/tts_worker.py :: _synthesize_qwen_job(...)` 시그니처에 `pitch: float = 0.0` 추가,
  §2.1 지점에서 `clamp_quantize(pitch)!=0`일 때만 `apply_pitch_shift(pending → job_dir/pitched.wav)`
  후 그 결과를 pending으로 교체. `info`에 pitch 3필드 추가.
- `python/tts_worker.py :: synthesize(...)` 시그니처에 `pitch: float = 0.0` 추가 → Qwen/per-segment로 전달.
- `python/tts_worker.py`의 `_METADATA_KEYS`에 `pitch_semitones`, `pitch_method`, `pitch_postprocessed` 추가,
  두 `_build_tts_metadata(...)` 호출부에서 값 채움.
- `python/separate.py`: `args.tts_pitch = config.get("ttsPitch", 0.0)` 읽고 `synthesize(..., pitch=args.tts_pitch)` 전달.
- `src/shared/ttsConfig.ts`: `TtsInputOptions.ttsPitch?: number`, `TtsConfig.ttsPitch: number`,
  `buildTtsConfig`에서 `ttsPitch: o?.ttsPitch ?? 0.0` (**0 방어를 위해 반드시 `??`**, speed 주석과 동일 규칙).
- `src/renderer` (ProcessButton/TTSEditor/app.store/TtsResultInfo), `src/shared/types.ts`(metadata 타입),
  `src/main/ipc/audio.ipc.ts`는 **에이전트 B(emotion UX)와 겹치는 공용 파일**이므로 이번 backend 단계에서 손대지 않는다.

### 3.3 제안 metadata 필드

- `pitch_semitones` (float): 실제 적용된 양자화 값. 무변경이면 0.0.
- `pitch_method` (str|null): "rubberband" | "asetrate+atempo(fallback)" | null(무변경/미적용).
- `pitch_postprocessed` (bool): 후처리 수행 여부. `speed_postprocessed`와 동형.

## 4. 검증 계획

### 4.1 단위 테스트 `python/test_pitch_shift.py` (내가 만들 파일)

- `semitones_to_ratio`: 0→1.0, +12→2.0, -12→0.5, +1→≈1.05946 (수치 근사).
- `clamp_quantize`: 2.4→2.0, -3→-2.0, 0.3→0.5, 0.24→0.0, 0.7→0.5, None/"x"→0.0.
- 무변경: 양자화 0이면 apply를 부르지 않는(호출부 게이트) 계약을 모듈 no-op 신호로 검증.
- ffmpeg 왕복(ffmpeg 없으면 `skip`): lavfi sine 생성 → apply_pitch_shift(+1) →
  길이 동일(±1프레임), SR 동일, finite, peak<1.0(클리핑 없음).
- 실패 경로: 존재하지 않는 입력 → RuntimeError, 부분 출력 미잔류.

### 4.2 실제 합성 A/B (작업파일/에만, 커밋 금지)

- 0 / +0.5 / +1.0 / +1.5 semitone으로 동일 텍스트·참조 합성.
- 각 산출에 대해: 길이(pitch≠0이 원본과 ±수 ms 이내), SR 동일, `np.isfinite` 전부 True,
  peak(최대 절대값)와 클리핑(|x|≥0.999 샘플 수) 측정.
- **실제 F0 변화 측정**: 무음 제외 구간에서 프레임별 F0(예: librosa.pyin 또는 자기상관 — 측정 전용
  스크립트에서만, production 미의존) 중앙값을 비교해 목표 반음만큼 올랐는지 수치 확인.
  간이로는 이번 실측처럼 유성 구간 zero-crossing/자기상관 주기.
- 청취 비교(원 화자 대비): 산출 wav는 `작업파일/`에만 두고 커밋하지 않는다.

### 4.3 회귀

- `python smoke_test.py` (TTS 미포함 즉시 모드 + 전체) 및 pitch=0 경로가 기존 바이트를 그대로 두는지.
- pitch 필드 부재/0인 기존 config에서 동작 불변(하위 호환).

## 5. 파일 소유 / 충돌 지도

### 5.1 내가 만들/고칠 파일

- **신규(내 소유)**: `python/pitch_shift.py`, `python/test_pitch_shift.py`.
- **구현 시 수정(backend 담당)**: `python/tts_worker.py`(_synthesize_qwen_job/synthesize/_METADATA_KEYS/
  _build_tts_metadata 호출부), `python/separate.py`(ttsPitch 읽기·전달).

### 5.2 인터페이스 제안만(직접 수정 안 함)

- `src/shared/ttsConfig.ts`(+ `ttsConfig.test.ts`), `src/shared/types.ts`,
  `src/renderer/components/{ProcessButton,TTSEditor,TtsResultInfo}.tsx`, `src/renderer/stores/app.store.ts`,
  `src/main/ipc/audio.ipc.ts`.

### 5.3 다른 에이전트와 충돌 가능성

- **`python/tts_worker.py`** — 최대 공용 파일. 에이전트 B(emotion)가 `_synthesize_qwen_job`·감정 라우팅,
  에이전트 C(research)가 참조/프롬프트 부분을 건드릴 수 있음. 특히 `_METADATA_KEYS`/`_build_tts_metadata`
  호출부는 **B와 동시 확장 시 충돌 확실**. → WIP 문서(`tts-reference-region.md`) 권고대로 metadata 스키마
  확장은 한쪽이 먼저 develop에 넣고 다른 쪽이 rebase로 받아가는 순서 필요.
- **metadata 스키마(`_METADATA_KEYS` + `src/shared/types.ts`)** — pitch 3필드 vs emotion 필드 동시 추가 위험.
- **`TtsResultInfo.tsx`(결과 GUI)** — pitch 표시 vs emotion 표시 둘 다 이 컴포넌트를 늘림.
- **`ttsConfig.ts` / `audio.ipc.ts`** — 새 TTS 입력 필드(ttsPitch vs 감정 관련)가 같은 직렬화 지점 확장.
- research(C)와는 직접 코드 충돌 가능성 낮음(주로 조사/문서). 단 결론이 metadata·참조 구조를 건드리면 재확인.
