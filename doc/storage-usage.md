# 저장 공간 사용 현황과 정리 기준 (2026-10-10)

AudioForge 가 디스크를 왜 많이 쓰는지, 무엇이 필요한지, 무엇을 지웠고 무엇을 남겼는지의 기준 문서.
측정 대상: `apps/master/AudioForge`(실제 모델·실행 환경이 있는 곳 — 개발 폴더의 `externals` 는 이곳을 가리키는 연결).
분류 근거: 개발 이력(시험·채택·탈락 결정)과 실제 선택 로직. 상세 조사: `_local/테스트/결과/integ-2026-10-09/storage-classification.md`(로컬).

## 1. 현재 사용량 — 76.3GB (2026-10-09 정리 후)

정리 전 93.4GB → 17.15GB 삭제 → 76.3GB.

- 기능별 실행 환경 약 26.6GB
  - 앱 본체 실행 환경(externals/runtime, GPT-SoVITS 앱 환경 포함) 4.06GB
  - Qwen 음성(externals/qwen3_tts_venv) 3.55GB
  - 화자 나누기 고급(externals/diarization_venv) 4.71GB
  - 빠른 받아쓰기(externals/asr_ct2_venv) 2.22GB
  - 노래 변환(resources/seed-vc/.venv) 6.19GB
  - Applio(resources/ApplioV3.2.9/env) 5.88GB
- 모델 파일 약 40GB(필수 약 21GB · 선택 약 19GB — 2절)
- 그 밖 약 10GB
  - Applio 모델 등 약 1.4GB(환경 제외)
  - 사용자 자료: `사용자` 폴더 2.6GB, seed-vc 노래 변환 결과(`_곡변환결과`) 1.03GB
  - 개발 이력(.git) 2.0GB, 실험 기록(`_local`) 1.8GB, 앱 부품(node_modules) 0.6GB

### 왜 큰가
- 기능마다 요구하는 라이브러리 판이 달라 **실행 환경을 각자 갖고 있다.** 같은 AI 계산 라이브러리(torch)가 판만 달리해 5벌 깔려 있다 — 약 19GB(seed-vc 5.42 · Applio 4.12 · 화자 나누기 4.11 · Qwen 2.71 · GPT-SoVITS 2.67).
- 확실히 안 쓰는 모델은 이미 지웠다. 남은 모델은 모두 어떤 기능이 쓰는 것이다.
- 실행 환경을 합쳐 torch 사본을 줄이는 것은 판 충돌로 기능이 깨질 위험이 커서 하지 않는다(하려면 판 호환 조사부터).

## 2. 분류

### 필수 — 지금 기능의 기본 경로(지우면 기본 기능이 멈춘다) 약 21GB
- 받아쓰기: Whisper large-v3(기본), small(참조 대본 받아쓰기) — externals/whisper_models
- 번역: NLLB-600M(기본) — externals/hf_models
- 대화 분석 기본 엔진: silero-vad · ecapa
- 음성 생성
  - Qwen 0.6B Base — 참조 목소리 낭독·카드(externals/qwen3_tts_hf)
  - Qwen 0.6B CustomVoice — 소희(externals/qwen3_tts_0_6b_customvoice)
  - Qwen 1.7B CustomVoice — **감정 낭독**(기본 켬). reader.ipc.ts 의 감정 모델 자동 선택이 custom_voice·1b7 폴더를 고른다(externals/qwen3_tts_1_7b_customvoice)
  - Supertonic3 — 기본 목소리
  - Qwen 실행 환경(externals/qwen3_tts_venv)
- 음원 분리: RoFormer 3종(externals/separator_models)
- 앱 파이썬 실행 환경(externals/runtime)

### 선택 — 대안이거나 드문 기능(지우면 그 기능만 사라진다) 약 19GB(모델) + 환경
- 노래 목소리 바꾸기: 앱 안 흡수본 — 모델 2.4GB(externals/song_vc_models), 실행 환경은 앱 런타임 공유(2026-10-10 이전엔 외부 seed-vc 9.4GB)
- 번역 대안 Qwen2.5-3B 5.76GB
- 빠른 받아쓰기 faster-whisper: 모델 2.88GB + 환경 2.22GB — large-v3 와 같은 모델의 다른 형식(기본 받아쓰기는 Whisper .pt)
- 화자 나누기 고급(Community-1): 환경 4.71GB + 모델 — 대화 분석 기본값이 아님
- Qwen 1.7B Base 4.23GB — 설계 목소리 다섯 전용
- VoiceDesign 1.7B 4.21GB — 새 목소리를 설계할 때만 필요. 이미 만든 설계 목소리는 저장된 참조 음성으로 동작. **앱 안에 다시 받는 경로가 없다**(지우면 수동으로 받아야 함)
- GPT-SoVITS(엔진 코드 1.08GB + runtime 안 앱 환경) — 자동 선택 2순위 엔진
- piper 0.06GB

