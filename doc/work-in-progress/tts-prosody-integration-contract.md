# TTS prosody 통합 공용 계약 (pitch backend × emotion reference UX × research)

브랜치: `design/tts-prosody-integration-contract` (origin/develop `0788885`에서 분기).
성격: **계약 문서 전용.** production 코드·스키마 파일 수정 없음. 이 문서가 A/B/통합 브랜치가 지켜야 할 단일 계약이다.
근거: A `feature/tts-pitch-backend@cf524be`(pitch 설계+ffmpeg 실측), B `feature/tts-emotion-reference-ux@fed9686`(감정 참조 UX 설계), C `research/tts-prosody-control@45226c7`(Base 한계·제어축 연구).

---

## 0. 제어 2축 (C 연구 근거 — 공통 어휘)

로컬 모델은 `Qwen3-TTS-12Hz-0.6B-Base`(`tts_model_type: "base"`). **텍스트 지시로 감정을 바꾸는 기능이 없다**(`generate_voice_clone`에 instruction 인자 부재, 공식 토론 확인). 따라서 제어는 두 축뿐이다.

- **생성 축(generation)** — 모델 입력/조건을 바꾼다 → **모델 재합성 필요**. 감정별 참조 음성, ref_text/x_vector 모드, 언어, 샘플링(현재 bridge 미개방). **B(emotion reference)가 이 축**.
- **후처리 축(post-process)** — 생성된 WAV에 신호 처리 → **모델 재합성 없이 빠른 재처리 가능**(모델을 다시 돌리지 않으므로 재합성보다 빠르다. 단 "즉시/실시간"이 아니라 **실제 처리 시간은 WAV 길이와 CPU에 따라 달라진다**). pitch, speed(기존 atempo), pause(기존 silence_gap), energy(미구현). **A(pitch)가 이 축**.

두 축은 서로 독립 파이프라인이며 같은 결과에 함께 적용될 수 있다(감정 참조로 생성 → pitch로 미세 보정).

---

## 1. config 필드 (`src/shared/ttsConfig.ts` — **통합 브랜치가 최종 소유·수정**)

기존 필드는 전부 불변. 추가/재정의만 아래로 확정한다.

### 1.1 pitch 신규 필드 (통합 브랜치가 추가)
- `ttsPitch` — `TtsInputOptions.ttsPitch?: number`, `TtsConfig.ttsPitch: number`. 기본값 **0.0**.
  `buildTtsConfig`에서 `ttsPitch: o?.ttsPitch ?? 0.0` (**반드시 `??`** — 사용자 지정 0이 `||`로 변질 방지, speed 규칙과 동일).
  의미: 결과 WAV에 적용할 음높이 보정(반음). 범위 **-2.0 ~ +2.0, 0.5 단위**. TS는 UI 입력 제한만 하고,
  **정규화 권위는 Python `pitch_shift.clamp_quantize`**(비수치/범위초과/비스텝을 유효 스텝으로 강제, None→0.0).

### 1.2 감정 참조 3필드 — 역할이 다르며 서로 대체하지 않는다 (정정 1)

세 필드는 **각각 다른 역할**을 하며 하나가 다른 하나를 대신하지 못한다. 셋 다 `Record<emotionId, …>`, 기본 `{}`.

- `ttsEmotionRefSources: Record<emotionId, string>` (신규, 통합 브랜치 추가) —
  **사용자가 등록한 원본 감정 파일 경로.** 임시 클립 경로가 아니다. 분석·재생·재트림·**세션 재현**의 기준.
  앱 재시작 후에도 유효한 영속 경로여야 한다.
- `ttsEmotionRefs: Record<emotionId, string>` (기존, 타입 불변) —
  **현재 합성에 실제 사용할 effective 경로.** source에서 만든 확정 파생 3~10초 클립, 또는 유효한 ≤10초 원본.
  임시(refclip) 경로일 수 있어 **앱 종료 후 유효를 가정하지 않는다**. 만료/미확정/10초 초과 원본은 넣지 않는다.
