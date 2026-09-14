# 텍스트 추출 — faster-whisper(CTranslate2) 실행 경로

상태: **텍스트 추출 모드에만 연결. 기본은 기존 경로 그대로.** master 병합 안 함.

## 무엇을 한 것인가

같은 Whisper **large-v3** 가중치를 CTranslate2 로 돌리는 **실행 경로를 하나 더** 놓았다.
모델을 바꾼 것이 아니다 — 같은 모델을 다른 실행기로 돌린다.

화면의 **텍스트 추출 > 실행 방식**에서 `기본` / `빠른 실행` 중 고른다. **기본값은 `기본`**
(지금까지 쓰던 경로)이고, 고르지 않으면 아무것도 달라지지 않는다.

## 왜 격리 환경인가

앱이 쓰는 파이썬은 **ComfyUI 내장 파이썬**이다(`externals/env.json`). 거기에는 이미 torch 와
합성 환경이 들어 있고, ctranslate2 는 **cuDNN 9** 를 요구하며(4.5.0 CHANGELOG) 제 DLL 을
직접 연다. 같은 자리에 섞으면 사용자의 ComfyUI·합성 환경을 흔든다.

그래서 기존 GPT-SoVITS·Qwen 다리와 **같은 방식**으로, 전용 venv 안에서 돌리고 결과 JSON 만
받는다. 전역 PATH·CUDA 를 바꾸지 않고, 소스 빌드도 하지 않는다.

    externals/asr_ct2_venv/                                  ← 격리 실행 환경
    externals/asr_ct2_models/faster-whisper-large-v3/        ← 로컬 절대경로 적재

cuBLAS·cuDNN 은 그 venv 안의 pip 꾸러미에서만 찾는다. `add_dll_directory` 만으로는 부족했다 —
ctranslate2 가 cuBLAS 를 **실행 도중 이름으로** 불러오기 때문이다(실측:
`Library cublas64_12.dll is not found`). 그래서 **그 프로세스의 PATH 앞에만** 붙인다.

## 고정한 판 (이 장비에서 실제로 돈 것)

- faster-whisper **1.2.1** · ctranslate2 **4.8.2**
- nvidia-cublas-cu12 12.9.2.10 · nvidia-cudnn-cu12 **9.26.0.51** · nvidia-cuda-nvrtc-cu12 12.9.86
- 모델 `Systran/faster-whisper-large-v3` — **실행에 필요한 5개 파일만** 받았다
  (config.json / model.bin 3.09GB / preprocessor_config.json / tokenizer.json / vocabulary.json)
- 장치 cuda(1대 인식) · 정밀도 **float16** · beam 1 · 배치 1

**cuDNN 요구가 문서마다 다르다.** faster-whisper README 는 cuDNN 9, CTranslate2 설치 문서는
cuDNN 8 이라고 적는다. 설치할 판을 기준으로 판단해 **cuDNN 9** 를 골랐다 — CTranslate2
CHANGELOG v4.5.0 이 "supports CUDNN 9 and is no longer compatible with CUDNN 8" 이라고
못 박고 있고, 우리가 쓰는 것은 4.8.2 이기 때문이다.

**sm_120(RTX 50 계열)**: CHANGELOG v4.6.2 에 "Disable INT8 for sm120 - Blackwell GPUs" 가 있다.
그래서 int8 계열을 쓰지 않고 **float16** 으로 고정했다.

## 기존과 무엇을 맞췄나 — 이름이 같아도 뜻이 같다고 보지 않는다

| 옵션 | 기존 경로(openai-whisper) | faster-whisper 기본 | 우리가 준 값 |
|---|---|---|---|
| beam_size | 인자 없음 → greedy | 5 | **1**(기존과 같게) |
| best_of | 인자 없음 | 5 | 1 |
| condition_on_previous_text | 기본 True, 우리는 False 명시 | True | **False** |
| word_timestamps | 기본 False, 우리는 True | False | **True** |
| hallucination_silence_threshold | 기본 None, 우리는 2.0 | None | **2.0** |
| logprob_threshold ↔ **log_prob_threshold** | -1.0 | -1.0 | -1.0 (**이름이 다르다**) |
| vad_filter | 없음 | False | **False 유지** |

