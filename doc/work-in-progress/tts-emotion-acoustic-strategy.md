# 감정 음향 전략 — 현재 상태와 계약

작성 2026-08-28. 대상 엔진: Qwen3-TTS-12Hz-0.6B-Base (`tts_model_type=base`, `tts_model_size=0b6`).

이 문서는 **무엇이 되고 무엇이 안 되는지**를 있는 그대로 적는다. 되지 않는 것을 되는 것처럼
적지 않는다. 이 문서와 코드·UI 문구가 어긋나면 문서가 아니라 코드가 틀린 것이다.

---

## 1. 한 줄 요약

**감정 음향 기능은 미완성이다.** 감정 태그 문법·UI·계약·capability 골격은 구현되어 있지만,
같은 참조 클립을 쓰는 한 모델에 전달되는 감정 제어 입력은 **하나도 없다**.

기존 결과를 "감정 구현 완료"로 표현하는 것은 금지한다.

---

## 2. 구현된 것 / 구현되지 않은 것

구현된 것:

- 감정 태그 문법(`[기쁨]` 등) 파싱 — `python/tts_grammar.py`, `src/shared/ttsGrammar.ts`
- 감정별 참조 등록 UI 골격 — `src/renderer/components/EmotionReferenceManager.tsx`
- 감정·표현 미리듣기(샘플러) 계약 — `src/shared/emotionSampler.ts`, `python/emotion_sampler.py`
- capability 계약(선언/프로브/정직성 강제) — `python/expressive_capability.py`
- 운율 측정 도구(F0 분위수·range·IQR·std, RMS) — `python/onset_continuity_metrics.py`

구현되지 않은 것:

- **같은 참조를 쓸 때 모델에 들어가는 감정 제어 입력** — 존재하지 않는다.
- 감정별 참조 클립의 후보 관리·측정·sampler 흐름 — 이번 작업에서 계약만 세웠다(§5).
- 감정 profile 보간 — 계약만 세웠다. 실제 합성 경로에는 아직 연결되지 않았다.
- 웃음 — 전략 없음(§8).

---

## 3. 왜 감정 차이가 약한가 — 측정된 사실

같은 참조 클립 하나로 기쁨·화남·슬픔 3종을 생성한 실측
(`E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3\analysis.json`, 읽기 전용):

- F0 변동폭(`f0_std_semitones`): 기쁨 4.285 / 화남 4.098 / 슬픔 4.090 / 참조 4.207 반음.
  **세 감정이 사실상 같다.** 감정 사이 최대 차이가 0.195 반음으로, 이 저장소의 분석 해상도
  기준값 `PROSODY_FLAT_SEMITONES = 0.5` 반음보다도 작다 — 즉 '평탄' 판정 문턱에도 못 미친다.
- F0 범위(`f0_range_semitones`): 10.148 ~ 11.352 반음에 모여 있다(참조 11.026).
- 중앙 F0(`f0_q50_hz`): 기쁨 226.4 / 화남 269.7 / 슬픔 250.0 Hz (참조 266.7 Hz).
  **기쁨이 가장 낮다** — 통념과 반대 방향이다. 즉 지금 나오는 차이는 감정 제어의 결과가 아니라
  같은 조건에서 매번 달라지는 생성 편차로 보는 편이 사실에 가깝다.

사용자는 이 3종을 듣고 "감정 차이가 약하다"고 확정했다. 측정이 그 판단과 같은 방향이다.

### 원인 — 코드 감사(B3)에서 확정된 사실

- voice clone 경로(`generate_voice_clone`)에는 감정·스타일 instruct 인자가 **없다**.
- `instruct` 는 `generate_voice_design` / `generate_custom_voice` 에만 있고, 두 함수 모두
  `tts_model_type` 게이트에서 Base 모델에 대해 `ValueError` 로 막힌다.
- tokenizer 에 감정·비언어·운율 토큰이 **0개**이고 SSML 유사 입력도 없다.
- `ref_text` 에 지시문을 섞는 것은 구조적으로 금지된다(ICL 정렬이 위치별 덧셈이라 깨진다).
- 따라서 현재 감정은 **오직 참조 클립 교체**(`ref_cache[emotion_id]`)로만 실현된다.
  같은 참조를 쓰면 모델 입력이 완전히 동일하므로, 감정 차이가 나올 통로 자체가 없다.

---

## 4. 모델 native 후보 — `instruct_ids`

유일한 미검증 통로다. 이번에 vendor 배선을 직접 따라가 확인한 사실:

- `generate_voice_clone(..., **kwargs)` → `_merge_generate_kwargs(**kwargs)` 는
  `merged = dict(kwargs)` 로 시작해 알려진 샘플링 인자만 덮어쓴다. 모르는 키는 **그대로 통과**한다.
