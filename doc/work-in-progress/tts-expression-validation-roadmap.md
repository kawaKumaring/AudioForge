# TTS 표현 음성 검증·재개 로드맵

> 체크포인트 기준: 2026-08-26 긴급 중단 직후
> 목적: 다음 세션이 이미 끝난 일, 미완성 구현, 음향 미검증을 혼동하지 않도록 한다.
> 중요: 브랜치와 프로세스 상태는 재개 시 반드시 Git·OS에서 다시 감사한다.

## 1. 현재 기준선

| 구분 | 체크포인트 상태 |
| --- | --- |
| develop | `734dd00`, origin과 동기 |
| master | `ca42b0e`, 변경 금지 |
| tag | `v1.0.0 @ 810e448`, 변경 금지 |
| 표현 통합 | `feature/expressive-speech-integration @ 38e6072`, origin push, develop 미병합 |
| 사용자 실행 가능 경로 | `AudioForge_af_worktrees/expr-int` |

`38e6072`는 단문·장문 GPU 합성을 실제 완료한 버전이지만 최종판이 아니다. legacy v2 합성은 가능하고, v3 표현 문법·웃음·경계 개선은 완료되지 않았다.

## 2. 기능 상태표

| 영역 | 상태 | 정확한 의미 |
| --- | --- | --- |
| 기존 TTS·감정 참조·자동분할 | 실행 가능 | 단문·장문 합성 성공 |
| 표현 언어 계약 | 구현 완료 | legacy v2와 opt-in v3를 분리하는 계약 존재 |
| 표현 엔진 planner | 구현 완료 | 실제 음향 전략의 품질은 미검증 |
| 참조 라이브러리 | 구현 브랜치 보존 | durable 저장·SHA-256 권위 계약, 통합 여부 재확인 필요 |
| 참조 미리듣기 안정화 | 구현 브랜치 보존 | 버려진 Audio 요소 문제 수정, protocol 누수 수정과 별도 |
| local-file protocol 누수 | 구현·회귀 증명 | wedge 자체는 미재현, 파일 핸들 누수만 확정 |
| 감정 샘플러 | 부분 구현 | 상황 대사·500ms 진단 여백·실측 프로필은 미완 |
| v3 production 배선 | 미완 | 별도 dirty worktree에 미커밋 변경 존재 |
| 장문 운율 연속성 | 실패 판정 | F0 reset·내부 공백·조각별 종결감 남음 |
| 실제 비언어 웃음 | 미구현/미검증 | 기존 결과는 웃음 글자 낭독 |
| 생성 한도 256 | 감사 완료, 변경 보류 | 모델 한도가 아니라 watchdog·월클럭 정책 |
| develop 병합 | 금지 상태 | 품질·회귀·사용자 확인 전 병합하지 않음 |

## 3. 긴급 중단 시 미완성 worktree

### 3.1 `feature/sampler-preview-diagnostics`

- 위치: `AudioForge_af_worktrees/preview`
- base: `38e6072`
- 미커밋 파일: `python/emotion_sampler.py`, 관련 Python 테스트 2개, `src/shared/emotionSampler.ts`
- 의도: 샘플 앞뒤 500ms 진단 여백과 웃음 capability 표시
- 상태: 테스트 전 중단

### 3.2 `feature/expressive-v3-wiring`

- 위치: `AudioForge_af_worktrees/v3wire`
- base: `38e6072`
- 미커밋 파일: `python/separate.py`, `python/tts_parity.py`
- 의도: 명시적인 v3 parser flag를 실제 합성 경로에 전달
- 상태: glue·테스트 전 중단
- 위험도: 가장 높음. parser parity와 기존 v2 합성을 동시에 깨뜨릴 수 있다.

### 3.3 `feature/boundary-prosody-analysis`

- 위치: `AudioForge_af_worktrees/boundary`
- base: `38e6072`
- 미커밋 파일: `python/onset_continuity_metrics.py`
- 의도: 경계 보정 후보와 참조 운율 프로필 확장
- 상태: intonation detector 수정 중 중단

어느 worktree도 자동으로 버리거나 병합하지 않는다. 재개 첫 단계에서 diff를 읽고 의도·테스트 가능성을 확인한 뒤 각각 계속할지 폐기할지 결정한다.

## 4. 재개 순서

### Phase 0 — 안전 감사

1. 모든 worktree의 branch, HEAD, dirty 파일을 다시 기록한다.
2. 체크포인트 당시 남아 있던 `develop-run` Qwen bridge 프로세스가 현재도 존재하는지 확인한다.
3. 다른 GPU 작업과 VRAM을 read-only로 측정한다.
4. 사용자 미디어와 합성 산출물의 원본 해시를 기록한다.
5. 기존 dirty 변경을 reset·stash·checkout하지 않는다.

### Phase 1 — 미완성 세 작업을 독립 완결

권장 순서: preview → v3 wiring → boundary analysis.

각 단계는 다음 조건을 만족해야 다음으로 간다.

