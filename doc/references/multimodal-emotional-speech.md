# 멀티모달 생성 모델의 자연 발화·감정 표현 조사

> 조사일: 2026-08-23  
> 범위: 공개된 공식 논문·기술 보고·공식 GitHub·Hugging Face 모델 카드·공식 제품 문서만 사용했다. 사용자 미디어, ComfyUI workflow, prompt 파일은 열지 않았다. 이 문서는 구조 조사이며 특정 모델의 음성 품질을 직접 청취 평가한 결과가 아니다.

### 근거 표기

이 문서는 서로 다른 강도의 근거를 섞지 않기 위해 다음 표기를 사용한다.

- **[공개 사실]** 논문, 공개 코드, 모델 카드에서 구조나 동작을 직접 확인할 수 있음
- **[제품 주장]** 제작사 제품 문서·소개가 주장하지만 독립 재현이나 세부 구현이 공개되지 않음
- **[설계 추론]** 공개 사실을 AudioForge의 UX·데이터 계약에 전용한 제안. 원 모델과 동일한 품질을 보장하지 않음

## 1. 명칭 판정

### LTX

- **[공개 사실]** `LTX-Video`는 원래 영상 latent diffusion 계열 이름이다.
- **[공개 사실]** 현재 오디오와 영상을 함께 생성하는 모델은 **LTX-2** 계열이다. 공식 저장소는 LTX-2를 동기화된 audio-video foundation model로 설명하고, ComfyUI core 통합도 명시한다.
- 따라서 “ComfyUI의 LTX가 말을 자연스럽게 한다”는 관찰은 구 LTX-Video 일반론이 아니라, **LTX-2의 joint audio-video 경로**인지 먼저 확인해야 한다.

### MiniMax

- **[공개 사실] MiniMax H3**는 실제 공개된 33B급 옴니모달 생성 모델이다. 텍스트·이미지·영상·오디오 문맥을 받아 영상과 32 kHz stereo audio를 함께 생성한다.
- **[공개 사실] MiniMax Hailuo 02/2.3**은 영상 제품 계열이며 H3와 같은 이름이 아니다. 공개된 H3 아키텍처를 Hailuo 내부 구조의 증거로 사용하면 안 된다.
- **[공개 사실] MiniMax Speech 02/2.x**는 독립 TTS·voice cloning 제품 계열이다. H3의 장면 대화와 Speech 계열의 음성 합성을 같은 모델로 취급하면 안 된다.
- 결론적으로 사용자가 말한 `MINIMAX H3`는 현재 공식 모델명이 맞다. 다만 “말이 자연스럽다”는 현상이 H3의 native audiovisual audio인지, MiniMax Speech 출력인지, 또는 별도 dubbing 단계인지 실행 경로별로 구분해야 한다.

## 2. LTX-2 구조와 자연스럽게 느껴지는 이유

### 공개 구조

LTX-2는 영상과 오디오를 순차 생성하는 `text → video → audio` 파이프라인이 아니라, 두 latent를 함께 denoise한다.

- modality별 causal VAE: video와 audio를 별도 latent로 압축
- asymmetric dual-stream DiT: video stream 14B, audio stream 5B
- 48개 block에서 각 stream의 self-attention, text cross-attention, 양방향 audio-video cross-attention, FFN 수행
- video에는 3D RoPE, audio에는 1D temporal RoPE
- audio↔video 교환에는 temporal 1D RoPE와 cross-modality AdaLN 사용
- multilingual Gemma 계열 text encoder와 audio/video별 conditioning embedding
- modality-aware classifier-free guidance로 prompt adherence와 modality alignment 조절
- audio latent는 spectrogram으로 decode한 뒤 vocoder가 waveform으로 변환

### 왜 장면 속 말이 자연스럽게 보일 수 있는가

다음은 공개 구조에 근거한 **합리적 추론**이다.

1. 영상의 얼굴·입 움직임과 오디오가 같은 denoising 과정에서 정보를 교환하므로, 립싱크와 발화 timing이 별도 TTS를 사후 부착하는 방식보다 일관될 가능성이 높다.
2. prompt가 말투뿐 아니라 장면, 표정, 동작, 환경음, 음악을 함께 기술하므로, 음성이 장면 정서와 맞을 때 사용자가 감정 표현을 더 강하게 지각할 수 있다.
3. 1D temporal alignment와 양방향 cross-attention은 발화 시작·끝, 입 움직임, Foley 사건을 같은 시간축에 정렬하는 데 유리하다.
4. 음성만 있는 TTS와 달리 배경·공간감·행동음이 함께 생성되므로 전체 장면은 자연스럽게 느껴질 수 있다.