- `Qwen3TTSForConditionalGeneration.generate` 의 시그니처에 `instruct_ids` 가 실제로 있고,
  `instruct_id is not None` 이면 talker 입력 임베드 앞에 붙인다.
- 즉 **코드 경로만 보면 수용될 자리는 있다.** 다만 이것은 배선 추적일 뿐이고,
  런타임에서 실제로 수용되는지 관측한 적이 없다 — **accepted 는 미확인이다.**
  관측 없이 accepted 를 확정하지 않는다.

그러나 같은 vendor 파일에서 확인한 반대 방향 사실:

- `generate_custom_voice` 에 `if self.model.tts_model_size in "0b6": instruct = None`
  (주석: `# for 0b6 model, instruct is not supported`) 가 있다.
- 우리 스냅샷의 `config.json` 은 `tts_model_size = "0b6"` 이다.

즉 **vendor 자신이 이 모델 크기에서 instruct 미지원을 선언**하고 있다. 게이트가 놓인 자리는
custom_voice 경로뿐이지만, 선언의 대상은 경로가 아니라 **모델 크기**다.

capability 계약 규칙 2("엔진이 스스로 unsupported 라고 선언하면 그대로 믿는다")에 따라
`emotion_instruction_text` 의 claim 은 `unsupported` 다. 따라서:

- `instruct_ids` 는 **숨은 실험 probe 로만** 유지한다.
- production 경로·UI 에서 활성화 금지. 기본값이 꺼짐인 정도가 아니라, production 컨텍스트에서는
  요청해도 켜지지 않는다(`instruct_probe_allowed`).
- accepted 를 관측해도 **honored 로 승격되지 않는다.** honored 는 실제 GPU A/B 측정 레코드가
  있을 때만 True 가 될 수 있고, 그 경우에도 claim 이 상한이라 최종 상태는 올라가지 않는다.

---

## 5. 이번 작업에서 고정한 계약

권위: `python/emotion_acoustic.py`. TS 거울: `src/shared/emotionAcoustic.ts`.

### 5.1 참조 배치(role) — 사실만 말한다

- `distinct` — 이 감정에 기본 참조와 **다른** 클립이 붙어 있다.
- `shared_default` — 기본 참조와 **같은** 클립을 쓴다.
- `absent` — 이 감정 전용 참조가 없다(기본 참조로 폴백).

role 은 판정이 아니다. "어떤 파일이 들어가는가"라는 사실이다.

### 5.2 감정 음향 프로필 — 감정별 참조에서 뽑는 값

`EMOTION_ACOUSTIC_PROFILE_FIELDS` (전부 숫자, 경로·전사문 없음):

F0 중앙/범위/IQR/변동폭, 유성 비율, RMS 중앙/범위, 발화 길이, 쉼 개수·총합·최장,
스펙트럼 기울기, 말 속도(전사 글자 수가 주어졌을 때만. 없으면 `speech_rate_available=0`).

**고정 프리셋 숫자를 만들지 않는다.** 이 값들은 전부 실제 참조 클립에서 측정한다.
"기쁨은 F0 +2 반음" 같은 표는 이 저장소 어디에도 없다.

### 5.3 분리도(separation) — 감정 참조가 기본 참조와 구별되는가

판정 축은 **반음 단위 축 4개**뿐이다: 중앙 F0 오프셋, 범위 차, IQR 차, 변동폭 차.

구별 기준은 새로 만들지 않는다. `onset_continuity_metrics.PROSODY_FLAT_SEMITONES`(0.5 반음)를
그대로 쓴다 — 이미 이 저장소가 "이보다 작으면 평탄"이라고 정의해 둔 **분석 해상도**이며,
내가 지어낸 감정 문턱값이 아니다.

dB·ms·자/초 축(RMS 범위, 스펙트럼 기울기, 쉼, 말 속도)은 **기록만 하고 판정에 쓰지 않는다.**
그 단위에는 계약이 정해 둔 해상도가 없기 때문이다. 숫자는 남기되 판정하지 않는다.

### 5.4 추종도(follow) — 결과가 참조 쪽으로 실제로 움직였는가

두 참조를 가장 크게 갈라놓은 축 하나를 골라, 기본 참조를 원점으로 두고
`감정참조 - 기본참조`(reference_gap)와 `생성결과 - 기본참조`(result_gap)를 잰다.

`followed = 1` 조건: **부호가 같고**, `|result_gap|` 이 해상도(0.5 반음) 이상.
방향이 반대이거나 해상도 아래면 따라가지 않은 것이다.

이것이 honored 의 유일한 근거다.

---

## 6. degraded 판정이 켜지는 시점