- `ttsEmotionRefRegions: Record<emotionId, {start:number; duration:number}>` (신규, 통합 브랜치 추가) —
  **source에서 effective를 만든 구간**(초). start≥0, duration 3.0~10.0. 재현·기록용이며 **합성 입력에 영향 없음**.

세션 재현 규칙:
- **완전 재현은 `ttsEmotionRefSources`(원본 경로) + `ttsEmotionRefRegions`(구간)** 조합이 담당 — 앱 재시작 후 이 둘로 다시 분석·트림해 effective를 복원한다.
- `ttsEmotionRefs`(effective 임시 경로)는 **앱 종료 후 유효하다고 가정하지 않는다.**
- 결과 GUI에는 전체 경로가 아니라 **basename만** 표시. 전사 전문은 기존 정책대로 저장하지 않는다(언어/글자수/sha8만).

- `ttsReferenceOverride: string` (기본 참조) — 기존 그대로, 기본 참조의 effective 3~10초 클립. 기본 참조도 위 감정 3필드와 같은 원칙: 원본(원본 fileInfo.path)+region으로 재현, override는 effective 임시 경로.

---

## 2. metadata 필드 (재현 정보)

metadata는 두 경로로 채워진다: (a) Python `_build_tts_metadata`의 고정 키(`_METADATA_KEYS`), (b) main `audio.ipc.ts` result 핸들러가 `md`에 직접 주입하는 필드(현재 `requested_engine`/`original_reference_path`/`effective_reference_path`/`reference_region` 방식). 이 분리를 유지해 A와 통합 브랜치가 충돌하지 않게 한다.

### 2.1 Python `_METADATA_KEYS`에 추가 (**A 소유**)
- `pitch_semitones` — float. 실제 적용된 양자화 값. 무변경이면 **0.0**.
- `pitch_method` — str | null. **production 허용값은 `"rubberband"` | `null`(무변경/미적용) 둘뿐**(정정 3). `asetrate+atempo` 계열은 production 값에서 제외.
- `pitch_postprocessed` — bool. 후처리 수행 여부(`speed_postprocessed`와 동형).

### 2.2 main이 `md`에 주입 (**통합 브랜치 소유**, `_METADATA_KEYS` 밖)
- `emotion_reference_regions` — `Record<emotionId, {start:number; duration:number}>` | null.
  기존 `reference_region`(기본 참조)과 대칭. main result 핸들러가 config의 `ttsEmotionRefRegions`로 주입.

기존 26개 키는 전부 불변. A는 (2.1) 3키만 `_METADATA_KEYS`에 append하고, 통합 브랜치는 (2.2)만 main에서 주입한다.

### 2.3 metadata의 재현 한계 (추가 정합)
- **`emotion_reference_regions`(및 `reference_region`)만으로 완전 재현이 가능하다고 표현하지 않는다.** metadata는 **비민감 요약 + 실제 사용 사실**(어떤 구간이 쓰였는지의 기록)을 담당할 뿐이다.
- **완전 재현(앱 재시작 후 복원)의 책임은 session의 `source path + region` 조합**(§1.2)에 있다. metadata의 effective 경로는 임시일 수 있어 재현의 단일 근거가 될 수 없다.

---

## 3. original / effective reference 의미 (기존 확정 + 감정 확장)

- `original_reference_path` — 사용자가 **고른 원본 파일**. 분석·재생·전사·구간 선택·세션 재현의 대상.
- `effective_reference_path` — **실제 합성에 쓰인 경로**. 기본 참조는 `ttsReferenceOverride`(파생 클립) 우선, 없으면 원본(단 ≤10초일 때만). 감정 참조는 `ttsEmotionRefs[emotionId]`의 effective 경로.
- **원본↔effective 규칙(정정 4)**:
  - **유효한 3~10초 원본은 그 자체가 effective가 될 수 있다**(파생 클립을 강제로 만들 필요 없음). 이때 effective_path == original_path.
  - **10초 초과 원본은 합성에 직접 전달 금지** — 반드시 사용자가 확정한 3~10초 **파생 클립만** effective로 사용.
  - 즉 금지되는 것은 "원본 전달" 일반이 아니라 "**10초 초과 원본의 직접 전달**"이다. B가 이 경계를 렌더러에서 강제.

