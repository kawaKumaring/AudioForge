# TTS 감정·운율(prosody) 제어 범위 연구

> **상태 (2026-09-03)** — 이 문서는 2026-08-22 조사 기록이며 그대로 보존한다.
> 감정·음률의 현재 기술 권위는 [감정 음향 전략](../work-in-progress/tts-emotion-acoustic-strategy.md)이고, 이 문서의 각 결론이
> CURRENT / IMPLEMENTED / STALE / OPEN 중 무엇인지는 그 문서 §3.1 에 정리돼 있다.
>
> 특히 주의할 두 가지. (1) "pitch·energy 는 아직 어디에도 없다"는 **STALE** 이다 —
> pitch 는 rubberband 후처리로, energy 는 macro gain 으로 구현됐다.
> (2) "CustomVoice 등은 설치 금지 대상"은 **STALE** 이다 — 금지가 아니라 미설치이고,
> 그 뒤 설치된 1.7B 는 **Base** 라서 instruction 감정 제어가 없다.
> §4 의 감정별 pitch/speed/pause 범위표는 **가설이며 프리셋으로 구현하지 않았다.**


> 담당: 에이전트 C (prosody/emotion research)
> 브랜치: `research/tts-prosody-control` (origin/develop 0788885 분기)
> 성격: **연구 문서 전용**. production 코드·스키마 파일 변경 없음. 모델/패키지 추가 설치 없음.
> 작성일: 2026-08-22

이 문서는 현재 AudioForge의 Qwen3-TTS Base 화자 복제(voice clone)를 유지하면서
근거 기반으로 감정·운율을 어디까지, 어떤 수단으로 제어할 수 있는지 정리한다.
숫자 범위 초안은 **가설(측정 대상)** 이며 확정 사실이 아니다.

---

## 0. 핵심 요약 (먼저 읽기)

- 로컬 모델은 **`Qwen/Qwen3-TTS-12Hz-0.6B-Base`** (revision `5d83992436eae1d760afd27aff78a71d676296fc`).
  config에서 `tts_model_type: "base"`, `tokenizer_type: "qwen3_tts_tokenizer_12hz"` 확인.
- **Base 모델은 "텍스트 지시로 감정을 바꾸는" 기능이 없다.** 참조 음성을 "있는 그대로" 복제한다.
  감정/스타일을 텍스트 instruction으로 넣으려면 별도 모델(CustomVoice 등)이 필요하며,
  이는 **설치 금지 대상**이다. 따라서 현 구성에서 감정 제어는 두 축뿐이다.
  1. **참조 기반(reference-based)**: 감정별로 다른 참조 음성을 쓴다.
  2. **신호 후처리(post-process)**: 생성된 wav에 speed/pause/pitch/energy를 가한다.
- 현재 AudioForge Qwen 경로는 위 (1)의 일부(감정별 참조)와 (2)의 일부(speed=atempo,
  silence_gap=문장 간 무음)만 사용한다. pitch/energy 제어는 **아직 어디에도 없다.**

---

## 1. 로컬 모델 API 실측 (read-only)

실측 대상은 메인 저장소의 gitignore된 공유 externals다(worktree에는 없음).
`tts_worker.py`의 `_QWEN_SNAPSHOT` 상수가 가리키는 경로를 파일 목록/텍스트 config만 확인.
가중치(`model.safetensors`, ~1.83GB)는 열지 않았다.

### 1.1 로컬 스냅샷 구성

경로: `externals/qwen3_tts_hf/hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-Base/snapshots/5d839924.../`

파일:
- `config.json` (4.5KB), `generation_config.json` (245B)
- `model.safetensors` (1.83GB), `vocab.json` (2.78MB), `merges.txt` (1.67MB)
- `tokenizer_config.json`, `preprocessor_config.json`
- `speech_tokenizer/` (config.json, configuration.json, model.safetensors, preprocessor_config.json)

`config.json` 핵심 값(실측):
```
"architectures": ["Qwen3TTSForConditionalGeneration"]
"model_type": "qwen3_tts"
"tokenizer_type": "qwen3_tts_tokenizer_12hz"
"tts_model_size": "0b6"
"tts_model_type": "base"          ← Base 확정
"speaker_encoder_config": { "enc_dim": 1024, "sample_rate": 24000 }
```

`generation_config.json`(실측, 이 값이 기본 샘플링):
```
do_sample: true, temperature: 0.9, top_p: 1.0, top_k: 50,
repetition_penalty: 1.05,
subtalker_dosample: true, subtalker_temperature: 0.9, subtalker_top_p: 1.0, subtalker_top_k: 50,
max_new_tokens: 8192
```