그러나 이것이 곧 **독립 TTS의 운율·화자 유사도·장문 안정성이 더 좋다**는 뜻은 아니다. 영상의 표정과 립싱크가 좋은 것, 대사 timing이 장면과 맞는 것, 음성 자체의 pitch·energy·duration·timbre가 좋은 것은 별도 평가 축이다.

### 공개되지 않았거나 확인할 수 없는 것

- 감정 음성 데이터의 정확한 규모·분포
- 사람 선호 기반 RL 또는 reward model의 구체적 사용 여부
- 감정별 pitch/energy/duration을 명시적으로 예측하는 별도 모듈 존재 여부
- 특정 화자 voice cloning 품질과 장문 TTS 안정성

공식 논문·저장소가 밝히지 않은 항목은 추정으로 채우지 않는다.

## 3. MiniMax H3 구조와 자연스럽게 느껴지는 이유

### 공개 구조

H3-Base는 modality-specific encoder/VAE로 입력을 변환한 뒤 하나의 packed multimodal sequence로 조직한다.

- H3-Encoder: Qwen3-VL-32B pretrained weights를 사용하고 50번째 layer hidden state 제공
- H3-VisualVAE: causal video autoencoder
- H3-AudioVAE: 좌우 채널에 같은 encoder/decoder를 독립 적용, 32 kHz stereo를 채널당 40 Hz latent sequence로 압축
- H3-Omni-Transformer: 33B dense single-stream Transformer
- video/audio latent를 한 Transformer가 함께 예측
- modality-specific 구조는 주로 input/output와 AdaLN branch에 제한
- MM-RoPE로 시간·공간 관계 표현
- FL2VA는 text 및 첫/끝 frame, Ref2VA는 ordered image/video/audio reference를 사용
- 공개 checkpoint는 CFG-distilled weights

H3 전체 제품 품질에는 hosted **H3-Context-IR**도 중요하다. 이것은 자유형 multimodal 입력의 관계, 시간, 참조 역할을 해석해 구조화된 intermediate representation을 만든다. 다단계 hosted model/service라 open-weight release에 포함되지 않았다. 로컬 ComfyUI에서 Base만 실행한 결과와 공식 end-to-end 제품 결과가 같다고 가정하면 안 된다.

### 왜 감정적·자연스럽게 보일 수 있는가

다음은 공개 구조에서 도출한 **추론**이다.

1. 표정·몸짓·대사·환경음이 하나의 packed sequence에서 공동 생성돼 정서적 일관성이 높아질 수 있다.
2. audio reference를 입력할 수 있어 timbre뿐 아니라 delivery의 일부를 조건으로 전달할 수 있다.
3. stereo audio와 scene sound를 영상과 함께 생성하므로, 음성 단독보다 공간·상황 맥락이 풍부하다.
4. Context-IR가 prompt를 관계·시간·대사·참조 역할로 구조화하는 것이 공식 workflow 품질의 중요한 부분으로 보인다.

하지만 H3는 4–15초 audiovisual clip 생성 모델이다. AudioForge의 장문 TTS, 재현 가능한 문장 단위 합성, 정확한 화자 복제의 drop-in backend로 간주할 수 없다. 33B BF16 full model과 Qwen3-VL conditioner의 자원 비용도 desktop TTS와 매우 다르다.

## 4. MiniMax Speech 계열: H3와 분리해야 하는 TTS 구조

MiniMax Speech 기술 보고는 Speech 02 계열의 자연스러운 독립 음성에 더 직접적인 설명을 준다.

- autoregressive Transformer 기반 codec TTS
- transcription 없이 reference audio에서 timbre를 추출하는 learnable speaker encoder
- speaker encoder와 AR Transformer를 공동 학습해 timbre와 content generation이 협력
- speaker representation을 다른 음성 속성과 disentangle하려는 설계
- Flow-VAE로 waveform/audio reconstruction 품질 강화
- 이 분리된 speaker representation 위에 emotion LoRA를 적용할 수 있다고 보고
- 제품 문서는 Speech 02/2.6 계열에 명시적 emotion enum을 제공한다.

AudioForge 관점에서 중요한 차이는 다음과 같다.