---

## 4. 감정별 reference region 표현

- config: `ttsEmotionRefRegions[emotionId] = {start, duration}` (초). 기본 참조 region과 대칭.
- metadata: `emotion_reference_regions[emotionId] = {start, duration}` (§2.2, main 주입).
- emotionId는 기존 `TTSEditor` EMOTION_GROUPS ↔ `tts_worker.EMOTION_TAGS`가 공유하는 id(예 `happy`,`sad`). **새 키 체계 금지.**

---

## 5. 만료 참조 오류 정책 (backend 방어 — 필수 불변식)

감정 참조가 등록됐으나 파일이 만료된 경우 **Python이 기본 참조로 조용히 폴백하면 안 된다**(현재 `tts_worker`가 `if emo_path and os.path.exists(emo_path)`로 silent-skip → 기본 참조 대체하는 버그가 v1.0.0에 잔존). **등록 여부의 기준은 `ttsEmotionRefSources`(원본 등록)**이며, 4개 불변식으로 확정:

1. **emotionId가 `ttsEmotionRefSources`에 없음** → 미등록. 기본 참조 폴백 **허용**(정상).
2. **source 등록 + effective 경로 존재·유효** → 감정 참조 **사용**.
3. **source 등록 + effective 없음/만료/부적합** → **명확한 오류**(silent fallback 금지). 오류 메시지에 감정 ID 지목.
4. **미사용 감정**(대사에 태그가 등장하지 않음)은 **등록 상태와 무관하게 현재 합성을 차단하지 않는다**.

집행 위치(2단계 방어):
- **B(1차, UI/IPC)**: 렌더러/IPC에서 차단 — 만료/미확정 경로를 `ttsEmotionRefs`(effective)에 넣지 않고, 대사에 쓰인 감정이 미준비면 합성 차단(감정 지목 안내). 미사용 감정은 비차단·미전송.
- **최종 통합(2차, Python)**: 위 불변식을 `tts_worker.py`에 **코드로 완성**한다. **UI 검사만으로 완료 판정하지 않는다.** 이를 위해 integration 단계에서 다음을 Python까지 전달·집행한다(아래 §5.1). 이 `tts_worker`/`separate.py` 수정은 A의 pitch 병합 이후 통합 단계에서 A와 협의해 진행.

### 5.1 Python 전달 계약 (정정 2 — "tts_worker/separate.py 불변" 표현 철회)
§1.2에서 "Python·tts_worker·separate.py 불변"이라 했던 것을 **정정한다**. 만료 backend 방어를 위해 integration 단계에서 Python까지 정보가 전달돼야 하므로 완전 불변이 아니다. 단, **이는 integration 단계 작업**이며 **A/B의 병렬 구현 단계에서는 여전히 A=Python(pitch만)·B=renderer/IPC만**이다.
- integration 단계에서 `emotion_ref_sources`(또는 등록된 emotionId 목록)를 Python config로 전달한다.
- `tts_worker`는 **실제 대사에서 사용된 emotionId만 검증**한다(미사용 ID는 검증 대상 아님 — 불변식 4).
- 사용된 ID가 (source에) 등록됐는데 effective가 없으면 → **기본 폴백 금지, 명확한 오류**(불변식 3).
- **사용되지 않은 감정 참조는 Qwen bridge segment에 전달·검증하지 않는다**(불필요한 로딩/검증 방지, 불변식 4).

---

