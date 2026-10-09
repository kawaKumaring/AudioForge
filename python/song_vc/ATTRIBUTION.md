# 출처 표기 — song_vc

- 원본: Plachta/seed-vc (https://github.com/Plachta/seed-vc), 커밋 `51383efd921027683c89e5348211d93ff12ac2a8` (2025-04-20). 로컬 사본 `resources/seed-vc`.
- 라이선스: GPL-3.0 (같은 폴더 `LICENSE` 는 원본 그대로 복사). 이 폴더의 코드는 GPL-3.0 을 따른다 — AudioForge 를 배포하면 공개 의무가 생긴다(개인 사용은 제약 없음).
- BigVGAN 부분(`modules/bigvgan/`)은 원래 NVIDIA BigVGAN(MIT, 파일 머리 표기) 에서 seed-vc 가 가져온 것이다.

## 옮긴 것 (f0 44.1kHz 노래 경로만)
- `modules/commons.py`, `audio.py`, `diffusion_transformer.py`, `flow_matching.py`, `length_regulator.py`, `wavenet.py`, `encodec.py`, `rmvpe.py`
- `modules/campplus/DTDNN.py`, `layers.py`
- `modules/bigvgan/bigvgan.py`, `activations.py`, `utils.py`, `env.py`, `alias_free_activation/torch/*`
- `configs/config_dit_mel_seed_uvit_whisper_base_f0_44k.yml` (체크포인트 폴더의 판, presets 판과는 log_dir·pretrained_model 두 줄만 다름 — 추론에 쓰지 않는 값)
- `convert.py` 는 `inference.py` 의 f0 분기만 남긴 것.

## 바꾼 것 (수치 동작은 그대로)
- `commons.py`: `munch.Munch` → 같은 동작의 작은 dict 클래스(이름 Munch 유지).
- `length_regulator.py`: `from dac...VectorQuantize` 를 `vector_quantize=True` 분기 안으로 지연 import (이 모델은 False).
- `bigvgan/bigvgan.py`: huggingface_hub 믹스인·다운로드 제거, 로컬 폴더 전용 `BigVGAN.load_local()` 추가(원본 로컬 분기와 같은 순서).
- `bigvgan/utils.py`: matplotlib 그림·학습 체크포인트·meldataset 의존 함수 삭제(`init_weights`·`apply_weight_norm`·`get_padding` 만 남음).
- `convert.py`: 모델 경로는 `externals/song_vc_models`(또는 `--models-dir`/`AF_SONG_VC_MODELS`), 저장은 torchaudio.save 대신 soundfile 32비트 실수 wav. 말하기(f0 끔)·hifigan·vocos·hubert·xlsr 분기 삭제.
- 버린 것: hifigan, openvoice, astral_quantization, v2, bigvgan CUDA 커널·meldataset, campplus classifier, 학습·웹·GUI 스크립트.

## 모델
`externals/song_vc_models/manifest.json` — 원본 체크포인트 경로·크기·sha256(복사본과 원본 일치 확인). 가중치 이용 조건은 로컬 근거가 없어 미확인.
