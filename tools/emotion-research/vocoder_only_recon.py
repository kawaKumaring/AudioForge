# -*- coding: utf-8 -*-
"""복원 단계 단독 시험 — 입력 조각 → (inference.py 와 같은) librosa 44.1kHz 적재 → 같은 멜 설정 → 같은 BigVGAN 가중치 → 파형.
확산(DiT)은 건너뛴다. GPU 사용 안 함(CPU 강제). 새 다운로드 없음(로컬 캐시만, offline)."""
import os, sys
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
os.environ["HF_HUB_OFFLINE"] = "1"
sys.path.insert(0, ".")
import numpy as np, torch, torchaudio, librosa
from modules.audio import mel_spectrogram          # inference.py:229 와 같은 함수
from modules.bigvgan import bigvgan                 # inference.py:99  와 같은 로더
src, out = sys.argv[1], sys.argv[2]
device = torch.device("cpu")
sr = 44100                                          # f0_condition 경로 (inference.py:272)
source_audio = librosa.load(src, sr=sr)[0]          # inference.py:270 그대로
x = torch.tensor(source_audio).unsqueeze(0).float().to(device)   # :279
mel_fn_args = {"n_fft": 2048, "win_size": 2048, "hop_size": 512, "num_mels": 128,
               "sampling_rate": sr, "fmin": 0, "fmax": None, "center": False}   # config_dit_mel_seed_uvit_whisper_base_f0_44k.yml + inference.py:219
mel = mel_spectrogram(x, **mel_fn_args)
voc = bigvgan.BigVGAN.from_pretrained("nvidia/bigvgan_v2_44khz_128band_512x", use_cuda_kernel=False,
                                       cache_dir="checkpoints/hf_cache", local_files_only=True, map_location="cpu")
voc.remove_weight_norm(); voc = voc.eval().to(device)
with torch.no_grad():
    wave = voc(mel.float()).squeeze()               # inference.py:378 vocoder_fn(vc_target.float()).squeeze()
wave = wave[None, :]
torchaudio.save(out, wave.cpu(), sr)                # inference.py:407 과 같은 저장
print("입력 %.3f초(%d샘플@44.1k) → 멜 %s → 복원 %.3f초, 최고진폭 %.3f, 장치 %s"
      % (x.size(1)/sr, x.size(1), tuple(mel.shape), wave.size(1)/sr, float(wave.abs().max()), device))