- diff가 해당 브랜치의 소유 경계 안에 있음
- 국소 테스트 통과
- 의미를 완화한 테스트 수정 없음
- 신규 커밋 생성(amend 금지)
- 통합 담당 검토 후 push

### Phase 2 — 통합 전 정적·GPU-free 검증

- Python 전체 discovery
- npm test
- tsc node/web
- production build
- parser v2 fixture와 parity hash 불변 확인
- v3 opt-in일 때만 v3 plan이 활성화되는지 확인
- session/config/metadata의 `ttsExpressiveMode` carrier 일치
- 참조 library 재시작 복원·content SHA-256 무효화 계약
- sampler와 engine capability 어휘 parity
- local-file preview 반복·언마운트·취소 회귀

### Phase 3 — 음향 비교 후보 생성

GPU 조건을 충족한 뒤 직렬 실행하고 자동 재시도하지 않는다.

1. 단문 common line: neutral과 감정별 비교
2. 감정별 상황 대사
3. 앞뒤 500ms 진단 무음
4. 장문 neutral/performance 동일 대사
5. 개선 전/후 파일을 blind 이름으로 복사하고 manifest에만 매핑 기록
6. 각 실행의 model/device/reference fingerprint/parser mode/generated iterations/elapsed를 기록

### Phase 4 — 측정과 사용자 청취

최소 합격 조건:

- 경계 sample click이 증가하지 않음
- 자동분할 내부 무음 중앙값과 p90이 기준선보다 감소
- 경계 F0 점프 분포가 개선되고 문장 전체 contour가 더 연속적임
- 화자 유사도와 한국어 자연스러움이 기준선보다 의미 있게 악화되지 않음
- 감정 샘플이 사용자에게 의도 감정으로 구분됨
- 웃음은 글자 낭독이 아니라 비언어 음성으로 들림
- onset과 tail을 500ms 여백에서 사람이 판정 가능

### Phase 5 — integration과 develop 병합

1. 최신 origin/develop에서 전용 통합 브랜치를 만든다.
2. 검증된 feature만 `--no-ff`로 순서대로 병합한다.
3. 충돌은 양쪽 의미와 계약을 확인하고 선보고 후 해결한다.
4. 전체 회귀와 실 앱 smoke를 수행한다.
5. 사용자 청취 승인을 받는다.
6. 승인 후에만 develop에 `--no-ff` 병합·push한다.
7. master와 `v1.0.0`은 별도 릴리스 승인 전까지 변경하지 않는다.

## 5. 생성 한도 결정

현재 `ABS_LIMIT=256`은 모델 최대 능력이 아니라 약 280초 inactivity watchdog 안에서 최악 실행 시간을 제한하는 정책이다. 모델 자체의 token/position 한도와 혼동하지 않는다.

결정지는 다음 세 가지다.

1. 256 유지: 같은 감정의 2~3문장 일괄 생성 목표를 연기한다.
2. 생성 하트비트와 watchdog 계약을 재설계한 뒤 상한을 검토한다.
3. 상한은 유지하고 metadata의 frames/output sample rate를 포함한 실측 분포를 더 모은다.

현재 권장 순서는 3이다. 상한·timeout·자동 재시도를 증거 없이 올리지 않는다.

## 6. 금지 사항

- 미완성 dirty worktree를 reset·stash·강제 삭제하지 않는다.
- 기존 v2 사용자의 대사를 내용만으로 자동 v3 재분류하지 않는다.
- 표현 구문이 있다는 이유로 parser version을 자동 선택하지 않는다.
- 감정 참조와 후처리 효과를 동시에 크게 적용해 원인을 섞지 않는다.
- 웃음 텍스트 낭독을 비언어 웃음 성공으로 보고하지 않는다.
- 전체 F0 범위 하나만으로 자연스러움을 판정하지 않는다.
- 사용자 승인 없이 참조 음원을 다른 파일로 교체하지 않는다.
- 원본·생성 음성·모델·민감 경로를 Git에 추가하지 않는다.
- 검증 전 develop/master에 병합하지 않는다.

## 7. 완료 정의

“코드가 존재함”, “테스트가 통과함”, “실제로 자연스럽게 들림”은 서로 다른 상태다.

- 구현 완료: production 경로에 연결되고 오류 계약과 테스트가 존재한다.
- 기술 검증 완료: 정적·회귀·GPU 실행·정리 무결성이 통과한다.
- 품질 검증 완료: 동일 조건 비교에서 계측과 사용자 청취가 모두 목표를 만족한다.
- 통합 완료: 검증된 tree가 develop에 병합·push된다.
- 릴리스 완료: 별도 승인으로 master/tag에 반영된다.

현재 표현 음성 작업은 일부 구현과 GPU 실행까지 완료했지만, 장문 운율·실제 웃음·v3 배선·감정 프로필 품질 검증이 남아 있어 품질 검증 완료나 develop 통합 완료 상태가 아니다.
