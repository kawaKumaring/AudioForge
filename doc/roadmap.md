# AudioForge 제품 로드맵

> 기준일: 2026-08-30  
> 기준선: `master@fa0e907`  
> 개발선: `develop@4b64947` 이후  
> 이 문서는 방향, 순서, 완료 조건을 기록한다. 실제 완료 여부는 커밋, 회귀 테스트, 실작업 검증과 사용자 청취 결과로만 확정한다.

## 현재 기준선

### 음성 합성

- `high_quality_icl`의 기본 경로는 Qwen vendor native ICL이다.
- vendor가 참조 codec 구간을 내부에서 제거하며 AudioForge의 외부 ASR reference trim은 실행하지 않는다.
- ASR alignment record와 vendor crop record는 별도 권위로 관리하며 두 기록이 동시에 존재하면 실패한다.
- legacy controlled-prefix는 `AUDIOFORGE_LEGACY_CONTROLLED_PREFIX=1` opt-in rollback 경로로만 보존한다.
- `auto`는 vendor crop record가 유효하지 않을 때 `safe_xvector`로 최대 한 번 전환한다.
- 명시적 `high_quality_icl`은 같은 상황에서 fail-closed한다.

### 검증된 기준

- Python 회귀 2,084건, npm 914건, TypeScript node/web, build가 통과했다.
- production 기본값과 진단 환경변수 0개로 vendor native ICL 결과가 발행되는 GPU smoke를 통과했다.
- 동일 대본 비교 청취에서 vendor native ICL은 첫말과 참조 제거가 온전했고, 호흡·강약·연속성이 controlled-prefix보다 자연스럽다는 사용자 판정을 받았다.
- 한 실행의 중간 소음은 같은 입력·참조 재실행에서 재현되지 않았다. 상태는 `STOCHASTIC_GENERATION_ARTIFACT_NOT_REPRODUCED`이며 자동 noise detector를 만들 근거가 아니다.
- separator, HNR, CPP, ZCR, 고역 비중으로 참조/목표 경계를 판정하는 연구는 production 방향에서 종료한다. 정상 마찰음과 잡음을 안정적으로 구분하지 못했다.

### 브랜치 운영

- `master`는 검증된 완성품 기준선이며 테스트·수정·GPU 실행 공간이 아니다.
- 구현, 회귀, build, GPU와 청취 검증은 `develop`에서 수행한다.
- 검증된 정확한 candidate SHA만 별도 승인 후 `master`에 병합한다.
- 정기적인 back-merge와 영구 QA worktree는 사용하지 않는다.
- installer, 패키징, 대규모 릴리스 또는 캐시·미추적 의존이 의심될 때만 exact SHA의 일회성 detached worktree를 검토한다.

## 개발 원칙

- 안정성 > 실용성 > 성능 > 코드 미학 순으로 판단한다.
- 외부 음성 API에 의존하지 않고 로컬 처리를 우선한다.
- 사용자 미디어, 전사, 절대경로와 private JSON은 Git이나 일반 로그에 남기지 않는다.
- 자동 지표는 보조 근거다. 자연스러움·감정·발음·소음의 최종 품질 권위는 사용자 청취다.
- 하나의 실험에서 분할, 생성 상한, sampling, gap, envelope처럼 여러 독립 변수를 동시에 바꾸지 않는다.
- 실패·부분 생성도 원인을 조사할 수 있게 진단 영역에 보존하되 정상 결과처럼 발행하지 않는다.
- capability가 실증되지 않은 감정, formant, 가성, breathiness, 환경음 기능을 지원됨으로 표시하지 않는다.

## 즉시 진행할 기반 작업

### 0. 종료된 진단 코드 정리

`tmp_leak_analysis/`는 `REMOVE_OBSOLETE`로 분류한다.

