# 한국어 음성 관련 GitHub 저장소 조사

조사일: 2026-08-26

## 1. `jomminii/aws-polly`

원본: [GitHub 저장소](https://github.com/jomminii/aws-polly)

### 확인된 구현

- `[F]` 2023년 말 생성된 작은 Python/Streamlit AWS Polly 클라이언트 예제다. 저장소 자체 TTS 모델이나 학습 코드는 없다.
- `[F]` `boto3.client('polly')`와 `synthesize_speech`를 사용하며 `Engine`, `VoiceId`, `TextType='ssml'`, MP3 출력을 전달한다. [AIVoiceHelper](https://github.com/jomminii/aws-polly/blob/main/helper/ai_voice_helper.py)
- `[F]` 텍스트를 `<prosody rate="...%">`로 감싸 전체 속도를 20–200% 사이에서 조절한다. [음성 생성 UI](https://github.com/jomminii/aws-polly/blob/main/pages/01_AI%20%EC%9D%8C%EC%84%B1%20%EB%A7%8C%EB%93%A4%EA%B8%B0.py)
- `[F]` 언어→엔진→음성→속도 순의 단순한 선택 UI와 즉시 미리듣기·MP3 다운로드를 제공한다.
- `[F]` 라이선스가 저장소 루트에 명시되지 않았다. 코드 복사 대상으로 취급하지 않는다.

### AudioForge에 유용한 부분

- `[R]` SSML 자체가 아니라 **표현 AST→엔진 capability→엔진별 명령**이라는 컴파일 구조를 참고한다. AudioForge의 `!`, `?`, `!?`, dot-run, 웃음 이벤트가 Qwen/GPT-SoVITS/향후 cloud adapter에서 서로 다른 기능으로 내려갈 수 있어야 한다.
- `[R]` 엔진·음성에 따라 지원 기능을 명시하고, 미지원 표현은 조용히 무시하지 말고 `unsupported/degraded`로 표시한다.
- `[R]` 사용량/비용 계측 개념은 향후 선택형 cloud adapter에서만 유효하다.

### 적용하지 않을 부분

- AWS credential 직접 입력·cloud 전송·AWS 종속을 AudioForge 기본 경로에 넣지 않는다.
- 이 예제는 자연스러움을 만드는 모델 기술이 아니라 Polly API를 호출하는 UI다.

## 2. `rtzr/Awesome-Korean-Speech-Recognition`

원본: [GitHub 저장소](https://github.com/rtzr/Awesome-Korean-Speech-Recognition)

### 확인된 내용

- `[F]` 한국어 STT API의 CER(Character Error Rate) 벤치마크다. TTS 생성 모델이 아니다.
- `[F]` AI-Hub 계열 데이터에서 3,000개 발화를 표본으로 사용하고 회의·상담·전화 저품질·강의·KsponSpeech clean/other 등 도메인을 나눈다.
- `[F]` 한국어는 띄어쓰기와 형태소 특성 때문에 WER보다 CER를 중심 지표로 사용한다.
- `[F]` 웃음·잡음 표기, 숫자·영문, 철자/발음 이중 전사처럼 정규화 정책이 결과에 큰 영향을 준다.
- `[F]` 저장소 라이선스는 CC0-1.0이다.

### AudioForge에 유용한 부분

- `[R]` 합성된 한국어를 ASR로 다시 읽어 원문과 CER를 계산하는 회귀 게이트를 추가한다. 이것은 자연스러움 점수가 아니라 **내용 보존·발음 명료도** 지표다.
- `[R]` 문장부호·웃음 이벤트를 제거한 문자 정확도와, 이벤트 자체가 발생했는지를 별도 지표로 분리한다. `[ㅋㅋ]`를 단어 오류로만 처리하면 표현 기능을 잘못 평가한다.
- `[R]` clean/other, 숫자·영문·고유명사, 긴 문장, 감정 전환, 낮은 음량 등 AudioForge용 한국어 fixture 층을 만든다.
- `[R]` 정규화 규칙 버전·ASR 모델 지문·원시 결과를 함께 기록해 지표 드리프트를 막는다.

## 3. `protofu/Seiren`

원본: [GitHub 저장소](https://github.com/protofu/Seiren)

### 확인된 구현

- `[F]` 2023년 프로젝트로, 사용자 목소리 등록·모델 학습·텍스트 합성·미리듣기/다운로드와 음성 모델 스토어를 묶은 서비스다.
- `[F]` 음성 코어는 `SynthesizerTrn`, monotonic alignment, generator/discriminator 학습을 포함한 VITS 계열이며 단일·다중 화자 학습 경로가 있다. [VITS 사용 문서](https://github.com/protofu/Seiren/blob/main/vits/README-ko.md)
- `[F]` 한국어 전처리는 Latin 문자 치환, 한자어/고유어 수사 처리, Hangul 분해, `ko_pron` 기반 IPA 변환을 포함한다. [Korean text processing](https://github.com/protofu/Seiren/blob/main/vits/text/korean.py)
- `[F]` 추론은 checkpoint/config를 불러와 `noise_scale`, `noise_scale_w`, `length_scale`로 VITS를 실행하고 WAV를 생성한다. [Flask inference](https://github.com/protofu/Seiren/blob/main/vits/flask_infer.py)
- `[F]` 학습 문서는 5초 이하의 짧은 데이터 조각, 22.05 kHz 선택, 사전학습 checkpoint, 단일/다중 화자 filelist를 안내한다.
- `[C]` README의 “적은 양의 데이터로 양질의 모델”은 프로젝트 주장으로, 독립 품질 벤치마크가 제시되지는 않는다.
- `[F]` 저장소 루트에는 라이선스가 없지만 `vits/` 하위는 원 VITS 저작권자의 MIT LICENSE를 포함한다. 전체 서비스 코드의 재사용 허가로 확대 해석하지 않는다. [VITS subdirectory license](https://github.com/protofu/Seiren/blob/main/vits/LICENSE)

### AudioForge에 유용한 부분

- `[R]` 한국어 텍스트 정규화(숫자+분류사, Latin, 발음 변환)를 독립·버전된 전처리 계층으로 관리한다. 현재 표현 문법 파서와 음소/G2P는 서로 다른 책임이어야 한다.
- `[R]` 사용자별 음성 자산을 `recorded → validating → training/building → ready → invalidated` 상태로 관리하는 durable library UX를 참고한다.
- `[R]` 모델/참조 음성의 미리듣기, 버전·지문·생성 이력의 자산 수명주기는 현재 reference-library/emotion-sampler 작업과 직접 연결된다.

### 적용하지 않을 부분

- `[R]` VITS 재학습을 현재 zero-shot Qwen 음성복제 경로의 대체물로 바로 넣지 않는다. 학습 시간·데이터·GPU·모델 배포·동의/권리 관리가 다른 제품 범위다.
- `[R]` 오래된 CUDA/PyTorch 고정, hard-coded GPU, GET query에 텍스트를 넣는 Flask API, 음성 모델 판매/결제 구조는 재사용하지 않는다.
- 라이선스가 불분명한 루트 서비스 코드는 복사하지 않는다.

## 4. 조사 결론

세 저장소가 담당하는 층은 서로 다르다.

| 저장소 | 실제 성격 | AudioForge에서 가져올 핵심 |
| --- | --- | --- |
| aws-polly | cloud TTS 호출 UI | capability 기반 표현 컴파일·단순한 선택 흐름 |
| Awesome Korean Speech Recognition | 한국어 STT 평가 | CER·정규화·도메인별 회귀 평가 |
| Seiren | VITS 학습형 음성 서비스 | 한국어 G2P/정규화, 음성 자산 lifecycle |

어느 하나도 Narakeet 샘플의 자연스러움을 그대로 재현하는 공개 레시피는 아니다. 세 기술을 **생성 제어 / 평가 / 자산 관리**로 분리해 조합하는 것이 유효하다.