- H3/LTX-2: 장면·표정·움직임과 함께 생성되는 **상황 정합성**이 강점
- MiniMax Speech: timbre 분리, codec generation, emotion adapter를 통한 **독립 TTS 품질·화자성**이 강점

MiniMax Speech의 학습 corpus 규모, emotion label 구성, LoRA 학습 recipe와 공개 weight는 기술 보고에서 완전히 공개되지 않았다. 따라서 동일 구조를 그대로 재현할 수 있다고 표현하면 안 된다.

## 5. 영상 품질과 음성 감정 품질을 분리해 평가하는 방법

멀티모달 모델의 sample을 평가할 때 아래 축을 별도로 기록해야 한다.

1. **음성 단독**: 발음, prosody, pitch contour, energy, duration, timbre consistency, 문장 끝, 잡음
2. **시간 동기화**: 입모양, 발화 시작·끝, gesture/scene event와 audio timing
3. **시각 감정**: 표정, gaze, 몸짓, camera framing
4. **장면 음향**: Foley, ambience, music, stereo spatial coherence
5. **통합 인상**: 영상과 소리를 함께 봤을 때의 자연스러움

동일 sample을 (a) audio-only, (b) muted video-only, (c) full audiovisual 세 조건으로 평가하면 “음성 자체가 좋아서”인지 “영상과 동기화돼 좋아 보이는지”를 분리할 수 있다.

## 6. AudioForge에 직접 적용 가능한 요소

여기서 “적용”은 H3/LTX weight나 inference를 TTS에 탑재한다는 뜻이 아니다. **멀티모달 시스템이 명시적으로 표현하는 관계·시간·참조·평가 원리를 AudioForge의 음성 UX와 중간 표현으로 변환**한다는 뜻이다.

### 단기 적용 가능

1. **구조화된 표현 계획(Context IR의 축소형)**
   - 현재 parser plan에 emotion, pause, boundary, speaker/reference, timing intent를 명시한다.
   - 자유형 prompt를 그대로 모델에 던지기보다 deterministic intermediate plan을 먼저 보여주고 검증한다.
   - 이 아이디어는 hosted LLM/API 없이도 규칙 기반으로 구현 가능하다.

2. **감정 샘플 보드**
   - 같은 대사·같은 설정으로 default와 각 emotion reference를 순차 생성한다.
   - 감정 참조 fingerprint, transcript hash, model revision, parser version을 cache key로 사용한다.
   - 사용자의 청취 평가를 권위로 두고 자동 “감정 점수”는 만들지 않는다.

3. **평가 축 분리**
   - 음성 품질, 화자 유사도, 감정 구분성, 문장 끝, transition, timing을 별도 A/B 항목으로 표시한다.
   - waveform/F0/energy는 보조 지표이며 감정 정답 판정으로 사용하지 않는다.

4. **speaker와 style의 분리 강화**
   - 기본 참조(source/timbre)와 감정별 참조(style/delivery)를 UI·session·metadata에서 별도 권위로 유지한다.
   - stale transcript/reference mismatch 차단을 계속 유지한다.

5. **명시적 timing plan**
   - pause, line gap, emotion boundary, nonverbal event를 하나의 시간축으로 정규화한다.
   - 추후 연기 타임라인과 선택 구간 재합성의 기반이 된다.

## 7. 멀티모달 원리를 음성 UX로 전용하는 설계

### 7.1 AV 시간 정합 → 감정 타임라인

- **[공개 사실]** LTX-2는 audio/video stream 사이에 temporal RoPE 기반 양방향 cross-attention을 사용하고, H3는 audio/video latent를 같은 packed sequence에서 예측한다.
- **[설계 추론]** AudioForge는 cross-attention을 구현할 필요가 없다. 대신 합성 전 intermediate plan에 모든 사건의 시간·경계 관계를 명시할 수 있다.

권장 plan 단위:

```text
segment → chunk → event
event = speech | explicit_pause | emotion_transition | breath | laugh | sigh
event fields = source_span, speaker_id, emotion_id, reference_id,
               boundary_policy, expected_order, generated_duration(optional)
```

연기 타임라인은 이 plan을 읽기 전용으로 먼저 표시한다.

- 감정색 구간: 혼합이 아니라 적용 범위
- 그라데이션: 실제 latent blending이 아니라 전환 경계 표시
- pause/nonverbal marker: speech와 별도 event
- autosplit marker: 사용자 의미 경계와 구분
- 결과 duration을 얻은 뒤 예상 위치와 실제 위치를 나란히 표시