## 6. 0 semitone 무후처리 / pitch 실패 보존 정책

- **0 무후처리**: `clamp_quantize(ttsPitch) == 0.0`이면 pitch 단계를 **아예 호출하지 않는다**. 기존 synthesized.wav 바이트 그대로(재인코딩·품질 저하 없음). speed의 `abs(speed-1)>1e-6` 게이트와 동형.
- **실패 시 보존**: `pitch_shift.apply_pitch_shift`는 실패를 조용히 삼키지 않고 **RuntimeError**를 던지고 부분 출력을 삭제한다. 상위 `_synthesize_qwen_job`의 흐름 = job_dir 임시본 생성 → pitch 임시본 → 검증 → `os.replace(final)`. 실패는 `os.replace` **직전** 예외 → `finally: rmtree(job_dir)` → `os.replace` 미도달 → **기존 synthesized.wav 무손상**.
- 원자성 책임 분리: `pitch_shift` 모듈은 "input wav → output wav(임시)"만 만든다. final 교체 원자성은 호출부(`tts_worker`)가 책임(모듈은 final을 직접 건드리지 않음).

### 6.1 pitch 적용 범위 — 전 엔진 공통 최종 후처리 (엔진 무관)

pitch는 **모델 입력 제어가 아니라 최종 WAV 신호 후처리**다. 따라서 특정 엔진에 묶이지 않고, **모든 엔진(Qwen3 / GPT-SoVITS / F5 / Kokoro)이 생성한 최종 `synthesized.wav`에 동일 정책으로 적용**되는 공통 단계여야 한다.

- **적용 시점**: speed(atempo) 세그먼트 처리와 문장 결합(`_concat_with_silence`)이 **모두 끝나 최종 WAV가 완성된 뒤 마지막 단계**로 pitch를 적용한다. pitch가 speed·결합보다 앞서면 안 된다.
- **공통 지점 권장 형태**: 두 경로가 각기 다르게 pitch를 끼워 넣지 말고, "최종 WAV 경로 + pitch"를 받아 **in-place 원자 교체**(job 임시 → pitch → 검증 → `os.replace(final)`)하는 **단일 공통 함수** 하나를 두고, 각 엔진 경로는 최종 WAV 완성 직후 그 함수를 **한 번** 호출한다.
  - Qwen 배치 경로(`_synthesize_qwen_job`): 기존 pending→`os.replace(final)` 흐름의 그 지점.
  - per-segment 경로(`synthesize()`의 F5/GPT-SoVITS/Kokoro 분기): 현재 `final_path`에 직접 쓰므로(단일=rename, 복수=concat), 최종 WAV 완성 직후 같은 공통 함수로 in-place 후처리. per-segment 경로에 무손상 원자 교체 계약을 세운다.
- **0 무호출(전 엔진)**: `clamp_quantize(pitch)==0`이면 어떤 엔진에서도 pitch 함수를 호출하지 않는다 → 기존 바이트 그대로.
- **엔진별 미지원 처리**: 구조상 특정 엔진에서 최종 WAV 후처리가 불가능하거나(예: 스트리밍 산출 등) rubberband가 없으면 **조용히 무시 금지**. §7대로 UI 비활성 또는 명확한 오류로 알리고, 적용이 안 된 경우 `pitch_postprocessed=false` + `pitch_method=null`로 metadata에 **미적용 사실**을 남긴다(사유 식별 가능하게).
- **단위 테스트(모델 로딩 없이)**: 실제 엔진을 돌리지 않고 **각 엔진의 "가짜 최종 WAV"**(lavfi sine 등으로 만든 mono/24k wav)를 공통 후처리 함수에 통과시켜 길이·SR·finite·peak·클리핑·F0·0-무호출·실패-원본보존을 검증한다. 엔진 종류와 무관하게 동일 경로임을 이 테스트가 보장.

### 6.2 A의 범위 경계 (공통화가 소유 범위를 넘을 때)