- production·test import 0, build·package 포함 0이며 회귀 fixture가 아니다.
- controlled-prefix 혼입 조사 체크포인트였고 vendor native ICL 전환으로 현행 경로의 역할이 끝났다.
- 제거 전 스크립트와 manifest를 `_local` recovery에 SHA-256 manifest와 함께 보존한다.
- 15건 누수분석 archive의 case ID, 핵심 측정값, 연결 SHA와 vendor crop 결과가 사후 확인 가능한지 먼저 검증한다.
- `doc/work-in-progress/leak-artifacts-manifest.json`은 현행 tree에서 임시 산출물 목록으로 오해되지 않도록 스크립트와 함께 정리한다.
- 정리는 production 변경과 분리된 develop 전용 커밋으로 수행한다.

### 1. Run bundle과 계측 계약

장문·감정 GPU 검증보다 먼저 재현 가능한 실행 기록을 만든다.

- 작업 대본의 원문·정규화 SHA, 문자 수, production/combined token 수
- segment, paragraph, chunk, model call의 전역·지역 좌표
- raw/aligned/final 또는 vendor native 반환 PCM의 길이와 SHA
- vendor crop record, 외부 alignment 호출 여부, fallback과 termination reason
- generation limit, generated iterations, elapsed와 부분 생성 상태
- 실패와 cooperative stop 결과도 같은 run-id 아래 보존
- private/non-private JSON 분리와 export allowlist
- temp write → SHA 재검증 → atomic rename → manifest 최종 발행
- manifest 존재를 번들 완결 신호로 사용하고 불완전 번들은 `INCOMPLETE`로 판정

### 2. 장문 동적 예산

기존 semantic splitter는 재사용하되 분할 예산과 생성 예산을 하나의 계약으로 묶는다.

- 고정 `33 production token`과 `256 frame`을 독립 기준으로 사용하지 않는다.
- `budget_for(text)`가 production tokens, combined prompt, 참조 조건, 예상 frame, reserve, architecture headroom과 generation limit을 함께 계산한다.
- splitter의 최대 묶음은 `budget_for`의 `fits`를 만족하는 범위에서 결정한다.
- 문장 → 절 → 공백 → 문자 순으로 내려가고 임의 문자 절단은 최후 수단이다.
- 입력 보존(`"".join(chunks) == source`)과 estimator의 planned calls가 실제 호출 수와 같음을 테스트한다.
- EOS 미도달, 반복·늘어짐, OOM, 취소와 부분 파형 보존을 서로 다른 종료 상태로 기록한다.
- 단일 호출이 길수록 좋아진다는 청취 결과를 반영하되 모델의 자연 종료 능력을 넘겨 강제하지 않는다.

### 3. 입력 분석, 줄바꿈과 예상 시간

- 줄바꿈이 없으면 안전 예산 안에서 하나의 장문 블록으로 분석한다.
- Enter 줄바꿈은 사용자가 지정한 문단 경계이며 문단별 호출 계획의 우선 단위로 사용한다.
- 문단이 안전 예산을 넘을 때만 문장·절 단위로 내려간다.
- 입력 전체와 문단별 문자 수, production tokens, 예상 호출 수, 예상 생성 시간 범위를 표시한다.
- 시간은 단일값이 아니라 범위로 표시하며 `measured`, `extrapolated`, `insufficient_data`를 구분한다.
- 모델·conditioning mode별 통제 표본이 없으면 시간을 지어내지 않는다.
- 사용자가 입력하는 동안 분석 실패가 생겨도 합성 자체를 막지 않는 fail-open UX로 설계한다.

### 4. 장문 검증 기준

두 승인 대본의 역할을 섞지 않는다.