장점은 “감정을 만들었다”는 모호한 상태 대신 **어떤 참조가 어느 대사와 경계에 적용됐는지** 검증할 수 있다는 점이다.

### 7.2 facial/gesture conditioning → 전달 의도 레이어

- **[공개 사실]** 멀티모달 모델에서는 표정·행동·장면과 음성이 공동 조건이 된다.
- **[설계 추론]** AudioForge는 영상 조건이 없으므로 facial expression을 흉내 내는 가짜 parameter를 만들면 안 된다. 대신 사용자가 전달 의도를 구조화해 볼 수 있다.

예:

- 감정: 기쁨/슬픔/분노 등 현재 등록 reference
- 강도: 모델이 직접 지원하기 전에는 생성 parameter가 아니라 **청취 평가 label**로만 저장
- delivery note: 빠르게, 머뭇거리며, 속삭이듯 등. Qwen Base에 미지원이면 model input으로 보내지 않고 annotation으로 보존
- gesture/face note: 향후 가창·영상 연계용 annotation. 현재 TTS 결과를 바꾸는 값으로 표시하지 않음

즉 멀티모달 conditioning의 교훈은 slider 수를 늘리는 것이 아니라, **지원되는 생성축과 향후 annotation을 명확히 분리**하는 것이다.

### 7.3 packed single-stream과 dual-stream → 공통 plan, 분리된 renderer

- **[공개 사실]** H3는 packed single-stream, LTX-2는 audio/video asymmetric dual-stream이다.
- **[설계 추론]** 두 구조의 공통점은 modality를 지우는 것이 아니라 각 modality의 representation과 시간축을 보존한 채 교환한다는 점이다.

AudioForge 전용 원칙:

1. 텍스트 원문, 합성 segment, emotion reference, pause/nonverbal event를 한 canonical plan에 묶는다.
2. 그러나 각 항목의 권위와 수명은 분리한다. 원본 참조와 effective clip, UI UTF-16 offset과 Python codepoint offset을 섞지 않는다.
3. Python parser가 합성 권위이며 renderer는 동일 plan의 preview다.
4. result metadata에는 plan hash와 event/chunk 수를 저장하되 대사 전문은 넣지 않는다.

이는 멀티모달 Transformer를 복제하는 것이 아니라 **공통 문맥+분리된 modality contract**를 소프트웨어 구조에 적용하는 것이다.

### 7.4 audio codec/latent 표현 → 재합성 가능한 산출물 manifest

- **[공개 사실]** LTX-2와 H3는 audio VAE latent를 사용하고, MiniMax Speech는 codec 기반 AR generation과 Flow-VAE를 사용한다.
- **[설계 추론]** AudioForge가 codec model을 새로 학습하지 않아도, 음성을 flat final WAV 하나가 아닌 재현 가능한 단위로 관리하는 교훈은 적용할 수 있다.

권장 manifest:

- 각 original segment/chunk WAV의 fingerprint
- 적용된 speaker/emotion reference fingerprint
- parser/plan hash
- speed/pitch/boundary/tail 처리 단계와 순서
- final assembly map
- 원자 publish 상태

이 manifest가 있어야 선택 구간 재합성, A/B 비교, 감정 샘플 캐시가 결과를 조용히 섞지 않고 동작한다.

### 7.5 instruction representation → 감정 샘플 보드

- **[공개 사실]** H3 공식 prompt guide는 subject, speaker `(Sx)`, dialogue `<d>`, audio reference, shot time, soundscape를 별도 역할로 구조화한다. timbre/rhythm/emotion/delivery만 참조할 때 원 reference의 dialogue를 새 결과에 복사하지 말라는 규칙도 명시한다.
- **[설계 추론]** AudioForge 감정 샘플 보드도 “reference의 역할”과 “test dialogue”를 분리해야 한다.

샘플 보드의 두 모드:

1. **동일 대사 비교**: 모든 감정이 같은 test dialogue를 사용. 감정 reference 차이를 비교하기 좋음.
2. **감정별 예문**: 실제 사용 인상 확인. 내용 자체가 감정에 미치는 영향을 분리할 수 없음을 표시.

카드에 표시할 것:

