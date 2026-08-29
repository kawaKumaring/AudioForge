# 감정 음성 제품 제어 방식 비교

> 조사 기준일: 2026-08-23  
> 목적: 외부 API 도입이 아니라 AudioForge의 로컬 음성 UX·계약 설계 참고  
> 범위: 공개 공식 문서. 비공개 모델 내부 구조는 추정하지 않는다.

## 결론

상용 감정 음성 제품은 대체로 다음 세 제어 방식을 조합한다.

1. **정해진 style·role**: 지원하는 감정과 강도를 열거형으로 선택한다.
2. **자연어 연출 지시**: 장면, 인물, 분위기, 속도, 말투를 문장으로 지시한다.
3. **인라인 audio tag**: 대사 중간에 감정 전환, 속삭임, 웃음·한숨 같은 사건을 넣는다.

공통적으로 voice·참조 샘플과 대사 내용이 지시와 맞아야 한다. 표현력을 높이면 불안정성도 커질 수 있어 감정 샘플 비교와 사용자 청취가 필요하다.

## 제품별 공개 제어 방식

### ElevenLabs Eleven v3

- `[happy]`, `[sad]`, `[whispers]`, `[laughs]`, `[sighs]` 같은 자연어 audio tag를 대사 안에 배치한다.
- 감정·delivery·pacing·human reaction을 같은 태그 문법으로 다룬다.
- 긴 문맥과 문장 구조가 억양에 영향을 준다.
- 선택한 voice와 clone 샘플의 연기 범위가 tag 반응성에 영향을 준다.
- Stability의 Creative/Natural/Robust 선택은 표현력과 일관성의 절충으로 설명된다.
- 공식 문서도 tag 결과가 voice별로 다르고 실험이 필요하다고 밝힌다.

공식 자료:

