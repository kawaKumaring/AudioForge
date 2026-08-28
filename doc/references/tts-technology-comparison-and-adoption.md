# TTS 기술 비교와 AudioForge 적용 우선순위

조사 기준선: `develop @ 734dd00b05c5f478095738e5e840d3ba8665f008`

범위: 문서·분석만. 이 문서는 production 구현 완료를 뜻하지 않는다.

## 1. 비교

| 축 | Narakeet | AWS Polly 예제 | Korean ASR benchmark | Seiren | 현재 AudioForge |
| --- | --- | --- | --- | --- | --- |
| 생성 위치 | 여러 cloud TTS 통합 | AWS cloud | 생성 없음 | 로컬/서버 VITS 학습·추론 | 로컬 Qwen3/GPT-SoVITS 등 |
| 화자 복제 | 서비스/음성별 상이, 공개 구조 없음 | 예제에는 없음 | 없음 | 사용자별 학습 모델 | 참조 음성 기반 zero-shot |
| 표현 제어 | 음성별 style, emphasis/pitch/speed/pause | SSML prosody rate | 평가 대상 아님 | noise/length scale 중심 | 감정 태그·pitch/speed·tail/boundary |
| 긴 문장 | 긴 작업 API·문단 문맥·fragment | 동기 API 예제 | 긴 발화도 평가 | 학습 문서상 짧은 학습 조각 | 자동분할 후 결합 |
| 평가 | 공개 acoustic benchmark 없음 | 없음 | 한국어 CER·도메인 분리 | README 품질 주장 | 단위/E2E·경계 수치, 청취 미확정 |
| 자산 UX | cloud voice catalogue | voice dictionary | 없음 | 개인 음성·model store | reference library/sampler 진행 중 |

## 2. 현재 문제와 직접 연결되는 기술

### P0 — 측정 계약부터 고정

1. `[R]` **문단/조각 provenance**: 각 합성 조각에 원문 범위, 이전/다음 문맥, engine, voice/reference fingerprint, 시작 sample, 실제 trim/pad를 기록한다.
2. `[R]` **onset continuity metric**: 각 조각 첫 300 ms의 speaker embedding, RMS, F0 중앙값을 조각 안정 구간 및 앞 조각과 비교한다. 사용자가 지적한 “조각마다 첫 음색이 튄다”를 수치화한다.
3. `[R]` **한국어 내용 보존**: 고정 ASR로 재전사한 CER를 측정하되, 숫자·영문·웃음·표현 이벤트 정규화를 버전으로 고정한다.
4. `[R]` **청취 평가 분리**: CER가 좋아도 자연스럽지 않을 수 있으므로 화자 일관성·문맥 연결·감정 블렌딩을 블라인드 청취 항목으로 별도 기록한다.

### P1 — 생성 구조 개선 후보

1. `[R]` **paragraph-first adaptive synthesis**: 모델 상한 안에서는 문장마다 재시작하지 않고 가장 큰 의미 블록을 한 번에 생성한다. punctuation은 context로 유지하고 무조건 chunk split 신호로 쓰지 않는다.
2. `[R]` **continuation/fragment mode**: 자동분할 내부 조각은 새 발화가 아니라 앞 문장의 연속이라는 명시적 상태를 사용한다. 다음 조각에 제한된 이전 텍스트/오디오 문맥을 전달하거나, 지원 모델에서는 continuation 기능을 사용한다.
3. `[R]` **onset context padding + safe trim**: continuation 조각 앞에 문맥을 생성한 뒤 실제 출력 구간만 zero-cross/energy/phoneme-aware 경계에서 채택한다. 단순 고정 ms trim은 초성 손상 위험 때문에 금지한다.
4. `[R]` **global post-pass는 가볍게**: 결합 뒤 loudness·DC·아주 짧은 de-click만 허용한다. 이미 생성된 음색·운율의 들쑥날쑥함을 EQ나 crossfade 하나로 근본 해결할 수는 없다.
5. `[R]` **표현 AST와 capability matrix**: 감정 태그, `!`, `?`, `!?`, dot-run, `~`, 웃음을 parser event로 만들고 엔진별 지원 기능으로 컴파일한다. 미지원은 명시하고 무음 fallback하지 않는다.

### P2 — UX·운영

1. `[R]` **선택 영역 빠른 미리듣기 / 전체 긴 작업 분리**: Narakeet처럼 조정은 짧은 경로, 최종 생성은 긴 job 경로로 분리한다.
2. `[R]` **durable reference/sample cache**: 내용 SHA-256을 권위로 참조 클립과 감정 샘플을 재사용하고, 같은 입력을 다시 분석하지 않는다.
3. `[R]` **voice/engine capability 표시**: 사용자는 “왜 이 표현이 적용되지 않았는지”를 설정 화면에서 바로 알 수 있어야 한다.

## 3. 권장 실험 순서

1. 같은 대사·같은 참조로 `현재 자동분할` baseline을 1회 생성한다.
2. chunk별 onset/안정구간 embedding·RMS·F0와 경계 silence를 기록한다.
3. paragraph-first로 상한까지 조각 수를 줄인 후보를 만든다.
4. 남은 자동분할에만 continuation/문맥 padding 후보를 적용한다.
5. baseline/후보를 loudness matched WAV로 제공하고 사용자 블라인드 청취를 받는다.
6. 내용 CER·generation-limit·GPU 시간·메모리·실패율을 함께 비교한다.
7. 개선이 수치·청취 양쪽에서 확인된 최소 변경만 기본값으로 승격한다.

## 4. 성공 기준 초안

- 기존보다 generation-limit/OOM/timeout이 증가하지 않음
- 한국어 CER 비열화(동일 ASR·동일 정규화)
- chunk 수 감소 또는 continuation 경계에서 onset speaker-distance 감소
- 초성 손실 0, 자동분할 내부 불필요 무음 감소
- clipping 0, terminal/result·cleanup 계약 유지
- 사용자 블라인드 청취에서 화자 일관성과 연결감 개선

정확한 threshold는 현재 AudioForge baseline과 후보를 같은 조건으로 최소 10개 문장군에서 측정한 뒤 고정한다.

## 5. 제외·보류

- Narakeet이나 AWS를 기본 엔진으로 전환하지 않는다. cloud 전송·비용·credential·개인 음성 동의가 별도 계약이다.
- 공개되지 않은 Narakeet 모델 구조를 추측해 구현하지 않는다.
- Seiren 전체 서비스 코드를 복사하지 않는다. VITS 하위 MIT와 루트 서비스의 불명확한 라이선스를 구분한다.
- 단일 Narakeet MP3의 pause·loudness 값을 AudioForge 기본값으로 복사하지 않는다.
- crossfade·fade·noise gate를 청취/수치 근거 없이 전 구간에 적용하지 않는다.

## 6. Claude 구현 담당에게 전달할 최소 작업 단위

1. test-only onset/continuity 계측과 metadata schema
2. 동일 입력 baseline 보고(오디오 동작 변경 없음)
3. paragraph-first split plan 순수 함수 + 기존 parser parity 유지 테스트
4. continuation 후보 1개를 feature flag로 구현
5. 한국어 CER fixture/normalizer 버전 계약
6. GPU 실합성은 사전 게이트 후 baseline/후보 각각 1회, 자동 재시도 없음

각 단위는 별도 feature commit으로 검증하고, 청취 전 기본값 변경·develop 병합은 하지 않는다.