- `sample_4`: 3,235자, 18문단. 최대 길이, EOS, 반복, 누락과 시간 외삽의 일반 장문 기준이다.
- `APPROVED_GOBACK_LONGFORM_SCRIPT`: 1,464자, 한 문단, SHA-256 prefix `90007c74269d753c`. 감정·호흡·속도·음량·톤 연속성 기준이다.
- 임의 시나리오를 새로 만들어 길이·정렬·감정 변수를 섞지 않는다.
- goback은 run bundle과 동적 예산이 준비된 뒤 vendor native ICL로 실행한다.
- ASR coverage, leading deletion, EOS, 음량/F0 변화는 보조 측정이고 장문 품질 PASS는 청취 전 선언하지 않는다.

## 제품 기능 로드맵

### 5. TTS 감정·표현 UX 완결

- 감정 태그, 명시적 쉼, 줄·문단 경계와 자동분할의 TS/Python parser parity
- caret, IME, selection, scroll을 보존하는 장문 대사 편집기
- 감정별 참조, pitch, 속도, 간격, 말끝 처리와 끝 여백 설정
- 세션 복원, 재현 metadata, 구조화 오류, 수동 재시도와 완결된 취소 수명
- 작은 창, 화면 배율, 키보드, 접근성 GPU-free Electron E2E
- 최소 실제 Qwen 종단 검증

#### 장면 프리셋

실제로 동작하는 pitch, 속도, 문장 간격, 말끝 처리와 감정 전환 설정만 묶어 저장한다. 적용 전 변경값과 되돌리기를 제공하며 사용자의 세부 값을 조용히 덮어쓰지 않는다.

#### 읽기 전용 연기 타임라인

parser plan을 사용해 감정 구간, 명시적 쉼, 줄·문단 경계, 자동분할 위치와 참조 음성을 시각화한다. 1차는 읽기 전용이며 구간 클릭으로 원문 위치를 찾는다. 색 그라데이션은 감정 혼합이 아니라 전환 표시다.

#### 참조 음성 품질 도우미

승인된 로컬 파일에 한해 길이, 무음 비율, clipping, RMS와 끝 절단 위험을 안내한다. 절대 합격 점수가 아니라 위험 신호로 표현하고 ASR 정합은 오탐 가능성이 있으므로 별도 단계로 둔다.

#### 감정 샘플 보드와 보이스 프로필 오디션

- 사용자가 고른 핵심 감정만 순차 생성하고 GPU 병렬 생성은 하지 않는다.
- 동일 대사 비교와 감정별 예문 비교를 분리한다.
- 기본·감정 참조 fingerprint, 모델 revision, 대본·설정·parser version을 캐시 키로 사용한다.
- 참조가 변경·만료되면 영향받은 감정만 stale 처리한다.
- 완료된 결과만 공개하고 자동 감정 점수로 합격을 선언하지 않는다.
- 장문 안의 감정 변화가 화자 정체성 대신 단순 gain 변화로 나타나는지 별도로 검증한다.

### 6. 전체 모드 신뢰성과 텍스트 분할

TTS에서 검증한 작업 수명과 텍스트 계획을 음악 분리, 대화 분리, 텍스트 추출과 번역에 확장한다.

- 작업 ID, 단계 상태와 terminal signal 권위
- 자식 프로세스 트리 취소와 종료 확인
- 입력 fingerprint와 stale 결과 차단
- 임시폴더 소유권, pending 검증과 원자 publish
- 복수 출력의 전부 성공 또는 전부 미공개 정책
- WAV, 텍스트, SRT, JSON의 재현 metadata
- 음악 가사와 대화 전사의 문장·문단·타임라인 분할 계약 감사
- 번역 청크가 원문 순서, 화자, 시간축과 1:1 대응하는지 검증
- `trackRunner` fire-and-forget 종료와 모드별 GPU 정책 정리

### 7. 비교, 발음과 선택 구간 재합성

#### A/B 연기 비교

같은 구간을 두 설정으로 생성해 동일 위치에서 비교한다. 결정적인 후처리 축을 먼저 다루며 sampling 비결정성을 설정 효과로 오인하지 않게 한다.

#### 프로젝트별 발음 사전