- [Audio tags 개요](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-alpha)
- [감정 생성 가이드](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-to-produce-emotions)
- [Eleven v3 prompting](https://elevenlabs.io/docs/best-practices/prompting)
- [Text to Dialogue](https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue)

AudioForge 참고점:

- 감정과 비언어 사건을 parser 단계에서 구분하되 같은 인라인 편집 경험을 제공할 수 있다.
- Qwen Base에서 태그가 직접 instruction으로 작동한다고 가장하면 안 된다. 현재는 감정 참조 라우팅과 등록한 비언어 clip이 권위다.
- 감정 샘플 보드에서 voice·참조별 tag/감정 반응을 실제로 들어보는 흐름이 필요하다.

### Google Gemini TTS

- 자연어로 style, tone, accent, pace를 지시한다.
- Audio Profile, Scene, Director's Notes, Sample Context, Transcript, Audio Tags를 조합하는 감독형 prompt 구조를 공개한다.
- `[excitedly]`, `[bored]`, `[laughs]`, `[sighs]`, `[whispers]`처럼 구간별 태그와 비언어 사건을 지원한다.
- 공식 가이드는 transcript 내용, 화자 profile, 연출 지시의 정합을 강조한다.
- 너무 많은 제약은 창의성과 자연스러움을 떨어뜨릴 수 있다고 안내한다.
- 긴 출력은 품질·일관성이 흔들릴 수 있어 작은 chunk로 나눌 것을 권장한다.

공식 자료:

- [Gemini TTS speech generation](https://ai.google.dev/gemini-api/docs/speech-generation)
- [Google Cloud Gemini-TTS](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts)

AudioForge 참고점:

- 장면 프리셋을 단순 수치 묶음뿐 아니라 `인물 프로필 + 장면 + 연출 메모` 구조로 확장할 수 있다.
- 현재 Qwen Base에는 자연어 연출 능력이 없으므로 UI는 capability에 따라 숨겨야 한다.
- 미래 instruction-capable 로컬 모델을 도입할 때도 대사와 연출 지시의 모순을 preflight 경고로 다룰 수 있다.

### OpenAI gpt-4o-mini-tts

- `instructions`에 자연어로 말투를 지정한다.
- 공식 문서는 accent, emotional range, intonation, impressions, speed, tone, whispering 제어를 열거한다.
- custom voice 자료에서는 샘플의 tone, cadence, energy, pause, accent를 그대로 복제하므로 원하는 연기와 일관된 녹음을 강조한다.

공식 자료:

- [OpenAI Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech)

AudioForge 참고점:

- 화자 identity와 performance direction을 별도 필드로 관리해야 한다.
- 참조 품질 도우미는 잡음뿐 아니라 에너지·말투 일관성도 안내해야 한다.
- AudioForge는 외부 API를 사용하지 않으므로 제품 설계 패턴만 참고한다.

### Microsoft Azure Speech

- SSML `mstts:express-as`로 voice별 style을 선택한다.
- `styledegree`로 style 강도를 조절한다.
- `role`로 나이·성별 역할의 연기를 요청할 수 있다.
- custom voice는 학습 자료에 포함된 preset/custom style을 노출할 수 있다.
- break, prosody, pronunciation, custom lexicon 등 결정적인 문서 제어도 함께 제공한다.

공식 자료:

- [Azure SSML 개요](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup)
- [Voice and sound with SSML](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice)

AudioForge 참고점:

- 모델이 지원하는 감정만 명시적으로 capability 목록에 노출하는 방식은 예측 가능성이 높다.
- `styledegree` 같은 감정 강도 UI는 모델이 실제로 학습·지원할 때만 추가한다. pitch만 바꾸어 감정 강도라고 부르면 안 된다.
- 프로젝트별 발음 사전과 명시적 쉼 문법은 감정 기능과 별도로 유지하는 편이 안전하다.

## 공통 설계 원칙

### 1. 화자와 연기는 다른 축이다

화자 embedding·참조 음성은 목소리 identity를 제공하고, style/instruction/tag는 연기 방향을 제공한다. 한 참조 clip에 identity와 감정이 뒤섞이면 다른 감정으로 일반화하기 어렵다.

### 2. 대사와 지시의 정합이 중요하다

밝은 지시와 슬픈 대사처럼 서로 모순된 입력은 결과의 불안정성을 높인다. 감정별 예문은 실사용성을 보여주지만, 모델의 감정 제어력 비교에는 같은 대사를 써야 한다.

### 3. 비언어 사건은 별도 타입이 필요하다

웃음·한숨·기침은 단순 emotion label이 아니라 시간 길이와 오디오 사건을 가진다. AudioForge parser에서는 `emotion`, `pause`, `nonverbal_event`를 구분하는 편이 재현과 fallback에 유리하다.

### 4. 표현력과 안정성은 절충 관계다

강한 style 지시나 창의적인 sampling은 감정을 키우지만 hallucination·발음 누락·길이 불안정을 늘릴 수 있다. 기본값은 안정적으로 두고, 감정 샘플 보드에서 선택적으로 비교해야 한다.

### 5. 사용자 청취가 최종 권위다

F0, energy, duration, pause 같은 수치는 보조 지표다. 이를 `기쁨 85점`처럼 감정 정답으로 표시하면 안 된다. 동일 대사 A/B와 감정별 실사용 예문을 분리해 제공한다.

## AudioForge 적용 제안

1. 현재 참조 기반 감정 라우팅을 정직한 기본 방식으로 유지한다.
2. `감정 샘플 보드`로 기본·기쁨·슬픔·화남·긴장·차분함 등 선택한 핵심 감정을 순차 생성한다.
3. 비교용 동일 대사와 실사용 감정별 예문을 분리한다.
4. 감정 참조가 없으면 `기본 참조 기반 예상`으로 표시하고 실제 감정 검증 완료로 취급하지 않는다.
5. 비언어 표현은 등록한 동일 화자의 clip 삽입부터 시작한다.
6. instruction-capable 로컬 모델이 검증되면 Audio Profile·Scene·Director's Notes를 capability-gated 고급 기능으로 추가한다.
7. 모든 샘플은 voice/ref/transcript/model/settings fingerprint로 캐시하고 수동 생성·취소·원자 정리를 적용한다.

## 공개 정보로 알 수 없는 것

- 상용 모델의 학습 데이터 구성, 정확한 architecture, loss, preference tuning 절차는 대부분 비공개다.
- 자연스러운 결과가 특정 단일 기술 때문이라고 단정할 수 없다.
- 이 문서는 공개된 입력 제어와 제품 동작을 비교한 것이며 상용 모델 내부 구현의 역공학 결과가 아니다.