### 1.2 qwen_tts 패키지 API (`inference/qwen3_tts_model.py`)

Base 복제에서 실제로 호출되는 진입점은 `generate_voice_clone(...)`이다.
서명(실측 발췌):
```python
def generate_voice_clone(
    text, language=None, ref_audio=None, ref_text=None,
    x_vector_only_mode=False, voice_clone_prompt=None,
    non_streaming_mode=False, **kwargs)
```

`generate_voice_clone`과 `create_voice_clone_prompt`은 둘 다 `if self.model.tts_model_type != "base"`
가 아니면 `ValueError`를 던진다 — 즉 **이 두 메서드는 Base 전용이며, Instruct 계열은 다른 경로**를 쓴다.

**Base clone에서 실제로 노출되는 제어 인자**(docstring + `_merge_generate_kwargs` 실측):

| 인자 | 성격 | 비고 |
|---|---|---|
| `text` | 필수 | 합성 대상 |
| `language` | 텍스트 언어 | 지원값 검증(`_validate_languages`). AudioForge는 Korean/English/Chinese/Japanese 매핑 |
| `ref_audio` | 화자 복제 참조 | wav 경로/URL/base64/(ndarray,sr) |
| `ref_text` | ICL용 참조 전사 | `x_vector_only_mode=False`면 **필수**(비면 ValueError) |
| `x_vector_only_mode` | 복제 방식 | True=화자 임베딩만(ref_text 무시), False=ICL(참조 코드+전사 조건화) |
| `do_sample` / `temperature` / `top_p` / `top_k` / `repetition_penalty` | 샘플링 | 미지정 시 generation_config 값 사용 |
| `subtalker_dosample` / `subtalker_temperature` / `subtalker_top_p` / `subtalker_top_k` | 서브토커 샘플링 | tokenizer v2(=12Hz)에서 유효 → 이 모델에 유효 |
| `max_new_tokens` | 길이 상한 | codec 토큰 수 |
| `**kwargs` | HF generate 전달 | 그 외 transformers generate 인자 |

**여기에 "감정/스타일 텍스트 지시" 인자는 존재하지 않는다.** `language`는 언어일 뿐 스타일이 아니다.

### 1.3 현재 AudioForge가 실제로 쓰는 것 (bridge 실측)

`python/qwen_bridge.py`는 `generate_voice_clone`을 호출하되 다음만 넘긴다:
```python
model.generate_voice_clone(
    text=..., language=lang_name,
    ref_audio=..., ref_text=..., x_vector_only_mode=xvo)
```
- **샘플링 인자(temperature 등)를 전혀 넘기지 않는다** → generation_config 기본값 고정
  (temp 0.9 / top_p 1.0 / top_k 50 / rep_penalty 1.05). = 재현성/제어 여지가 코드상 미개방.
- 각 세그먼트 wav는 **raw 저장, 후처리 없음**(bridge 주석 명시). speed/pause 후처리는
  부모(`tts_worker.py`)가 한다.
- 감정별 참조는 `tts_worker.py`의 `ref_cache[emotion_id]`로 처리(감정마다 다른 참조 wav).
  즉 **Qwen 경로의 감정 = 참조 기반**이다.
- 주의: `tts_worker.py`의 `EMOTION_PROMPTS`(괄호 안 영어 지시문, 예 `(happily, with joy...)`)는
  **F5-TTS의 `ref_text`로만** 쓰이고 **Qwen에는 주입되지 않는다.** Qwen에서 이 영어 지시문을
  ref_text로 넣는 것은 화자 복제 전사와 무관한 텍스트를 참조 조건에 섞는 것이라 오히려 위험(§3 참고).

---

## 2. 공식 Qwen 자료로 확인한 Base vs Instruct 기능 경계

근거 URL:
- Base 모델 카드: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base
- CustomVoice "감정 커스터마이즈" 토론: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/discussions/38
- CustomVoice 모델: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
- VoiceDesign 모델: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign
- 공식 레포: https://github.com/QwenLM/Qwen3-TTS

확인된 경계:
- **Base**: 화자 복제(reference audio → clone) + fine-tuning 대상. **텍스트 지시 감정 제어 없음.**
  CustomVoice 토론에서 유지보수/커뮤니티 답변 요지: Base는 "있는 그대로만 복제(it only clones the
  voice as it is)"하며 instruction 파라미터를 Base에 줘도 **효과가 없다**. 감정을 넣으려면
  "**base 모델을 감정 데이터셋으로 파인튜닝**해야" 하고 결과도 "mediocre at best".