인명, 외래어, 약어, 숫자와 단위의 표시 원문과 합성용 읽기를 분리한다. 엔진별 지원 범위를 구분하고 적용 위치와 규칙 ID만 metadata에 기록한다.

#### 선택 구간 재합성

- 안정된 segment ID와 render manifest를 선행 조건으로 한다.
- 줄 또는 parser segment 단위로만 재생성한다.
- 감정 경계와 쉼을 포함해 결정적으로 다시 조립한다.
- 새 결과 검증 후 원자 교체하고 이전 결과를 보존한다.
- 최종 WAV 일부를 직접 잘라 덮어쓰는 방식은 사용하지 않는다.

### 8. 음성 대사의 언어 변환

`ASR → 문맥 번역 → 화자·감정 유지 TTS`를 하나의 재현 가능한 작업으로 구성한다.

- 대화의 화자별 원문, 번역과 합성 음성을 안정된 ID로 연결한다.
- 문장·타임라인 대응, 누락·중복·순서 변경을 검사한다.
- Whisper, NLLB, 로컬 LLM과 Qwen TTS의 역할과 실패를 분리 기록한다.
- 목표 언어의 발음과 고유명사 읽기를 발음 사전과 연결한다.
- 원본 시간축 유지와 자연스러운 재타이밍을 별도 모드로 구분한다.
- 외부 API 없이 로컬 우선으로 구현하고 모델별 라이선스를 기록한다.

### 9. 상위 음성 모델 성능 비교

현재 vendor native ICL을 고정 대조군으로 사용한다.

- 더 큰 모델이나 새 revision은 동일 대본, 동일 참조, 동일 하드웨어로 비교한다.
- 첫말·참조 누수, 발음, 음색, 감정, 호흡, 장문 EOS, 반복, 처리 시간과 VRAM을 측정한다.
- 짧은 문장과 장문, 단일 감정과 감정 전환을 분리한다.
- 신규 모델이라는 이유만으로 production 기본값을 바꾸지 않는다.
- 공개 코드, 가중치, 데이터, 산출물 라이선스와 재현 가능성을 별도로 기록한다.

### 10. 비언어 표현

`[웃음 0.8]`, `[한숨]`, `[숨 0.3]` 같은 명시적 event를 parser plan에 추가한다.

- 1차는 사용자가 등록한 동일 화자의 검증된 웃음·호흡 클립을 삽입한다.
- sample rate, 채널, 길이와 fade를 검증하고 asset의 출처와 수명을 session에 기록한다.
- `ㅎㅎㅎ` 같은 자동 해석은 선택 기능이며 명시적 태그를 권위 문법으로 둔다.
- Qwen Base가 텍스트만으로 자연스러운 비언어 표현을 항상 만든다고 가정하지 않는다.

### 11. 가창 모드

말하기 TTS와 분리된 모드로 구현한다. 상세 계획은 [가창 모드 계획](future-svc.md)을 따른다.

1. 가이드 노래 기반 SVC: 원곡의 음정·리듬을 유지하며 목표 음색으로 변환
2. MIDI/MusicXML 기반 가창 합성: 음표·박자·가사 정렬로 특정 목소리가 새로 노래하게 생성
3. 후속 연구: 가사만으로 멜로디와 가창까지 만드는 text-to-song

Demucs/RoFormer 보컬 분리, 가사 전사·번역, phoneme timing, pitch curve, vibrato와 breath 모델을 독립 계약으로 둔다. SVC 성공을 새 가창 생성 성공으로 표현하지 않는다.

### 12. 상황 기반 호흡·환경음

상세 계획은 [상황 기반 호흡·환경음 계획](future-ambient-audio.md)을 따른다.

예: “운동선수가 달리며 말하고 주변에는 폭포와 숲의 새가 있다.”