### 분석 대기
- Applio 7.24GB(resources/ApplioV3.2.9) — 음성으로 목소리 모델을 만드는 도구. 앱 코드·문서 참조 없음. 개발툴에 흡수할 기능이 있는지 분석한 뒤, 필요 없으면 지운다(사용자 결정 2026-10-09).

### 사용자 자료 — 지우지 않는다
- resources 의 참조 목소리 폴더(HIKIA_NEW · 오몽 · 쵸딘 · 히오나 · 럭끼 · 마젬 · _노래 · _감정 · _장문테스트)
- `사용자` 폴더, seed-vc `_곡변환결과`
- resources 는 사용자 참고 자료 폴더 — 산출물을 만들지 않는다.

### 판단 보류
- `_local` 1.8GB — 판정 근거 음원·실행 기록이 섞여 있다.
- `.git` 2.0GB — 개발 이력.

## 3. 정리 기록

### 2026-10-09 삭제 — 17.15GB (사용자 결정)
- 격리된 받아쓰기 모델 8.76GB(`externals/_격리_사용안함_ASR모델`: large-v3-turbo·large-v2·Qwen3-ASR-1.7B) — 2026-09-21 정답지 시험 탈락(64.2/61.3/55.9%), 지울 목적으로 격리해 둔 것.
- 손상된 예전 GPT-SoVITS 환경 3.26GB(`externals/gptsovits_venv`) — 2026-08-29 사고 손상본. runtime.json 은 `runtime/gptsovits_venv_app` 을 가리킨다(doc/app-runtime-installer.md 의 '보존' 결정을 함께 바꿈).
- 번역 NLLB-1.3B 5.13GB — 시험상 개선 없음. 기본 600M 은 남김.
- 지우기 전 확인: 세 폴더 모두 링크 아님·안쪽 링크 없음 / ComfyUI 두 설치(python3.12·3.13)의 모델 경로 설정·모델 링크·노드 코드에 참조 없음 / 저장된 설정의 번역 모델은 기본(600M). 링크를 따라가지 않는 방식(Node rmSync)으로 지웠다.

### 지키는 원칙
- ComfyUI 가 참조하는 모델은 지우지 않는다(사용자 지시).
- `externals` 는 연결(정션)이다 — PowerShell `Remove-Item` 을 쓰지 않는다(연결 너머까지 지운 사고가 있었다).
- 지우기 전에 분류·근거를 보이고, 사용자가 고른 것만 지운다.

### 2026-10-10 삭제 — 9.43GB (사용자 결정)
- 외부 노래 변환 도구 `resources/seed-vc` 전체 — 노래 변환을 앱 안으로 흡수(python/song_vc + externals/song_vc_models 2.4GB, 앱 런타임 사용)하고 같은 곡 청취로 같은 수준 확인 뒤. 시험 결과물은 테스트 폴더로 먼저 옮겼다. 순 절감 약 7GB(새 모델 복사 2.4GB 포함).

## 4. 남은 일과 더 줄이는 방법
- 설정 화면에 'NLLB-1.3B' 선택지가 남아 있다 — 고르면 모델이 없어 번역이 실패한다(지금 설정은 600M). 선택지 정리 필요.
- Applio 분석 → 불필요하면 7.24GB.
- 쓰지 않는 선택 기능 정리(사용자 결정): 노래 변환 약 9.3GB(변환 결과 제외), 화자 나누기 고급 약 4.7GB, 빠른 받아쓰기 약 5.1GB, 번역 대안 5.76GB, VoiceDesign 4.21GB.
- 실행 환경 합치기는 권하지 않음.

## 5. 다시 재는 방법
PowerShell 에서 폴더별 합계(읽기만):
```
Get-ChildItem -LiteralPath <폴더> -Recurse -File -Force | Measure-Object Length -Sum
```
분류 판정은 폴더 이름 검색이 아니라 **실제 선택 로직**(예: 감정 모델 자동 선택)과 개발 이력으로 한다 — 이름 검색만으로 1.7B CustomVoice 를 '선택' 으로 잘못 분류한 적이 있다.
