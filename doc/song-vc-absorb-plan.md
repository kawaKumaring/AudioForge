# 노래 변환(seed-vc) 흡수 계획 (2026-10-10, 구현·검증 — 청취 대기)

> **진행(2026-10-10)** — 사용자 결정: 개인 사용(GPL 코드 이식 허용), 시험 곡 승인.
> - 코드: `python/song_vc/`(f0 44kHz 노래 경로만 15모듈+bigvgan, convert.py, LICENSE GPL-3.0, ATTRIBUTION — 원본 커밋 51383ef). munch 는 작은 dict 로 대체, dac 는 지연 import, 저장은 soundfile, BigVGAN 은 로컬 전용 로더. 다운로드 없음.
> - 모델: `externals/song_vc_models/` 에 5종 **복사**(약 2.4GB, 9파일 sha256 원본과 같음, manifest.json). 원본 seed-vc 는 검증 끝까지 그대로.
> - 실행 환경: 새 환경 없이 `externals/runtime/gptsovits_venv_app`(torch 2.11). 앱 전환은 환경변수 `AF_SONG_VC_ENGINE=absorbed`(기본은 옛 경로 그대로).
> - CPU 대조(fp32, 합성 입력): 단계별 최대 차이 — Whisper 2.7e-5 · CAM++ 0 · RMVPE 1.1e-4Hz · 길이 조절 6e-8 · DiT 한 단계 0 · CFM 2단계 5.7e-6 · BigVGAN 0. 가중치 키 누락·초과 0(원본 로더가 원래 건너뛰는 DiT 키만 같게 차이).
> - GPU 같은 입력 비교(9/20 곡 1개: 유우리 - 베텔기우스 주 보컬 + 쵸딘 8초, 40단계): 옛 엔진 113초 · 새 엔진 96초, 길이 같음(236.37초), 음량 차 0.2dB 이내. 로그 멜 평균 차이 새↔옛(오늘) 0.476 · 옛(9/20)↔옛(오늘) 0.4735(같은 엔진 실행마다 차이 = 기준선) → 새 엔진 차이는 기준선 수준.
> - 청취 대기: 테스트/결과/song-vc-absorb-20261009185303/비교듣기.html(A/B/C 이름 숨김, 정답표 따로). 세 결과 모두 최대값이 1.0 — 옛 엔진에도 있던 클리핑 가능성(이번 범위 밖).
> - 남은 것: 청취 확인 → env.json 을 새 경로로 고정·스위치 정리 → 외부 seed-vc 실행 환경·쓰지 않는 모델·원본 코드 정리(약 7.4GB, 사용자 결과물 제외). 모델 가중치 이용 조건 미확인.

개발 모토는 **흡수**다 — 외부 도구를 폴더째 두고 부르지 않고, 실제로 쓰는 핵심(모델·최소 추론 코드)만 AudioForge 안으로 옮긴다.
지금 노래 변환은 `resources/seed-vc`(10.6GB, 전용 실행 환경 6.19GB)를 별도 프로세스로 부른다(`externals/env.json` 의 singing_python·singing_script → `python/song_voice.py`).
근거 표시: [코드] 코드로 확인 · [기록] 파일·기록으로 확인 · [가설] 미확인. 상세 조사(로컬): `_local/테스트/결과/integ-2026-10-09/seedvc-absorb-plan.md`.

## 1. 실제로 쓰는 것
- 호출 인자 [코드]: song_voice.py → seed-vc inference.py, 확산 40단계, f0 조건 켬, 자동 음높이 맞춤 끔, 반음 이동(옥타브 단위). 그 밖은 기본값(cfg 0.7, fp16, 길이 1.0). 9/20 변환 스크립트(`_곡변환.py`)도 같은 인자.
- 모델 5종 [코드]:
  - 노래 변환 DiT(f0, 44kHz) 783MB
  - 보코더 BigVGAN v2 44kHz 467MB
  - Whisper small(encoder 만 씀) 923MB
  - 음높이 RMVPE 173MB
  - 화자 특징 CAM++ 27MB
- 쓰지 않는 모델 [코드]: BigVGAN 22kHz 429MB, 말소리용 DiT 420MB.
- 코드 [코드]: 정적 추적 25파일 5,292줄 중 f0 경로 약 4,300줄. hifigan·CUDA 커널·학습·웹 화면·GUI 는 버린다. `modules/length_regulator.py` 맨 위의 `from dac...` 가 쓰지 않는 descript-audio-codec 를 끌고 오므로 지연 import 로 바꾼다.

## 2. 설계
- 코드: `python/song_vc/` 에 최소 모듈 + LICENSE(GPL-3.0)·ATTRIBUTION.
- 모델: `externals/song_vc_models/` 에 5종만 **복사**(원본은 검증 끝까지 그대로). Whisper 는 기존 HF safetensors 에서 encoder 만 뽑아 0.18~0.35GB 로 줄이는 안(수치가 원본과 같아 검증 쉬움) — AudioForge 의 whisper small.pt 를 같이 쓰는 안은 키 대응 결함 위험이 있어 보류.
- 실행 환경: 새 환경을 만들지 않고 기존 `externals/runtime/gptsovits_venv_app`(torch 2.11 · transformers 4.50 · librosa 0.10.2)을 쓴다 — munch 하나만 추가. Qwen 환경은 librosa 1.0·numpy 2.5 호환이 걸려 덜 안전 [가설].
- 연결: 지금처럼 별도 프로세스로 띄우되 env.json 의 singing_* 를 새 경로로. 검증 기간에는 옛 경로로 되돌릴 수 있게 둔다.

## 3. 위험
- 라이브러리 판(torch 2.7 → 2.11) [가설]: torchaudio.save(새 판은 torchcodec 필요할 수 있음 → soundfile 로), 옛 weight_norm API, Whisper 비공개 API(`_mask_input_features`), weights_only 미지정 torch.load. torch.cuda.amp 는 직접 쓰지 않음 [코드].
- 라이선스:
  - seed-vc 코드는 GPL-3.0 [코드] — 코드를 옮기면 AudioForge 를 배포할 때 GPL 공개 의무가 생긴다. 개인 사용은 문제없다. 배포할 거라면 새로 작성(수 일~1주 이상 [가설]).
  - 모델 가중치 5종의 이용 조건: 로컬에 README·LICENSE 가 없어 **미확인** [기록].
- seed-vc 폴더 안에 사용자 산출물(`_곡변환결과` 등)이 섞여 있다 — 폴더를 통째로 지우지 않는다.

## 4. 검증 순서
1. CPU: 새 코드가 가중치를 읽을 때 키가 빠짐없이 맞는지 대조(음원 불필요).
2. CPU: seed 를 고정한 임의 입력으로 단계별 중간값을 옛 코드와 수치 비교(음원 불필요).
3. GPU(승인 후): 9/20 과 같은 입력으로 변환해 기존 결과와 수치 비교 + 사용자 청취. 입력 곡은 사용자 자료라 파일별 승인 필요.
4. 같다고 확인되면 외부 seed-vc 의 실행 환경·쓰지 않는 모델·원본 코드 정리(사용자 산출물 제외). 예상 절감 약 7.4GB [가설].

## 결정 필요
- 진행 여부, 그리고 GPL 코드를 옮기는 방식(개인 사용 전제)으로 갈지, 새로 작성할지.
- 모델 가중치 이용 조건 확인 방법(웹 확인 허락 여부).
- 3단계 GPU 검증에 쓸 입력 곡 지정.