1. 로컬 상황 분석 AI가 대사와 상황을 음향 타임라인으로 변환한다.
2. TTS는 감정·속도·숨찬 발화를 생성한다.
3. 호흡 엔진은 들숨·날숨·헐떡임·한숨을 별도 stem으로 생성하거나 검증된 자산을 선택한다.
4. 환경음 엔진은 폭포·새·바람·발소리와 옷 마찰을 별도 stem으로 만든다.
5. 믹서는 거리, 공간감, 음량, 스테레오 위치와 ducking을 적용한다.

- 음성, 호흡, 환경음과 효과음을 한 파형으로 직접 생성하지 않는다.
- 환경음이 화자 복제용 참조에 섞이지 않게 격리한다.
- 각 stem을 보존해 사용자가 교체·감쇠·삭제할 수 있게 한다.
- 사용자 승인 없이 대본 분석 뒤 자동 GPU 생성이나 대량 다운로드를 시작하지 않는다.
- 모델은 비교 검증 후 선택하며 현재 특정 모델을 production 계약으로 확정하지 않는다.

## 연구와 결정 기록

- 감정 음성 기술은 작동 원리, 품질 기여, 공개 근거, 재현성, AudioForge 적용 등급, 검증법과 라이선스로 정리한다.
- 공개·폐쇄·대형·클라우드 기술도 원리를 배울 수 있다면 조사하되 공개되지 않은 내부 구조를 사실처럼 추정하지 않는다.
- formant, 가성, breathiness는 실제 알고리즘과 청취 검증 전 UI에 노출하지 않는다.
- 감정 smooth transition은 색상 시각화와 실제 음향 전환을 구분한다.
- 빠른 재처리는 raw/base 결과 보존과 후처리 순서 계약이 확정된 뒤 구현한다.
- 기술 근거는 [기술 레퍼런스 인덱스](references/README.md)에 연결한다.

## 공통 완료 게이트

각 단계는 다음 조건을 만족해야 완료로 표시한다.

- 계약 문서와 실제 구현 대조
- 단위테스트, typecheck와 build 통과
- 관련 GPU-free Electron E2E 통과
- 필요한 경우 승인된 최소 실작업 검증
- 사용자 청취가 필요한 항목은 청취 전 품질 PASS 금지
- 취소 후 자식 프로세스·임시폴더 잔존 0
- 사용자 원본과 기존 결과 불변
- 오류에 미디어 내용, 전사 전문과 전체 사용자 경로 미노출
- `_local`, WAV, private JSON과 절대경로의 Git 추적 0
- develop clean, origin/develop 동기화와 candidate SHA 고정
- master 병합은 별도 승인과 전체 회귀 후 수행

## 단계별 현재 상태

| 단계 | 상태 | 다음 완료 증거 |
|---|---|---|
| vendor native ICL 기준선 | 완료 | `master@fa0e907` |
| 임시 누수 진단 정리 | 결정 완료, 실행 대기 | recovery SHA + develop 정리 커밋 |
| run bundle | 계획 | schema·atomic write·failure bundle 테스트 |
| 장문 동적 예산 | 계획 | `budget_for` 계약과 planner/generator parity |
| goback 장문 | 대기 | run bundle·동적 예산 후 GPU 및 청취 |
| sample_4 스트레스 | 대기 | EOS·반복·부분 결과·시간 기록 |
| 입력/문단 시간 estimator | 계획 | 통제 실측과 신뢰도 표기 |
| 감정 장문·fixture v3 | 계획 | 화자·감정·gain 안정성과 청취 |
| 음악·대화 텍스트 분할 | 계획 | 화자·타임라인·번역 parity |
| 음성 대사 언어 변환 | 연구/설계 | 로컬 종단 prototype |
| 상위 모델 비교 | 연구 | 동일 조건 benchmark |
| 가창 SVC | 상세 계획 존재 | 별도 MVP 승인 |
| MIDI/MusicXML 가창 | 후속 연구 | SVC 이후 |
| 상황 기반 환경음 | 상세 계획 존재 | 장문·감정 안정화 이후 |