A는 pitch **backend helper(`pitch_shift.py`)와 공통 적용 함수의 호출 계약**을 소유한다. 단 per-segment 경로의 원자 교체 도입이 `tts_worker.py`/엔진 분기 구조를 **크게 변경**해야 한다면, A는 **임의로 확장하지 말고**:
- `pitch_shift.py`(helper) + Qwen 경로 적용(자신의 확실한 범위) + **"각 엔진 최종 WAV 지점에서 이 함수를 이렇게 호출하라"는 호출 계약(시그니처·인자·반환·실패 규약)**을 제출하고,
- per-segment 경로들의 **최종 연결은 integration 브랜치로 넘긴다**(integration이 계약대로 각 분기에 한 줄 배선 + 무손상 원자 교체 마감).
- 즉 1차 구현의 확실한 산출은 "helper + Qwen 경로 + 공통 함수 계약"이고, 전 엔진 배선은 범위가 크면 integration이 수령한다. 어느 쪽이든 **0=무호출·실패=원본보존·미적용=metadata 표시**는 불변.

---

## 7. rubberband / ffmpeg 정책 (A 실측 기반)

- 실측(2026-08-22): 프로젝트 ffmpeg = WinGet Gyan.FFmpeg 8.1-full, `--enable-librubberband` 포함 → **rubberband 필터 사용 가능**. 길이·SR 유지 + `formant=preserved` 정상 + F0 반음 상승 확인.
- **기본 경로**: `rubberband=pitch=<ratio>:formant=preserved`, `ratio = 2**(semitones/12)`. production pitch 경로는 **rubberband 단일**이다.
- **rubberband 미지원 환경(정정 3 — 모순 제거)**: **어떤 저품질 폴백도 production에 넣지 않는다.** `asetrate+atempo` 계열은 production 경로·`pitch_method` 값에서 **완전히 제거**한다. `pitch_available()`이 rubberband 부재를 감지하면:
  - `ttsPitch == 0`(양자화 후) → pitch 무관, **기존 합성 정상 동작**.
  - `ttsPitch != 0` → **UI에서 pitch 비활성**(슬라이더 비활성 + 사유 표시), 또는 합성 시 **명확한 `PITCH_UNAVAILABLE` 오류**. **조용한 음질 저하 fallback 금지.**
- **배포 의무(라이선스)**: librubberband는 **GPL**. rubberband를 활성화한 ffmpeg는 GPL 빌드다. AudioForge가 이 ffmpeg를 번들/배포하면 GPL 의무(소스 제공·라이선스 고지)가 발생한다. 배포 형태(시스템 ffmpeg 사용 vs 번들)에 따라 의무가 갈리므로 **배포 단계에서 라이선스 검토 필수** — 이 계약에 기록해 둔다.

---

## 8. UI 표시 용어 (C 근거 — 과장 금지)

- pitch: **"음높이 보정(반음)"**. 후처리 축이라 **재합성 없이 결과에 적용**됨을 표시.
- speed: "속도", pause: "문장 간 간격".
- 감정 참조: **"감정별 참조 음성"** + "참조 구간(3~10초)".
- 결과 카드(TtsResultInfo): "음높이 <±n반음>", "감정 참조 구간 <감정: start~end초>". **경로는 전체 경로가 아니라 basename만** 표시(§1.2).
- **금지 표현**: "AI가 문맥 읽고 감정 연기", "텍스트로 감정 지시" 등 Base가 못 하는 것을 암시하는 문구. 감정은 **"참조 음성 + 후처리로 근사"**한다고 아티스트가 이해할 평이한 말로.
- formant 보존은 사용자 언어로 "자연스러움 우선"으로 노출(내부 옵션명 노출 금지).

---

## 9. 브랜치별 파일 소유권 (재확정)