- emotion_id와 reference fingerprint/status
- 동일 대사/개별 예문 모드
- 실제 engine/device/model revision
- parser/plan hash
- 생성 설정과 termination
- 사용자 평가: 구분됨/약함/부자연/참조 교체 필요

자동 생성은 GPU를 예고 없이 점유하므로 기본 금지하고 명시적 `선택 감정 샘플 만들기` 작업으로 둔다. 생성은 직렬이며 취소·원자 저장·캐시 무효화 계약을 따른다.

### 7.6 공동 생성의 sound events → 비언어 이벤트

- **[공개 사실]** LTX-2/H3 prompt representation은 dialogue, physical sound, ambience, music을 구분하고 시간순으로 배치한다.
- **[설계 추론]** AudioForge는 `[웃음]`을 일반 발음 문자열로 모델에 맡기기보다 명시적 event로 처리할 수 있다.

1차 권장 방식:

- `[웃음 0.8]`, `[한숨]`, `[숨 0.3]` 같은 별도 문법
- 등록된 동일 화자의 nonverbal clip을 사용
- speech reference와 nonverbal source를 별도 fingerprint로 관리
- event duration은 허용범위를 검증하고 조용히 clamp하지 않음
- 앞뒤 fade, sample rate/channel validation, atomic assembly 적용
- clip이 없을 때 기본 voice나 문자열 발음으로 조용히 fallback하지 않음

`ㅎㅎㅎ` 반복 횟수를 duration hint로 바꾸는 기능은 opt-in shorthand로만 고려한다. 권위 문법은 명시적 event여야 하며, 사용자 청취 전 “자연스러운 웃음”으로 판정하지 않는다.

### 7.7 AV 공동 리듬 → 가창 연구

- **[공개 사실]** 멀티모달 모델은 speech, singing, music, motion을 같은 시간 표현 안에 기술할 수 있다. 이것은 MIDI-conditioned singing model이라는 뜻은 아니다.
- **[설계 추론]** AudioForge 가창 모드에는 다음 원리가 유용하다.

1. lyric event, note event, breath event를 공통 timeline에 배치
2. MIDI/MusicXML note pitch·duration을 권위로, singer identity/style reference를 별도 조건으로 관리
3. guide-song conversion과 score-based singing synthesis를 다른 pipeline으로 분리
4. audio-only, timing alignment, singer similarity, expression을 따로 평가
5. speech TTS의 pitch 후처리를 singing pitch control로 재사용하지 않음

LTX-2/H3가 노래를 생성할 수 있다는 사실만으로 score adherence·장문 구조·특정 가수 재현을 보장하지 않는다. 가창은 별도 foundation model 후보 조사와 데이터·라이선스 검토가 필요하다.

### 7.8 평가축 전용

멀티모달 시스템에서 얻을 가장 중요한 교훈은 “통합 인상”을 단일 점수로 쓰지 않는 것이다.

| AudioForge 기능 | 자동 검증 | 사용자 청취 권위 |
| --- | --- | --- |
| 감정 타임라인 | plan/offset/reference 일치 | 전환이 자연스러운가 |
| 비언어 이벤트 | 위치·길이·파일 검증 | 웃음/숨이 화자와 장면에 맞는가 |
| 감정 샘플 보드 | 동일 설정·캐시·metadata | 감정이 구분되고 과장되지 않았는가 |
| 말끝/쉼 | fade/padding/boundary 수치 | 호흡·말끝이 자연스러운가 |
| 가창 | MIDI/lyric timing·pitch 오차 | 발성·감정·음악성이 자연스러운가 |

자동 지표(F0, energy, duration, clipping)는 실패 신호와 비교 보조자료다. “기쁨 85점” 같은 감정 정답 점수로 사용하지 않는다.

## 8. 적용 우선순위와 한계

### 지금 구현 가능한 UX/계약

1. 감정 타임라인 읽기 전용 뷰
2. 감정 샘플 보드와 직렬 작업·캐시 계약
3. explicit nonverbal event grammar와 등록 clip manifest 설계
4. 공통 plan/manifest를 이용한 선택 구간 재합성 기반
5. audio-only/blind A/B 평가 UI

### prototype 이후 결정할 것

1. nonverbal clip의 duration 조절 품질
2. 감정 transition의 실제 blending/crossfade
3. local model에서 style embedding 또는 emotion adapter 가능성
4. score-based singing backend

### 전용 불가 또는 비공개