`vad_filter` 를 켜지 않은 이유: 기존 무음 게이트와 판정이 겹쳐 **무엇이 무엇을 지웠는지**
알 수 없게 된다. 기존 무음 오인식 방지는 새 경로에서도 **그대로 태운다**.

## 연결 규칙

- **텍스트 추출 모드에서만** 이 선택이 전달된다. 분리 모드의 후처리 전사, TTS 참조 전사 같은
  공용 호출부는 기존 경로 그대로다.
- 반환 모양이 기존과 같다(text·language·segments·words) — TXT·SRT·타임스탬프·번역이 그대로 돈다.
- `transcribe()` 는 **generator** 다. 다리에서 끝까지 돌려야 전사가 실제로 일어난다.
- **실패를 숨기지 않는다.** 환경·모델이 없으면 `ASR_CT2_VENV_MISSING` / `ASR_CT2_MODEL_MISSING`
  으로 실패하고, 다리가 죽으면 사유를 들고 올린다. **몰래 CPU 로 돌리거나 기존 엔진으로
  바꾸지 않는다.**
- 실행 기록을 남긴다 — 엔진·판·실제 장치·정밀도·beam·배치·적재/전사 시간(`asrRun` 이벤트),
  그리고 sidecar provenance 에 engine·model.

## 이 장비에서 확인한 결과

같은 파일(저장소 fixture, 한국어 18.56초)로 **기존 1회 / 새 엔진 1회**만 돌려 비교했다.

- **출력이 완전히 같았다** — 세그먼트 8, 단어 30, 글자 128, 텍스트 일치율 **100%**,
  구간 시작·끝 경계 차이 **0.00초**, 언어 ko, 연속 중복 0, 시간 단조 증가.
- 시간: 기존 = 적재 20.73s + 전사 5.99s (합 27.4s) / 새 경로 = 적재 3.43s + 전사 11.44s (합 15.4s).
  **두 번째 실행부터는 전사 1.3s** 로 떨어졌다 — 첫 실행에 일회성 커널 준비 비용이 있다.
- 제품 경로 완주: TXT·SRT·타임스탬프 파일 생성, `output_verified: true`.

★**한 파일이다.** 이것으로 한국어 전체 정확도가 좋아졌다고 말할 수 없다. 이번에 확인한 것은
**같은 결과를 내는 다른 실행 경로가 붙었다**는 것이다.

## 성과 구분

- **기능 개선(이 저장소)**: 텍스트 추출에 실행 경로 선택이 생겼다. 기본값은 그대로다.
- **공개 성능 근거**: faster-whisper 저장소가 같은 정확도에서 더 빠르고 메모리를 덜 쓴다고
  밝히고 있다. 우리가 재현한 수치가 아니다.
- **이 장비에서 확인한 것**: 위 "확인한 결과" 문단의 수치뿐이다.

## 확인 방법

- 계약 검사: `python/test_asr_ct2_contract.py` (10건) — 반환 모양·시간 정보·실행 기록·
  무음 게이트 유지·실패 노출·기본 선택 보존.
- 파이썬 전량: 2,554건 · 114/114 파일 통과.

## 아직 하지 않은 것

- turbo·Qwen ASR 등 다른 모델은 설치하지 않았다.
- 배치 크기 탐색, 공개 벤치마크 재현, 여러 모델 순회는 하지 않았다.
- 분리 모드 후처리 전사와 TTS 참조 전사는 **연결하지 않았다**(첫 적용 범위를 좁혔다).
- 취소 동작은 기존 워커의 취소 경로를 그대로 쓴다 — 다리는 하위 프로세스라 워커가 끝나면
  함께 정리된다. **하위 프로세스 중간 취소의 응답 시간은 따로 재지 않았다.**