- **CustomVoice / Instruct 계열**: `emotion/angry/sad` 같은 자연어 지시로 감정·스타일 제어 가능.
  1.7B가 0.6B보다 감정 제어가 강함(모델 카드/가이드).
- **VoiceDesign**: 자유 서술로 음색을 설계.

결론(경계 초안):
> **현재 설치된 0.6B-Base로는 "텍스트로 감정을 지시"할 수 없다. 이를 지원한다고 가정하지 말 것.**
> Base에서 얻을 수 있는 표현 변화는 (a) 참조 음성 자체의 감정, (b) 샘플링 다양성(temperature 등에
> 의한 미세한 톤 변동), (c) 생성 후 신호 후처리뿐이다. 텍스트 지시 감정은 모델 교체/추가(금지)나
> 파인튜닝(별도 대형 작업)이 있어야 한다.

---

## 3. 제어 수단 비교 — 참조 기반 vs 신호 프리셋

### 3.1 참조 기반(감정별 reference audio)
- 장점: 감정의 **음색·억양·호흡까지 자연스럽게** 반영. 모델의 실제 표현력 사용.
- 단점:
  - 감정마다 **깨끗한 3~10초 참조가 필요**(현 정책 GPTSOVITS_POLICY와 동일 게이트).
  - 참조가 다르면 **화자 유사도가 흔들릴 수 있다**(감정 참조가 원 화자와 음색이 다르면 clone이 그쪽으로 끌림).
  - 변경 시 **반드시 재합성**(모델 재실행).
  - ref_text/ICL 모드일 때 참조 전사 품질에 결과가 민감.
- x_vector_only vs ICL:
  - `x_vector_only_mode=True`: 화자 임베딩만 → 감정 참조의 "말투"보다 "음색"에 가깝게, 유사도 안정적.
  - `x_vector_only_mode=False`(ICL): 참조 코드+전사까지 조건화 → 감정 억양 반영 강하나 유사도 변동 큼.

### 3.2 신호 후처리 프리셋(pitch / speed / energy / pause)
- 장점: 모델 재실행 없이(대부분) **즉각·결정론적**. 화자 참조를 안 바꾸므로 유사도 보존에 유리.
- 단점:
  - 감정의 **본질(음색·호흡·억양 곡선)** 은 못 만든다. "빠르고 높게" 정도의 표층 신호만.
  - pitch를 크게 밀면 **포먼트가 틀어져 다른 사람 목소리처럼** 들린다(유사도 훼손).
  - 과하면 기계적/부자연(한국어 자연스러움 저하).
- 각 축의 성격:
  - **speed**: 현재 ffmpeg `atempo`(피치 불변, 길이만). 후처리, 재합성 불필요.
  - **pause**: 문장 간 무음(`silence_gap`) + (확장 여지) 문장 내 구두점 pause. 후처리.
  - **pitch**: 현재 미구현. 반음(semitone) 단위 시프트. **포먼트 보존 여부가 유사도 관건**
    (formant-preserving pitch shift 권장 — 에이전트 A 백엔드 영역).
  - **energy(gain/dynamics)**: 현재 미구현. 라우드니스/게인 또는 가벼운 컴프레션. 후처리.

### 3.3 상호작용(주의)
- pitch↑ + speed↑ 동시에 크게 → "다람쥐" 효과. 감정별로 **둘의 조합 상한**을 둬야 한다.
- ICL 감정 참조 + 후처리 pitch 동시 사용 → 이중으로 톤이 바뀌어 예측 어려움. **한 번에 하나의
  주 수단**을 정하고 나머지는 미세 보정으로 쓰는 것을 권장.
- temperature↑ → 표현 다양성↑이지만 **발음 안정성·유사도↓**. 감정 "다양화" 용도로만, 소폭.

---

## 4. 안전 실험 범위 초안 (가설 — 측정으로 확정할 것)

전제: **주 수단은 참조 기반, 후처리는 보조 미세 보정.** 아래는 "화자 유사도를 크게 해치지 않을 것으로
기대되는" 후처리 초기 탐색 범위다. 확정값이 아니며 §5 블라인드 평가로 좁힌다.
pitch는 **포먼트 보존 시프트** 전제(비보존이면 범위를 절반으로).

