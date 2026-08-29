# AudioForge 참조 혼입 조사 — 재개 지점

작성 시각: 2026-08-28 (토큰 리셋 대비)

## 지금 무엇을 하고 있나
참조 음성의 **마지막 대사가 생성 음성 시작에 혼입**되는 원인을 확정하는 것이 유일한 게이트.
사용자가 직접 들어 확정했고, 자동 ASR 의 contamination_detected=false 는 false negative 로 판정됨.

## 브랜치 상태 (전부 로컬, push 0)
- feature/tts-reference-leakage-fix  (worktree: AudioForge_af_worktrees/leak)     ← A, 유일한 게이트
- feature/tts-boundary-envelope      (worktree: AudioForge_af_worktrees/boundary-env) ← B, 병합 보류
- feature/tts-emotion-acoustic-strategy (worktree: AudioForge_af_worktrees/emotion-strategy) ← C, 완료·병합 보류
  커밋 aaee41b / 8f00106 / 47c2891. tsc 양쪽 tsconfig 오류 0 확인 완료.
- base 는 전부 7c8d363 (feature/audioforge-expression-longform-integration)
- develop 734dd00 / master ca42b0e 불변. 통합 브랜치는 아직 만들지 않음.

## 절대 하지 말 것
- B(fade/S-curve)·C(capability audit) 를 통합 브랜치에 병합 — A 확정 전 금지
- 통합 브랜치·develop·master 변경
- vendor 코드(qwen_tts) 수정
- fade / 앞부분 삭제 / 무음 삽입으로 혼입 은폐
- 기존 산출물·로그 삭제·덮어쓰기
- 원인 계측 / 원인 수정 / 청취 보정을 한 커밋에 섞기

## 확정된 실험 4개 (늘리지 말 것)
1. 새 프로세스 → 마커 A 참조 생성 → 프로세스 종료
2. 새 프로세스 → 마커 B 참조 생성 → 프로세스 종료
3. 새 프로세스 → 마커 A 생성 → 같은 프로세스에서 마커 B 연속 생성 → 종료
4. 새 프로세스 → 마커 B 단독 생성 → 프로세스 종료
fresh 조건마다 OS 프로세스를 완전히 종료 후 재시작. 같은 GPU 예약 시간 안에서는 가능.
고정 seed 는 선행조건 아님 — 마커 ASR·토큰 비교·fresh/sequential 비교로 먼저 판정.

## 각 실험에서 보존할 것
참조 전처리 직후 PCM / 모델 입력 prompt token / model.generate 전체 반환 토큰 /
prompt slicing 이후 토큰 / 보코더 직후 PCM / 후처리 직후 PCM / 최종 WAV /
생성 시작 2초 ASR / codec token 유사도 / 각 단계 샘플 수·토큰 수·해시 /
prompt 길이·전체 반환 길이·실제 slice index / BOS·EOS·codec hop·frame / GPU 상태

## 판정 기준
- 전체 반환에만 있고 post-slice 에 없음 → 정상적인 prompt 포함
- post-slice 시작에도 있음 → slicing 또는 모델 생성 문제
- 원시 토큰부터 마커 생성 → conditioning 문제
- 토큰 정상인데 보코더 PCM 부터 → 디코더·보코더 상태 문제
- 보코더 정상인데 후처리 PCM 부터 → 후처리 버퍼 문제
- 최종 PCM 정상인데 파일에만 → 파일 쓰기·재사용 문제
- 연속 생성에서만 → 캐시·스트리밍·상태 잔류
- 마커 A/B 바꿀 때 혼입 대사도 바뀜 → 참조 tail conditioning 확정

## GPU 게이트
실행 직전 10초 간격 한 쌍. free ≥8GB, 평균 util ≤5%, 개별 최대 ≤10%, 외부 compute 없음.
미충족 시 반복 측정 금지·보고만. 자동 재시도·CPU fallback·timeout/상한 변경 금지.

## 보존 산출물 (삭제 금지)
- E:\AudioForge_output\expressive-comparison\20260827-A1\        (첫 단일 생성 + 참조 클립·전사)
- E:\AudioForge_output\expressive-comparison\20260827-A2-emotion3\ (감정 3종 before + 로그·manifest·analysis)
  before 청취본: happy_preview.wav / angry_preview.wav / sad_preview.wav
- 참조 원본(읽기 전용): E:\AudioForge_output\버킷리스트\vocals.wav (sha8 b0927d4a)
  구간 14.0~23.0초, 파생 클립 sha8 3759d489, 전사 63자 sha8 6a3b9cd8

## instruct_ids 현재 사실 (4단계 분리)
- API 인자 수용: 코드 경로상 자리 있음 (배선 추적일 뿐)
- 유효 값 생성: 미확인
- 모델 전달(accepted): 미확인 — 런타임 관측 0회
- 실제 반영(honored): vendor 가 tts_model_size "0b6" 에서 instruct 미지원 선언, 관측 0회

## 미해결·미지원
- 참조 혼입 원인 (최우선)
- 웃음·강한 비언어: LAUGH_NO_STRATEGY 유지
- 동일 참조에서의 감정 분화: 통로 없음
- 280s/300s 여유 20초 문제 (develop 병합 전 해결 대상, 전역 상수 단순 상향 금지)
- 사용자 청취 전 develop 병합 금지

## 브랜치 조상 관계 (확인만 함 — rebase·merge 하지 않았다)
- `git merge-base 7c8d363 734dd00` = **734dd00** (develop 자신)
- develop 734dd00 은 7c8d363 의 **직계 조상이다** (`--is-ancestor` YES)
- 역방향은 아니다 (7c8d363 은 develop 의 조상이 아니다)
- `rev-list --left-right --count 7c8d363...734dd00` = **136  0**
  → 7c8d363 이 develop 보다 136 커밋 앞서 있고, develop 에만 있는 커밋은 0 개다.
- 즉 develop 은 7c8d363 에 fast-forward 로 포함된다. 나중 병합 시 분기 충돌 요인은 없다.
- A 가 끝나기 전에는 브랜치 구조를 바꾸지 않는다.