### A — backend 전용 (`feature/tts-pitch-backend`)
- 소유(수정): `python/pitch_shift.py`(신규), `python/test_pitch_shift.py`(신규), `python/tts_worker.py`의 **pitch 후처리 영역 + `_METADATA_KEYS` pitch 3키 + `_build_tts_metadata` 호출부 pitch 값**, `python/separate.py`의 **Python config 수신 영역(`ttsPitch` 읽어 전달, 없으면 0.0)**.
- **수정 금지**: `src/shared/ttsConfig.ts`, `src/renderer/stores/app.store.ts`, `src/renderer/components/ProcessButton.tsx`, `src/main/ipc/audio.ipc.ts`, `src/renderer/components/TtsResultInfo.tsx`.
- A는 Python 계약 필드를 구현하되 **renderer 연결은 하지 않는다**(ttsPitch 부재 config에서 0.0 기본으로 하위호환 동작).

### B — 감정 참조 UX/수명 전용 (`feature/tts-emotion-reference-ux`)
- 소유(수정): `ReferenceRegionPanel.tsx`(또는 신규 공통 region 컴포넌트), `src/renderer/components/TTSEditor.tsx`, `src/renderer/stores/app.store.ts`, `src/main/ipc/audio.ipc.ts`의 **참조 클립 IPC/수명 영역(`refClipDirs` 맵·clipKey)**, `src/preload/index.ts`, `src/main/services/refclip-cleanup.ts`, 관련 테스트/E2E.
- **수정 금지**: `audio.ipc.ts`의 **result metadata 블록**, `src/renderer/components/TtsResultInfo.tsx`.
- B는 `ttsEmotionRefs`에 **모델에 실제 전달할 effective 3~10초 클립 경로만** 넣는다(§1.2, §3).

### C — 연구 문서만 (`research/tts-prosody-control`)
- production 수정 없음. `doc/research/tts-prosody-control.md`만.

### 공용 파일 — 후속 통합 브랜치 (`feature/tts-prosody-integration`)
A/B 구현·검토 후 **갱신된 develop에서 생성**, **한 명(통합 담당)만** 수정:
- `src/shared/ttsConfig.ts`(§1 신규 필드: `ttsPitch`·`ttsEmotionRefSources`·`ttsEmotionRefRegions`), metadata 공용 연결(§2.2 main 주입), `src/renderer/components/TtsResultInfo.tsx`(pitch·감정 표시), **pitch UI**(ProcessButton/TTSEditor의 pitch 슬라이더 배선), session 재현 정보(source+region 저장/복원).
- 이 브랜치가 A의 `ttsPitch`(Python)와 renderer를 연결하고, **§5.1 emotion_ref_sources/등록 ID의 Python 전달 + `tts_worker`의 사용-감정 검증(§5 2차 방어)**을 A와 협의해 마감한다(`separate.py`의 감정 source 수신 포함).

---

## 10. 병합 순서 (rebase 금지, force-push 금지)

원격 push된 A/B 브랜치는 **rebase 금지**. 통합 시:
1. **A 검토·테스트 → develop에 `--no-ff` 병합**(Python 백엔드 + metadata pitch 3키 확정. renderer 미연결이라 스키마 기준점).
2. **B**: 필요 시 `origin/develop`을 **merge로 수령**(rebase 아님)하거나, 완성된 B를 이후 develop에 `--no-ff` 병합.
3. **C**(문서)는 임의 시점 병합 가능(코드 무영향).
4. 공용 파일 충돌은 **`feature/tts-prosody-integration`에서 해결**(A/B가 직접 공용 파일을 안 건드렸으므로 병합 자체는 깔끔; 통합 브랜치가 §1/§2.2/§9-공용을 한 곳에서 작성).
5. develop 병합은 **각 구현 완료·검토·별도 승인 전까지 금지**. master/tag(ca42b0e/v1.0.0) 절대 불변.

---

## 11. 최종 통합 테스트 매트릭스

**단위/타입/빌드**: python discovery(+`test_pitch_shift`) · npm test(ttsConfig/refclip/store) · tsc node/web · build.