| 감정 | pitch(반음) | speed(배) | pause 배율 | energy(dB) | 비고 |
|---|---|---|---|---|---|
| 기쁨(happy) | +1 ~ +3 | 1.05 ~ 1.15 | 0.8 ~ 1.0 | 0 ~ +2 | 밝고 빠르게, 문장 간 짧게 |
| 슬픔(sad) | -2 ~ 0 | 0.85 ~ 0.95 | 1.1 ~ 1.4 | -3 ~ 0 | 느리고 낮게, 쉼 길게 |
| 화남(angry) | 0 ~ +2 | 1.0 ~ 1.1 | 0.7 ~ 0.9 | +1 ~ +4 | 에너지·자모 강세, 쉼 짧고 날카롭게 |
| 차분함(calm) | -0.5 ~ +0.5 | 0.92 ~ 1.0 | 1.0 ~ 1.2 | -1 ~ +1 | 거의 중립, 쉼 약간 여유 |

가드레일(유사도 보호):
- pitch 절대값 **±3 반음 이내**를 1차 상한으로. 이를 넘으면 유사도 평가를 필수 재측정.
- pitch·speed **동시 최대치 금지**(한쪽이 상한이면 다른 쪽은 중앙값 이하).
- energy는 클리핑 방지(피크 -1dBFS 유지), 과한 컴프레션 금지.
- 모든 감정에서 **기본(중립) 대비 A/B**로 유사도 열화가 유의미하면 그 조합 폐기.

---

## 5. 블라인드 평가표 (3축 분리)

핵심 원칙: **화자 유사도 / 한국어 자연스러움 / 감정 전달력을 서로 섞지 않고 따로 채점.**
한 샘플을 듣고 세 축을 각각 독립 문항으로 평가한다.

### 5.1 척도·항목

1) 화자 유사도 (기준 참조 클립 제공, 1~5)
   - 5 동일인 확신 / 4 매우 유사 / 3 유사하나 차이 감지 / 2 다른 느낌 강함 / 1 다른 사람
2) 한국어 자연스러움 (MOS, 1~5)
   - 5 사람과 구분 불가 / 4 자연 / 3 약간 어색 / 2 어색·기계적 / 1 매우 부자연·발음오류
   - 하위 체크(참고용, 점수와 별도 태그): 발음오류·끊김·잡음·억양붕괴
3) 감정 전달력 (2단계)
   - (a) 강제 선택: 무라벨로 들려주고 {기쁨/슬픔/화남/차분함/모르겠음} 택1 → **정답률**
   - (b) 강도: 의도 감정이 얼마나 강한가 1(안 느껴짐)~5(매우 강함)

### 5.2 절차

- 조건: {감정} × {수단: 참조기반 / 후처리 / 병용} × {파라미터 셀}. 중립(기본) 앵커 반드시 포함.
- **블라인드**: 평가자는 어떤 조건인지 모른다. 파일명 익명화, 재생 순서 무작위.
- **동일 문장**을 모든 조건에서 사용(문장 내용이 감정 판단에 힌트 주지 않도록 감정 중립 대사 권장).
- 평가자 3인 이상, 각 조건 반복 2회 이상(재현성). 이어폰 통일 권장.
- 유사도 문항에는 항상 **원 화자 기준 클립**을 나란히 제공.
- 기록: (조건ID, 평가자, 시도, 유사도, 자연스러움, 감정정답여부, 감정강도, 자유메모).
- 집계: 축별 평균±표준편차 + 감정 정답률(혼동행렬). **유사도 하락 없이 감정 정답률·강도가
  오르는 조합**을 채택 후보로.

### 5.3 합격선(초안, 확정 아님)
- 유사도: 중립 대비 평균 하락 **-0.3 이내**.
- 자연스러움: MOS **3.5 이상**.
- 감정 전달: 강제선택 정답률 **60% 이상** 또는 강도 중립 대비 유의 상승.

---

## 6. 실시간 슬라이더 가능 항목 vs 재합성 필요 항목

판정 기준: 생성된 wav에 대한 신호 후처리로 되면 "실시간(재합성 불필요)",
모델 입력/조건이 바뀌면 "재합성 필요".

### 6.1 실시간(슬라이더로 즉시, 모델 재실행 불필요) — 생성 wav 후처리
- **speed** (ffmpeg `atempo`, 피치 불변) — 이미 후처리로 구현됨.
- **pause / silence_gap** (문장 간 무음 재조립) — 이미 후처리. 문장 내 pause는 세그먼트 경계가
  있어야 하므로 부분적.
