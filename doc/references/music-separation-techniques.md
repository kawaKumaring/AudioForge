# 음악·보컬·악기 분리 기술 계보와 AudioForge 고도화 후보

> 조사일: 2026-08-23  
> 목적: 모델을 곧바로 제품에 탑재하기 위한 선별표가 아니라, 공개 기술에서 **작동 원리·품질 기여 요소·검증 방법**을 추출해 AudioForge의 분리 품질을 높이기 위한 참고 문서다.  
> 조사 제한: 사용자 미디어, ComfyUI workflow/prompt, 외부 API, 모델 다운로드 및 GPU 실행은 사용하지 않았다.

## 1. 근거 표기와 판단 규칙

- **[사실]** 원 논문, 공식 저장소, 공식 모델 카드 또는 현재 AudioForge 코드로 확인한 내용.
- **[제작사 주장]** 모델 제작자/배포자가 보고한 점수나 품질 설명. 동일 조건으로 재검증되기 전에는 AudioForge 성능으로 간주하지 않는다.
- **[추론]** 공개 원리와 현재 구현을 연결한 개선 가설. synthetic/open benchmark 검증 전에는 사실로 취급하지 않는다.
- 코드 라이선스와 checkpoint/학습 데이터의 사용권은 별개다. 저장소가 MIT여도 가중치에 명시적 라이선스가 없으면 `NOASSERTION`으로 기록하고 배포를 보류한다.
- 서로 다른 논문의 SDR은 데이터셋, extra data, stem 정의, BSS Eval 버전, song-wise/segment-wise 집계가 다르면 직접 비교하지 않는다.

## 2. 현재 AudioForge 구현 기준선

### 2.1 확인된 경로

**[사실]** `python/separate.py`는 음악 모드에서 다음 다섯 선택지를 노출한다.