1. H3 Context-IR hosted workflow의 동일 복제
2. LTX-2/H3 joint AV attention을 UI 코드로 흉내 내기
3. MiniMax Speech의 비공개 학습 데이터·emotion LoRA recipe 재현
4. 영상 sample의 표정 품질을 음성 감정 품질의 증거로 사용

### 연구·모델 학습이 필요한 요소

1. learnable speaker encoder를 Qwen Base에 외부 후처리만으로 추가할 수는 없다.
2. emotion LoRA는 감정별 충분한 데이터, 모델 내부 adapter 지점, 평가가 필요하다.
3. audio-video cross-attention이나 packed omni-transformer는 AudioForge UI 기능이 아니라 새 foundation model 학습/통합 문제다.
4. H3 Context-IR의 비공개 hosted pipeline을 동일하게 재현할 수 없다.
5. explicit formant/breathiness/falsetto control은 현재 공개 Qwen Base API에 없는 축이므로 가짜 slider로 노출하면 안 된다.

### 현재 AudioForge에 부적합한 직접 통합

- H3나 LTX-2를 일반 TTS backend로 바로 교체: 자원·출력 단위·재현성·장문 안정성·라이선스가 다르다.
- 영상 sample의 감정이 좋아 보인다는 이유만으로 음성 모델 품질이 우수하다고 결론내리기
- 비공개 MiniMax Speech API 기능을 로컬 구현 가능 기능으로 약속하기
- user media를 자동 업로드하거나 외부 Context-IR/API에 보내기

## 9. 권장 연구 순서

1. 감정 샘플 보드: 동일 대사/감정별 대사 두 모드, 순차 생성, 캐시, 사용자 평가
2. 연기 타임라인: parser plan의 감정·쉼·경계·참조를 시각화
3. 로컬 참조 품질 도우미: 신호 기반 경고부터 시작, 사용자 승인 없는 전사·외부 전송 금지
4. 비언어 표현: 등록된 동일 화자의 웃음·한숨·호흡 clip을 명시적 event로 배치
5. 연구 브랜치에서 style embedding/emotion adapter feasibility 검증
6. 별도 가창/멀티모달 모드는 TTS와 분리해 평가

## 10. 출처

### LTX 공식 자료

- LTX-2 논문: https://arxiv.org/abs/2601.03233
- LTX-2 공식 GitHub: https://github.com/Lightricks/LTX-2
- LTX-2 core architecture 문서: https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-core/README.md
- LTX-Video에서 LTX-2로의 공식 안내: https://github.com/Lightricks/LTX-Video

### MiniMax 공식 자료

- MiniMax H3 공식 Hugging Face 모델 카드: https://huggingface.co/MiniMaxAI/MiniMax-H3
- MiniMax H3 공식 GitHub: https://github.com/MiniMax-AI/MiniMax-H3
- MiniMax H3 공식 base prompt guide: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md
- MiniMax H3 공식 reference prompt guide: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md
- Hugging Face Diffusers H3 구조 문서: https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3
- MiniMax Speech 기술 보고: https://arxiv.org/abs/2505.07916
- MiniMax Speech 02 공식 소개: https://www.minimax.io/news/minimax-speech-02
- MiniMax 모델 목록: https://platform.minimax.io/docs/guides/models-intro
- MiniMax 모델 release notes: https://platform.minimax.io/docs/release-notes/models

## 11. 결론

LTX-2와 MiniMax H3가 자연스럽게 느껴지는 핵심은 단순히 “더 좋은 TTS”라서가 아니라, **영상·표정·행동·환경음·대사를 같은 시간축과 생성 과정에서 결합**하기 때문이다. 반면 MiniMax Speech 계열의 독립 음성 품질은 **AR codec generation, learnable speaker encoder, disentangled timbre representation, Flow-VAE, emotion adapter**가 더 직접적인 설명이다.

AudioForge가 지금 흡수할 수 있는 것은 foundation model 구조 자체가 아니라, 구조화된 표현 계획, 참조와 style의 분리, 감정 샘플 보드, 명시적 timing, 비언어 event, 재합성 manifest, 평가 축 분리다. 이것은 “H3/LTX를 TTS로 탑재”하는 계획이 아니라, 멀티모달 시스템의 **관계 표현과 시간 정합 원리**를 음성 제작 UX로 전용하는 계획이다. 모델 학습이 필요한 speaker encoder·emotion LoRA·joint audiovisual generation은 별도 연구로 남겨야 한다.