- **pitch shift** (포먼트 보존 권장) — 미구현. wav 후처리로 실시간 가능(에이전트 A 백엔드 영역).
- **energy / gain / 라우드니스 정규화 / 경량 컴프레션** — 미구현. wav 후처리로 실시간 가능.
- 주의: 이들은 **원본 raw 세그먼트를 보관**해야 "슬라이더로 되돌리기"가 무손실. 현재는 결합 후
  중간 세그먼트를 삭제하므로, 실시간 재적용을 하려면 raw 보관 정책(개념)만 A와 합의 필요
  (스키마 변경 아님).

### 6.2 재합성 필요(모델 재실행) — 모델 입력/조건 변경
- **참조 음성 변경**(감정별 reference 교체) — 재합성.
- **ref_text / x_vector_only(ICL↔x-vector) 모드 변경** — 재합성.
- **language 변경** — 재합성.
- **샘플링(temperature / top_p / top_k / repetition_penalty / subtalker_*)** — 재합성
  (현재 bridge는 아예 안 넘김 → 노출하려면 bridge에 인자 전달 개방 필요, 이는 코드 변경이라
  본 연구 범위 밖·A/B 구현 몫).
- **max_new_tokens / seed** — 재합성(참고: 현재 메타에 `seed_supported=False`).

요약: **"소리를 다듬는" 축(pitch/speed/energy/pause)은 실시간, "무엇을 생성할지"를 바꾸는 축
(참조/전사/모드/샘플링/언어)은 재합성.**

---

## 7. A(pitch backend) · B(emotion UX)가 공유할 공통 "개념" 제안

> 주의: 아래는 **개념 제안일 뿐** 스키마 파일(ttsConfig 등)을 수정/정의하지 않는다.
> 실제 필드·타입 확정은 A/B가 각자 스키마 담당과 합의해 진행.

1. **제어 축의 2계층 분리(공통 어휘)**
   - "생성 축(generation)": 참조·ref_text·x_vector 모드·언어·샘플링 → **재합성**.
   - "후처리 축(post)": pitch·speed·energy·pause → **실시간**.
   - A/B가 UI/백엔드에서 같은 분류를 쓰면 "이 슬라이더가 재합성인가?"를 일관되게 표시 가능.

2. **감정 프리셋의 개념적 형태(placeholder)**
   - 하나의 감정 = { 선택적 참조(reference), 후처리 값들(pitch_semitones, speed, pause_scale,
     energy_db) }의 묶음. B는 이 묶음을 UI 프리셋으로, A는 후처리 값 4종을 백엔드 입력으로 소비.
   - 값 범위는 §4 표를 초기값으로, §5 평가로 조정.

3. **포먼트 보존 플래그(개념)**
   - pitch 후처리는 formant-preserving 여부가 유사도에 결정적. A 백엔드가 이 옵션을 갖고,
     B는 "자연스러움 우선/변화 우선" 정도의 사용자 언어로 노출.

4. **유사도 가드레일(공통 상수 개념)**
   - pitch 절대 상한(예 ±3 반음), pitch+speed 동시 상한 규칙. A가 클램프, B가 슬라이더 범위로 반영.

5. **raw 세그먼트 보관 정책(개념)**
   - 실시간 재적용(6.1)을 진짜 실시간으로 하려면 raw 세그먼트 보관이 필요. A/B가 "후처리는
     결합 전 raw에 적용, 결과만 교체"라는 파이프라인 개념을 공유.

6. **Base 한계 명시(제품 언어)**
   - "텍스트로 감정 지시"는 현 Base로 불가(§2). B의 UX 문구는 감정을 "참조+후처리로 근사"한다는
     사실을 아티스트가 이해할 평이한 말로 전달(과장 금지). "AI가 문장 뜻을 읽고 감정 연기"처럼
     오해를 부르는 표현은 피한다.

---

## 부록 A. 실측 근거 파일(경로)

- `python/tts_worker.py` — 엔진 추상화, Qwen 배치 경로(`_synthesize_qwen_job`), speed/pause 후처리
  (`_atempo_segment`, `_concat_with_silence`), 감정 참조(`ref_cache`), 메타데이터.
- `python/qwen_bridge.py` — `generate_voice_clone` 실제 호출(샘플링 인자 미전달, raw 저장).
- `externals/qwen3_tts_hf/.../snapshots/5d839924.../config.json`,`generation_config.json` — 모델 타입·기본 샘플링.
- `externals/qwen3_tts_venv/Lib/site-packages/qwen_tts/inference/qwen3_tts_model.py` —
  `generate_voice_clone` / `create_voice_clone_prompt` 서명·Base 전용 가드·`_merge_generate_kwargs`.

## 부록 B. 웹 근거 URL

- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base
- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/discussions/38
- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign
- https://github.com/QwenLM/Qwen3-TTS