판정 상태는 `expressive_capability.CAPABILITY_STATES` 를 그대로 쓴다(병렬 어휘 금지).
상태는 언제나 `ProbeEvidence` 에서 파생된다 — 별도 규칙표를 두지 않는다.

- `absent` → **degraded** / `EMOTION_REF_ABSENT`
  태그는 받아들여졌지만 모델 입력이 기본 참조 그대로다.
- `shared_default` → **degraded** / `EMOTION_REF_SHARED_DEFAULT`
  같은 파일이므로 태그만 다르고 입력은 동일하다. **이 경우를 supported 로 표시하는 것은 금지다.**
- `distinct` + 측정 없음 → **unknown** / `EMOTION_REF_PROFILE_MISSING`
- `distinct` + 측정했으나 구별 안 됨 → **degraded** / `EMOTION_REF_NOT_SEPARATED`
- `distinct` + 구별됨 + 결과 미측정 → **unknown** / `EMOTION_RESULT_NOT_MEASURED`
- `distinct` + 구별됨 + 결과가 안 따라감 → **degraded** / `EMOTION_RESULT_NOT_FOLLOWED`
- `distinct` + 구별됨 + 결과가 따라감 → **supported** / `EMOTION_RESULT_FOLLOWED`

**supported 로 가는 길은 마지막 하나뿐이다.** 그 길은 실제 생성 결과를 측정해야만 열린다.
오늘 이 저장소에는 그 측정이 없으므로, 오늘의 정직한 답은 전부 degraded 아니면 unknown 이다.

---

## 7. accepted 와 honored 의 분리

`ProbeEvidence(attempted, accepted, honored)` 를 그대로 쓴다.

- `attempted` — 프로브를 **끝까지** 돌렸는가. 참조만 재고 결과를 안 쟀으면 False 다.
  결과적으로 "참조는 갈라 놨는데 결과는 모르겠다"는 성공이 아니라 unknown 으로 남는다.
- `accepted` — 입력이 실제로 달라졌는가(전용 참조가 들어갔는가 / instruct_ids 가 예외 없이 통과했는가).
- `honored` — 결과가 관측 가능하게 그 방향으로 움직였는가.

코드 수준 분리:

- `emotion_acoustic_evidence()` 는 follow 레코드가 없으면 `honored` 를 **True 로 만들 수 없다.**
  boolean 을 받지 않고 측정 레코드를 받는다 — 호출부가 "됐다"고 주장할 자리가 없다.
- `instruct_probe_evidence()` 도 같다. `accepted=True` 를 아무리 넣어도 follow 레코드 없이는
  `honored=False` 다.
- 타입 수준: `InstructProbeResult` 에 honored 필드가 없다. 브리지는 accepted 까지만 관측하고,
  honored 는 오프라인 분석기가 별도 측정으로 채운다.

---

## 8. 지금도 미지원인 것

- **웃음** — 모델 native 지원 없음. `LAUGH_NO_STRATEGY` 를 그대로 유지한다.
  별도의 실제 웃음 클립이나 비언어 생성 모델 없이 "지원"으로 승격하지 않는다.
  `emotionSampler` 테스트가 웃음 6행을 unsupported 로 잠그고 있고, 그 잠금은 풀지 않았다.
- **경악·비명 등 강한 비언어** — 웃음과 같은 이유로 전략 없음.
- **모델 native 감정 지시** — §4. probe 만 있고 honored 증거 없음.
- **동일 참조에서의 감정 분화** — 통로가 없다. 이것은 DSP 로 메울 수 있는 종류의 결핍이 아니다.

### DSP 의 위치

F0 contour / energy contour / tempo / tail decay / pause 는 다룰 수 있다. 그러나:

- 고정 프리셋 숫자를 지어내지 않는다. 감정별 참조 샘플에서 뽑은 값만 쓴다.
- **DSP 만으로 웃음·경악·진짜 감정을 구현했다고 표현하는 것은 금지한다.**
  DSP 는 이미 감정이 실린 참조를 따라가게 돕는 보조 수단이지, 감정의 출처가 아니다.

---

## 9. 다음 단계(이번 작업 범위 밖)

1. 감정별 참조 클립 후보를 실제로 등록·저장하는 셸 배선.
2. 등록된 후보를 sampler 흐름으로 들려주기(감정별 대사 + 후보 비교).
3. GPU A/B 로 follow 레코드를 실제로 채우기 → 그때 비로소 supported 가 가능해진다.
4. `instruct_ids` 실험 probe 를 오프라인에서 1회 돌려 accepted 를 관측하고,
   honored 를 별도 측정으로 판정.

GPU 합성은 이번 작업 범위가 아니다. 여기까지는 계약·구조·측정이다.