**Python backend(A)**:
- `clamp_quantize`(2.4→2.0, -3→-2.0, 0.3→0.5, 0.24→0.0, None→0.0), `semitones_to_ratio`(0→1.0, +12→2.0, -12→0.5).
- ffmpeg 왕복(rubberband): 길이 유지(±1프레임)·SR 유지·finite·peak<1.0(클리핑 없음)·F0 목표 반음 상승.
- pitch=0 → 무호출·바이트 불변. 실패 입력 → RuntimeError·부분출력 미잔류·기존 wav 보존.
- `pitch_method`는 `"rubberband"` | `null`만 관측(asetrate 폴백 값이 production에 절대 등장 안 함).
- rubberband 미탐지 시: `ttsPitch=0` 정상 합성 / `ttsPitch!=0` → UI 비활성 또는 `PITCH_UNAVAILABLE` 명확 오류(조용한 저품질 폴백 없음).
- **전 엔진 공통 후처리(§6.1, 모델 로딩 없이)**: 각 엔진의 가짜 최종 WAV(Qwen/GPT-SoVITS/F5/Kokoro 각 1개, lavfi sine mono/24k)를 공통 pitch 함수에 통과 → 길이·SR·finite·peak·클리핑·F0 목표 상승. pitch=0은 전부 바이트 불변. 미적용 시 `pitch_postprocessed=false`·`pitch_method=null` 기록 확인.

**감정 만료 불변식(§5, B+통합)**:
- 미등록→기본 폴백 / 등록+존재→사용 / 등록+만료→명확한 오류. **tts_worker 코드 레벨로도 검증**(UI 검사만으로 완료 판정 금지).

**Electron E2E**:
- 기본 합성 회귀(검은화면/crash 0).
- pitch 0(무후처리) / pitch +1(F0 상승, 길이·SR 유지) 결과 검증 + metadata pitch 3필드 표시.
- 감정 기본+기쁨+슬픔 **3클립 동시 유지**, 한 감정 재확정 시 타 감정 클립 불변(경로/해시), 대사 태그별 **올바른 감정 클립 전달**(config JSON 검사), `emotion_reference_regions` metadata 표시.
- 감정 만료 → 명확한 오류(silent fallback 없음, **`tts_worker` 코드 레벨로도 검증**). 미사용 감정 **비차단·미전송**(대사에 없는 등록 감정이 합성을 막지 않음, bridge segment 미전달).
- **앱 재시작 후 세션 재현 1건(추가 정합)**: 감정 참조 등록·구간 확정 후 앱 종료 → 재시작 → `ttsEmotionRefSources`+`ttsEmotionRefRegions`(및 기본 참조 source+region)로 effective를 **다시 분석·트림해 복원**하고 재합성 가능함을 단언(effective 임시 경로에 의존하지 않음을 확인).
- 연속 합성(pitch+감정 병용) 2회, "이미 처리 중"/TOO_LONG/만료 0.
- reset·앱 종료 정리(venv 자식 0·`.qwen-job-*` 0·refclip 0), **resources/ 원본 불변**(스냅샷).
- GPU 여유/경합 각각 device 선택(cuda/cpu, source=nvidia-smi) 완료.
- 완료 대기 350초(watchdog 300 초과 여유, production timeout 불변) 유지.

---

## 12. 요약 — 충돌이 사라지는 이유

A는 Python만(스키마·renderer 무접촉), B는 renderer/IPC 클립 수명만(Python·result metadata 무접촉), 공용 스키마(`ttsConfig`·main metadata 주입·`TtsResultInfo`·pitch UI)는 통합 브랜치 **한 곳**에서만 작성한다. A/B가 서로의 소유 파일을 건드리지 않으므로 develop 병합은 깔끔하고, 남는 결합은 통합 브랜치가 계약(§1·§2·§9)대로 배선한다.