| UI/설정 값 | 구현 | 출력 |
|---|---|---|
| `htdemucs` | Demucs `get_model` + `apply_model` | vocals/drums/bass/other 4 stems |
| `htdemucs_ft` | 같은 Demucs 경로의 fine-tuned bag | 4 stems |
| `roformer` | `audio-separator` + `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | vocals/instrumental 2 stems |
| `roformer_melband` | `mel_band_roformer_kim_ft2_bleedless_unwa.ckpt` | vocals/instrumental 2 stems |
| `roformer_ensemble` | 위 두 모델 결과를 stem별 0.5/0.5 파형 평균 | vocals/instrumental 2 stems |

**[사실]** 모든 경로는 먼저 ffmpeg로 float32 WAV를 만들며, Demucs는 모델 sample rate로 재표본화한다. RoFormer sample rate/chunk/overlap은 `audio-separator` 기본값에 맡긴다. 분리 후 선택적으로 무음 제거, 보컬 전사, WAV→MP3/FLAC 변환을 수행한다.

### 2.2 현재 구현에서 확인한 위험

1. **[사실] Demucs 전체 입력이 먼저 GPU로 이동한다.** `wav.unsqueeze(0).to(device)` 뒤 `apply_model(..., device=device)`를 호출한다. Demucs 공식 `apply_model`은 chunk inference를 지원하지만, mix와 inference device가 다를 때에만 전체 곡을 원래 device에 남겨둘 수 있다. **[추론]** 긴 곡의 VRAM 절감을 위해 mix는 CPU에 두고 chunk만 GPU로 보내는 방식이 우선 검증 대상이다.
2. **[사실] 추론 파라미터가 명시적으로 고정되지 않았다.** Demucs `shifts/split/overlap/segment`와 RoFormer chunk/overlap/autocast/normalization을 호출부가 기록하지 않는다. dependency 업데이트가 품질·속도·메모리를 바꿀 수 있다.
3. **[사실] 파형 앙상블은 sample rate 검증 없이 두 번째 결과의 `sr`을 무시하고, 최소 길이·최소 채널로 잘라 평균한다.** 시간 지연, resampling 차이, 채널 불일치, polarity/phase 차이를 검사하지 않는다. **[추론]** 미세 지연이 있으면 평균이 고역과 transient를 흐리고 leakage를 늘릴 수 있다.
4. **[사실] mixture consistency 검사가 없다.** `vocals + instrumental ≈ input` 또는 네 stem 합 ≈ input을 측정하지 않는다. 출력 clipping/peak, DC, NaN/Inf, 길이 보존, 무음 구간 hallucination도 자동 게이트가 없다.
5. **[사실] 앙상블은 항상 전체 파형을 동일 가중 평균한다.** stem별, 주파수별, 구간별 신뢰도나 누설 특성은 반영하지 않는다.
6. **[사실] 모델 파일명만 고정되고 해시·출처·weight license·학습 데이터가 manifest로 고정되지 않았다.** `load_model`은 첫 실행 다운로드를 허용한다. 재현성과 공급망 검증이 약하다.
7. **[사실] 현재 smoke test는 합성 오디오로 Demucs가 실행되는지 확인하지만 품질 회귀를 측정하지 않는다.** RoFormer/앙상블, chunk seam, leakage, phase, transient에 대한 deterministic fixture gate가 없다.
8. **[사실] float32 intermediate를 `soundfile` 기본 subtype으로 저장한다.** `sf.write`에 subtype을 명시하지 않아 배포 환경에 따라 정밀도 정책이 불투명하다. 이후 MP3 변환은 분리 품질 평가 전에 수행하면 안 된다.

## 3. 기술 계보: 오래된 원리에서 최신 구조까지

### 3.1 고전 DSP·통계 분리

| 계열 | 작동 원리 | 여전히 유효한 품질 기여 | 한계와 AudioForge 활용 |
|---|---|---|---|
| 주파수/센터 채널 제거, EQ·notch | 보컬이 중앙에 있고 L/R 상관이 높다는 가정으로 mid/side 또는 특정 대역 억제 | 계산량이 매우 작고 CPU fallback/preview에 적합 | hard-panned·stereo reverb 보컬, 중앙 악기를 함께 제거. **[추론]** 최종 separator가 아니라 입력 진단 및 emergency preview로 제한 |
| ICA | 관측 채널을 통계적으로 독립인 성분으로 선형 분해 | 다채널 녹음과 독립성 가정이 맞을 때 유용 | stereo master는 소스 수보다 관측 수가 적고 소스가 독립적이지 않아 일반 음악 stem 분리에 약함 |
| NMF | magnitude spectrogram을 비음수 basis와 activation으로 분해 | 반복적 패턴, 악기 dictionary, 저비용 adaptation에 유효 | phase는 별도 처리, source label이 자동 보장되지 않음. **[추론]** neural 결과의 residual noise/반복 반주 보정에 제한적으로 적용 |
| RPCA | spectrogram을 low-rank 반주 + sparse foreground로 분해 | 반복 반주와 드문 보컬이라는 구조적 prior | 조밀한 보컬·비반복 반주·타악 transient에서 가정 붕괴. vocal activity 또는 실패 진단 feature로는 유용 |
| HPSS | 시간/주파수 방향 median filtering으로 harmonic·percussive 분리 | transient와 지속음의 서로 다른 구조를 명시적으로 보존 | vocals/instruments 의미 분리는 아님. **[추론]** 드럼 transient 보호, leakage 진단, ensemble frequency gating에 유용 |
| Wiener/soft mask | source magnitude/variance 추정으로 mixture의 복소 STFT를 source별 배분 | mixture phase, stereo spatial covariance, 합 보존에 강점 | 추정 magnitude가 틀리면 누설. Open-Unmix의 multichannel generalized Wiener filter는 현대 neural 출력에도 재사용 가능 |

고전 방식의 핵심 유산은 “과거 모델로 되돌아가기”가 아니라 다음 세 가지다: (1) 합이 입력과 맞아야 한다는 보존 제약, (2) harmonic/percussive·반복/희소 같은 명시적 prior, (3) 복소 위상과 stereo spatial covariance를 후처리에서 이용하는 방법.

### 3.2 신경망 분리의 주요 전환

| 기술 | 공개 원리와 보고 | AudioForge가 추출할 원리 |
|---|---|---|
| Wave-U-Net (2018) | **[사실]** 1-D U-Net으로 raw waveform을 다중 해상도 처리하고 skip connection으로 fine timing을 복구한다. 공식 코드는 MIT다. | time-domain branch가 phase를 직접 다루고 transient timing을 보존한다. overlap context와 exact-length crop을 회귀 테스트에 반영 |
| Conv-TasNet → music adaptation | **[사실]** learnable time-domain encoder/mask/decoder와 dilated temporal convolution으로 separation한다. Demucs 논문은 음악에서 Conv-TasNet을 비교 기준으로 사용했다. | 저지연·speech에는 강하지만 고 sample-rate 장곡의 receptive field/메모리 trade-off를 명시해야 함 |
| Open-Unmix (2019) | **[사실]** source별 magnitude model을 결합하고 multichannel generalized Wiener filter 뒤 iSTFT한다. 공식 PyTorch 구현과 코드는 MIT, 기본 44.1 kHz stereo 4-stem이다. | mixture phase/spatial covariance 기반 재할당, residual target, consistency 후처리의 검증 가능한 기준 구현 |
| Demucs v1/v2 | **[사실]** waveform U-Net + recurrent bottleneck, data augmentation으로 time-domain MSS를 고도화했다. | transient/phase 보존과 spectrogram 모델의 상보성을 ensemble에 이용 |
| Hybrid Demucs v3 | **[사실]** waveform branch와 spectrogram branch를 함께 사용한다. MDX 2021 우승 계열이다. | 단일 도메인의 high-frequency noise 또는 transient 손실을 hybrid fusion으로 상쇄 |
| KUIELab MDX-Net | **[사실]** Sony MDX Challenge 제출용 공개 코드/가중치가 있고 공식 submission 저장소는 MIT다. | TFC-TDF 계열의 시간-주파수 압축·확장과 Demucs의 상보 오차를 stem별 ensemble에 활용 |
| HTDemucs v4 | **[사실]** waveform/spectrogram U-Net의 bottleneck을 self/cross-domain Transformer로 연결한다. 공식 저장소는 MIT이나 2025-01-01 archive되었고 유지보수 fork도 기능 개발은 제한적이다. 공식 README는 MUSDB18HQ+추가 800곡, 4-stem 9.0 dB, sparse/per-source FT 9.2 dB를 보고한다. | cross-domain context, shift equivariance, 25% overlap weighted OLA, stem별 bag weights. 기존 구현에서 이 inference recipe를 명시적으로 고정하고 계측 |
| Band-Split RNN/BS-RoFormer | **[사실]** complex spectrogram을 subband embedding으로 만들고 time/band 축을 계층적으로 모델링한다. BS-RoFormer는 RoPE를 사용하며 논문은 MUSDB18HQ no-extra-data 소형 모델 평균 SDR 9.80 dB를 보고한다. | 전 대역 동일 처리 대신 주파수 대역별 용량·문맥을 배분. 보컬 formant와 저역 bass/kick의 상충을 줄이는 설계 |
| Mel-Band RoFormer | **[사실]** heuristic non-overlap band 대신 mel scale 기반 overlapping bands를 사용한다. 논문은 MUSDB18HQ에서 BS-RoFormer보다 vocals/drums/other가 향상됐다고 보고한다. | overlapping band의 경계 artifact 완화, 청각 해상도에 맞춘 주파수 용량 배분. 현재 “bleedless” 파일명은 독립 검증 전 제작자 주장으로만 취급 |
| SCNet (2024) | **[사실]** sparse frequency downsampling으로 유익한 대역은 보존하고 덜 중요한 대역은 더 압축하며, dual-path RNN으로 시간·주파수 문맥을 모델링한다. 공식 구현은 MIT와 checkpoint를 제공한다. | 전체 frequency map을 균일 계산하지 않는 효율화. 다만 checkpoint 권리와 Windows inference 재현성은 별도 확인 |
| Banquet/query-bandit (2024) | **[사실]** band-split separator에 PaSST instrument query를 결합해 하나의 stem-agnostic decoder로 여러/세부 악기를 요청한다. 논문은 MoisesDB에서 24.9M params로 guitar/piano에서 6-stem HTDemucs보다 높았다고 보고한다. 논문은 CC BY 4.0, 공식 코드는 별도 확인 필요. | 고정 VDBO를 넘어 “악기 이름으로 추출”하는 장기 구조. P0가 아니라 ontology·query UX 연구 항목 |
| BSMamba2 vocal separation (2025) | **[제작사 주장]** band split + dual path + Mamba2로 긴 문맥과 sparse vocal 구간을 다루며 cSDR 11.03 dB와 uSDR 개선을 보고한다. | 긴 무보컬 구간에서 hallucinated vocal/leakage를 따로 평가해야 한다는 교훈. checkpoint·공식 코드·license가 확인되기 전 참고만 가능 |

### 3.3 위상, transient, 누설에 관한 공통 교훈

- **[사실]** magnitude mask에 mixture phase만 쓰는 방식은 source phase가 다른 bin에서 한계가 있다. Deep ResUNet 연구는 magnitude와 phase를 분리해 추정하고, 이상적 ratio mask가 1을 넘는 bin이 존재하므로 `[0,1]` mask 제한도 문제라고 지적한다.
- **[사실]** waveform 모델은 고역 noise, spectrogram 모델은 transient와 고역 손실이라는 서로 다른 오류를 보일 수 있다는 MSG 후처리 연구가 있다.
- **[추론]** AudioForge의 BS/Mel 파형 평균은 이 상보성을 자동으로 활용하지 못한다. 보컬의 harmonic 영역, 치찰음/트랜지언트, 저역 충격음을 구분해 validation-set에서 stem·대역별 가중치를 학습하거나 선택하는 편이 낫다.
- **[사실]** STFT consistency와 mixture consistency는 간단한 projection으로 강제할 수 있다. **[추론]** 2-stem에서는 한 stem을 고품질 primary estimate로 두고 나머지를 `mixture - primary`로 만드는 residual mode도 반드시 A/B해야 한다. 합 보존은 좋아지지만 primary artifact가 complement에 그대로 들어가므로 항상 우월하지는 않다.

## 4. 성능을 실제로 올리는 inference·후처리 레버

### 4.1 Chunk와 overlap-add

- **[사실]** Demucs 공식 기본은 split inference, 25% overlap, weighted transition이며 shift trick 1회다. random time shift 평균은 time equivariance를 높여 공식 코드 주석상 SDR을 최대 약 0.2 dB 개선할 수 있으나 실행 시간이 늘어난다.
- **[사실]** `audio-separator`의 architecture별 overlap 의미는 동일하지 않다. Demucs는 fraction, MDXC/RoFormer 계열은 config의 overlap count/segment 설정에 의존할 수 있다. 하나의 공통 숫자로 UI에 노출하면 안 된다.
- **[추론]** chunk seam 평가는 단순 전체 SDR로 숨겨질 수 있으므로 경계 ±100 ms의 waveform discontinuity, spectral flux error, local SI-SDR을 따로 측정한다.
- **[추론]** 10초/30초/전곡, overlap 0/0.1/0.25/0.5를 모델별로 sweep하고, VRAM·RTF와 seam metric의 Pareto frontier를 저장한다.

### 4.2 앙상블

1. 출력 sample rate, channel count, exact sample length를 먼저 통일한다.
2. GCC-PHAT/cross-correlation으로 sub-sample까지는 아니더라도 sample offset을 추정하고, polarity·gain을 정규화한다. 정렬 보정은 synthetic impulse/chirp에서 먼저 검증한다.
3. 전체 파형 평균 외에 `median_wave`, complex-STFT weighted average, confidence-gated selection을 비교한다.
4. 가중치는 stem별로 따로 최적화한다. vocals에 좋은 모델이 drums에도 좋다는 보장은 없다.
5. 최종적으로 mixture-consistency projection을 적용한 버전과 미적용 버전을 둘 다 평가한다.
6. 평균 점수만 보지 않고 worst-decile leakage/phase/transient를 promotion gate로 둔다.

### 4.3 후처리

- multichannel Wiener filtering: spectrogram magnitude/variance가 신뢰 가능한 경우 stereo spatial image와 mixture phase를 이용해 leakage를 줄이는 후보.
- residual/complement stem: 2-stem karaoke에서 합 보존이 중요할 때 유용. primary stem 선택을 vocal-clean과 instrumental-clean preset으로 분리.
- HPSS-guided protection: drum transient 또는 harmonic vocal을 과도하게 깎는 ensemble을 감지/완화하는 보조 mask. 최종 separator 자체로 오해하지 않는다.
- DC removal, finite check, peak/true-peak policy, fixed float32/24-bit export policy를 separation 품질 게이트 뒤에 둔다.
- 무음 제거는 원본 stem의 시간축을 파괴하므로 raw separated master와 별도 파생 출력으로 유지한다.

## 5. 평가 체계

### 5.1 지표를 하나로 축약하지 않는 이유

**[사실]** BSS Eval v4는 reference와 estimate를 선형 distortion filter로 맞춘다. 공식 `museval`은 time-invariant filter가 계산량을 줄이고, 과거 time-varying filter가 성능을 과대평가할 수 있다고 설명한다. Le Roux 등은 기존 SDR의 오용을 지적하며 SI-SDR을 제안했다. 2025년 대규모 청취 연구는 vocal에는 SDR이 강하지만 drums/bass의 청취 평가는 SI-SAR가 더 잘 맞는다고 보고했다. 따라서 아래를 함께 기록한다.

- global/song-wise SDR 및 BSSEval v4 SDR/SIR/SAR/ISR
- SI-SDR, SI-SIR, SI-SAR와 improvement 대비 input mixture
- leakage: target-silent 구간의 output energy, cross-stem energy ratio, 보컬 없는 구간의 false-vocal rate
- phase/stereo: complex-STFT error, inter-channel phase difference/width 변화, mono-compatibility
- transient: onset ±50 ms error, spectral flux, attack smearing, pre-echo
- reconstruction: `||mixture - Σstems||`, sample length/sample rate/channel parity
- chunk seam: 경계 ±100 ms local error, derivative jump, spectral discontinuity
- 운영: peak VRAM/RAM, CPU/GPU real-time factor(RTF), first-load/warm latency, cancellation latency, temp disk, deterministic repeatability

### 5.2 검증 데이터 구성

- **Tier A synthetic:** impulse, sine sweeps, clicks, polarity 반전, stereo pan, silence→vocal burst, bass/kick 동시 onset, 서로 다른 sample rate/mono/stereo/짧은 파일. CI에서 weights 없이 I/O·정렬·consistency 로직 검증.
- **Tier B 공개 소형 fixture:** 라이선스가 명확한 짧은 multitrack과 stem truth. 모델 checkpoint 테스트는 opt-in, 해시 고정.
- **Tier C benchmark:** MUSDB18HQ/MoisesDB 등은 각 데이터셋 약관을 별도 확인하고 로컬 비공개 평가. 결과는 dataset/version/eval code commit과 함께 기록.
- **Tier D 청취:** vocal-clean, karaoke-instrumental-clean, drums/bass/other 각각 blind A/B. artifact와 contamination을 별도 1–5 척도로 평가.

### 5.3 최소 검증 매트릭스

| 축 | 필수 셀 | 합격/비교 신호 |
|---|---|---|
| stem | vocals, instrumental, drums, bass, other | stem별 SDR/SI-SDR + SIR/SAR; 평균만 금지 |
| content | a cappella, instrumental-only, dense mix, sparse vocals, reverb, distorted guitar, electronic bass | silent-target leakage와 worst-decile |
| transient | kick/snare/click/chirp | onset error, spectral flux, pre/post ringing |
| stereo/phase | center vocal, hard-pan, wide reverb, polarity case, mono fold-down | IPD/width, mono cancellation, reconstruction error |
| duration/chunk | <1 chunk, 경계에 onset, 10분 이상 synthetic stream | seam local metric, peak RAM/VRAM, exact length |
| format | 44.1/48/96 kHz, mono/stereo, float/int input | canonical resample 뒤 length/channel/peak policy |
| runtime | CPU, CUDA(여유 VRAM별), cold/warm | RTF, peak memory, cancellation, child-process cleanup |
| ensemble | BS, Mel, avg-wave, aligned avg, spectral/weighted, residual | quality/compute Pareto + mixture consistency |
| regression | current pinned baseline vs candidate | stem별 median과 10th percentile, no P0 invariant regression |

Promotion rule 제안: (a) 모든 P0 invariant 통과, (b) 핵심 stem median 개선, (c) 어떤 핵심 stem도 사전 합의한 허용폭 이상 악화되지 않음, (d) worst-decile leakage/seam이 악화되지 않음, (e) VRAM/RTF 예산 내. 정확한 수치는 첫 baseline 측정 후 고정한다.

## 6. AudioForge 개선 우선순위

### P0 — 모델 변경 없이 신뢰성과 실제 품질을 지키는 항목

1. **Inference contract 고정:** model filename/version/hash, library version, sample rate, channels, segment, overlap, shifts, normalization, dtype/subtype을 run metadata에 기록한다.
2. **앙상블 정렬·불변식:** 두 출력의 sample rate/channel/length 검증, offset/polarity/gain 진단, exact-length 반환, finite/peak 검사. 불일치 시 조용히 자르지 말고 단일 모델 fallback 또는 명시적 실패.
3. **Mixture/reconstruction gate:** 2/4 stem 합의 residual RMS·peak를 기록하고 configurable consistency projection을 A/B한다.
4. **장곡 VRAM 경로:** Demucs mix를 CPU에 유지하고 chunk만 GPU에서 처리하는 호출을 synthetic long-stream으로 검증한다. OOM 시 segment 감소→CPU fallback 정책과 취소/cleanup을 함께 확인한다.
5. **품질 회귀 harness:** Tier A와 라이선스 명확한 짧은 Tier B로 length, seam, leakage, phase, transient, SDR/SI-SDR/SIR/SAR를 JSON 저장한다. MP3/무음 제거 전 raw WAV를 평가한다.
6. **가중치 provenance:** 자동 다운로드를 production 기본 동작으로 두지 말고 manifest에 URL, SHA-256, bytes, architecture config, source/weight license를 분리한다. 현재 두 RoFormer checkpoint는 weight license 확인 전 배포 승인 금지.

### P1 — 현 모델에서 품질 상한을 올리는 항목

1. `avg_wave`와 aligned weighted waveform/complex-STFT/median ensemble을 stem별 비교한다.
2. vocal-clean과 instrumental-clean preset을 분리하고 residual complement 방식도 함께 평가한다.
3. Demucs `shifts`, overlap, segment를 품질/RTF/VRAM Pareto로 고정한다. `htdemucs_ft`가 공식상 약 4배 느릴 수 있으므로 이름이 아닌 실측으로 노출한다.
4. multichannel Wiener/softmask 또는 단순 consistency projection을 후처리 후보로 평가한다.
5. model session reuse와 warm-cache lifecycle로 연속 파일 처리의 load latency를 낮춘다.
6. vocal activity/silence-aware gating을 도입해 무보컬 구간의 false vocal을 억제하되, 호흡·잔향을 silence로 오판하지 않는 청취 gate를 둔다.

### P2 — 구조 연구와 기능 확장

1. SCNet의 sparse frequency compression을 4-stem 효율 후보로 재현성/Windows/VRAM과 함께 평가한다.
2. Banquet/query-bandit의 query-based single decoder로 guitar/piano/reeds/organ 등 long-tail stem UX를 연구한다.
3. BSMamba2 계열의 긴 문맥·sparse vocal modeling을 10분 이상 곡과 vocal inactivity metric으로 검증한다.
4. HPSS/NMF/RPCA를 neural separator 대체가 아니라 confidence feature·residual repair·실패 설명에 사용한다.
5. 분리→Whisper 연결은 원곡/분리 보컬/ground-truth vocal을 비교하고, 분리 보컬의 activity boundary를 long-form ASR segmentation에 쓰는 2025 연구를 별도 실험한다.

## 7. 라이선스·재현성 요약

| 자료 | 코드 | 가중치/데이터 | 재현성 판단 |
|---|---|---|---|
| Wave-U-Net official repo | MIT | 제공 checkpoint의 별도 조건 확인 | 오래된 TF/CUDA stack, 원리 참고·fixture baseline |
| Open-Unmix PyTorch | MIT | 공개 MUSDB 계열 checkpoint; 모델별 card/데이터 조건 확인 | 공식 inference/eval이 명확해 Wiener·metric 기준 구현에 적합 |
| Demucs official repo | MIT | pretrained weights와 추가 800곡의 배포/학습 조건 별도 기록 | 코드 공개, repo archived; 현재 제품 baseline이므로 pin 필수 |
| KUIELab MDX-Net submission | MIT | Track A/B가 extra-data 사용 여부를 구분 | reproducible branch를 정확히 고정해야 함 |
| BS/Mel-Band RoFormer paper | 논문 공개; 널리 쓰이는 lucidrains 구현은 재현 구현 | AudioForge가 쓰는 UVR 계열 checkpoint의 출처·weight license 미확인 | 파일명 SDR을 benchmark 사실로 사용 금지 |
| `python-audio-separator` | MIT | wrapper license가 개별 checkpoint 권리를 자동 부여하지 않음 | 버전과 model manifest/hash 고정 필요 |
| SCNet official | MIT | 공식 checkpoint 제공이나 weight license 문구 별도 감사 | 후보 실험 전 SHA-256·Windows·VRAM 확인 |
| Banquet/query-bandit paper | 논문 CC BY 4.0 | code/checkpoint/data 각각 확인 | long-tail stem 연구용, 즉시 production 아님 |
| BSMamba2 (2025) | 논문 확인 | 공식 code/checkpoint/license 확인 필요 | 참고만 가능 |

## 8. 공식 참고자료

- [Harmonic/Percussive Separation Using Median Filtering (DAFx-10)](https://dafx10.iem.at/papers/DerryFitzGerald_DAFx10_P15.pdf)
- [Singing-Voice Separation Using Robust PCA](https://www.mit.edu/~paris/pubs/huang-icassp2012.pdf)
- [Wave-U-Net 공식 저장소](https://github.com/f90/Wave-U-Net)
- [Music Source Separation in the Waveform Domain — Conv-TasNet adaptation/Demucs](https://arxiv.org/abs/1911.13254)
- [Open-Unmix 공식 PyTorch 저장소](https://github.com/sigsep/open-unmix-pytorch)
- [Open-Unmix inference와 multichannel Wiener filtering](https://github.com/sigsep/open-unmix-pytorch/blob/master/docs/inference.md)
- [KUIELab MDX-Net 공식 challenge submission](https://github.com/kuielab/mdx-net-submission)
- [Hybrid Spectrogram and Waveform Source Separation](https://arxiv.org/abs/2111.03600)
- [HTDemucs 공식 저장소](https://github.com/facebookresearch/demucs)
- [HTDemucs 공식 `apply_model` chunk/overlap/shift 구현](https://github.com/facebookresearch/demucs/blob/main/demucs/apply.py)
- [Music Source Separation with Band-Split RoPE Transformer](https://arxiv.org/abs/2309.02612)
- [Mel-Band RoFormer for Music Source Separation](https://arxiv.org/abs/2310.01809)
- [SCNet 논문](https://arxiv.org/abs/2401.13276) / [공식 구현](https://github.com/starrytong/SCNet)
- [Banquet: Stem-Agnostic Single-Decoder MSS](https://arxiv.org/abs/2406.18747) / [공식 구현](https://github.com/kwatcharasupat/query-bandit)
- [Mamba2 Meets Silence](https://arxiv.org/abs/2508.14556)
- [Decoupling Magnitude and Phase Estimation](https://arxiv.org/abs/2109.05418)
- [Differentiable STFT/Mixture Consistency Constraints](https://arxiv.org/abs/1811.08521)
- [Music Separation Enhancement with Generative Modeling](https://arxiv.org/abs/2208.12387)
- [museval / BSS Eval v4 공식 구현](https://github.com/sigsep/sigsep-mus-eval)
- [SDR — half-baked or well done? / SI-SDR](https://arxiv.org/abs/1811.02508)
- [On loss functions and evaluation metrics for MSS](https://arxiv.org/abs/2202.07968)
- [Musical Source Separation Bake-Off: objective metrics vs perception](https://arxiv.org/abs/2507.06917)
- [python-audio-separator 공식 저장소](https://github.com/nomadkaraoke/python-audio-separator)

## 9. 다음 실행 순서

1. 코드 변경 없이 현재 다섯 preset의 inference metadata schema와 Tier A fixture 명세를 확정한다.
2. P0 harness로 현 baseline을 측정하고, 그 결과를 promotion threshold로 동결한다.
3. Demucs CPU-resident mix/chunk-GPU와 aligned ensemble/mixture consistency를 각각 독립 실험한다.
4. P0/P1을 통과한 뒤에만 SCNet/Banquet/BSMamba2 등 새 구조의 checkpoint 실험 승인 여부를 검토한다.

이 순서는 새 모델을 분석에서 제외한다는 뜻이 아니다. 모든 자료는 분석 대상으로 유지하되, 현재 구현에서 검증 가능한 원리를 먼저 적용해 품질 상승 원인을 분리한다.
