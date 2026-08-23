# 대화 처리 기술 계보와 AudioForge 고도화 후보

> 작성일: 2026-08-23  
> 범위: 기술 원리 분석 및 적용 아이디어 추출. 특정 모델의 즉시 탑재 선별이 아니다.  
> 조사 제한: 사용자 미디어·전사 내용·ComfyUI workflow/prompt 미열람, API 호출·모델 다운로드·GPU 추론 없음.

## 1. 결론

AudioForge의 현재 `conversation` 모드는 **음성 대화 분석/화자별 트랙 생성**이다. Silero VAD로 음성 구간을 찾고, 1.5초 창/0.5초 hop의 ECAPA-TDNN 임베딩을 고정된 화자 수로 spectral clustering한 뒤, 10ms 프레임마다 한 화자만 선택하여 원본 파형을 해당 트랙에 복사한다. 선택적으로 각 화자 트랙을 Whisper로 따로 전사한다.

현재 `tts` 모드는 이 경로와 분리된 **단일 대본 기반 음성 합성**이며 감정·참조 음성 제어를 제공한다. 코드에서 등장인물/화자별 대사 역할, 턴 스케줄, 화자별 참조 매핑을 갖춘 다화자 대화 합성기는 확인되지 않았다. 따라서 이 문서의 P0/P1은 입력 대화 분석에 적용하고, 대화 합성은 별도 계약을 먼저 설계해야 한다.

가장 큰 품질 공백은 다음 네 가지다.

1. `argmax` 단일 라벨 때문에 겹쳐 말한 프레임이 한 화자에게만 귀속되며, 이는 음원 분리가 아니다.
2. 사용자가 2~5명 중 정확한 화자 수를 미리 지정해야 하고 unknown/신규 화자 상태가 없다.
3. 클러스터 점수·VAD·경계·전사 단어의 confidence와 구조화된 RTTM/CTM/JSON 산출물이 없다.
4. Whisper 세그먼트와 diarization 턴을 단어 단위로 정합하지 않아 화자 포함 대화문 편집, 경계 수정, 출처 추적이 어렵다.

따라서 우선순위는 **겹침을 손상 없이 표시하는 다중 라벨 타임라인 → word alignment와 화자 귀속 → confidence/unknown/구조화 산출물 → 자동 화자 수와 더 강한 재분할** 순서가 타당하다. 음원 분리 모델은 겹침 구간에만 선택적으로 적용해야 전체 음질 손상과 연산량을 제한할 수 있다.

## 2. 현재 구현 판독

### 2.1 음성 대화 분석 경로

근거 파일은 `python/conversation_worker.py`, `python/separate.py`, `python/transcribe_worker.py`, `src/renderer/components/Options.tsx`, `src/main/ipc/audio.ipc.ts`다.

| 단계 | 현재 동작 | 강점 | 한계 |
|---|---|---|---|
| VAD | Silero, threshold 0.4, 최소 음성 250ms, 최소 무음 100ms, pad 30ms | 명시적 음성 마스크, 짧은 무음 보존 | 고정 임계값, VAD confidence/도메인 보정/경계 hysteresis 기록 없음 |
| 임베딩 | ECAPA-TDNN, 1.5s 창·0.5s hop, speech ratio 0.3 이상 | 검증된 화자 표현, 배치 추론과 OOM CPU fallback | 짧은 턴·중첩 창의 임베딩 오염, overlap 제외 없음 |
| 군집 | cosine affinity + 시간 가중치 + spectral clustering + seed 고정 K-means | 재현 가능, 전역 유사도 사용 | 화자 수 고정, calibration/unknown/제약 군집 없음 |
| 재분할 | 100Hz score map, 500ms median/최소 턴 | 급격한 흔들림 억제 | 500ms 미만 실제 backchannel 손실, 단일 `argmax`라 overlap 표현 불가 |
| 출력 | 화자별 full-length WAV에 담당 프레임 복사, 15ms fade, 최초 등장순 A/B | 타임라인 유지, 후처리 단순 | 실제 source separation이 아닌 마스킹; 누설·겹침·빈 트랙 품질 지표 없음 |
| 전사 | 각 화자 트랙별 Whisper, 선택적 SRT/번역 | 화자별 파일에 기존 ASR 재사용 | 분리 오류가 ASR에 전파, 원본 word timestamp와 화자 턴 정합 없음 |

UI는 대화 모드에서 화자 수 2~5명을 강제 선택한다. IPC는 `nSpeakers || 2`로 전달한다. Python은 결과를 `speaker_a.wav`처럼 최초 등장순으로 명명하므로 세션 간 동일 인물 정체성은 보장되지 않는다.

Whisper 공통 경로는 `condition_on_previous_text=False`, `word_timestamps=True`, `hallucination_silence_threshold=2.0`과 RMS 기반 무음 세그먼트 필터를 사용한다. 무음 환각 억제에는 유리하지만, 출력 저장은 세그먼트 수준 TXT/SRT이며 단어 confidence·speaker attribution을 보존하지 않는다.

### 2.2 TTS 대화 합성과의 경계

`conversation`은 입력 오디오의 “누가 언제 말했는가/화자별 트랙” 문제다. `tts`는 텍스트와 참조 음성에서 음성을 만드는 문제다. 공유 가능한 것은 화자 프로필, 턴 타임라인, 대본 세그먼트 ID, 취소/재개 계약뿐이며 모델 경로를 섞어서는 안 된다.

향후 다화자 대화 TTS는 최소한 `{utterance_id, speaker_id, text, start_hint, emotion, reference_id}` 계약을 갖고, 분석 결과의 익명 `speaker_id`를 사용자가 명시적으로 합성 음색에 매핑하도록 해야 한다. 자동으로 실제 인물의 목소리를 복제하거나 분석 화자를 TTS 참조로 넘기는 것은 별도 동의 경계다.

## 3. 기술 계보와 추출할 원리

### 3.1 GMM/HMM/BIC: 변화점, 군집, 시간 지속성

1990년대 말~2000년대 계열은 MFCC 구간을 Gaussian/GMM으로 모델링하고 BIC/GLR로 변화점을 찾은 뒤 agglomerative clustering과 Viterbi/HMM 재분할을 수행했다. [Tritschler & Gopinath(1999)](https://www.isca-archive.org/eurospeech_1999/tritschler99x_eurospeech.html), [Zhu et al.(2005)](https://www.isca-archive.org/interspeech_2005/zhu05_interspeech.html)은 이 구조를 보여준다.

오늘날 그대로 되돌아갈 필요는 없지만, **시간 전이 확률과 soft assignment로 경계를 반복 보정**하는 원리는 현행의 500ms hard median보다 낫다. 짧은 backchannel을 무조건 합치는 대신 “화자 변경 비용 + 관측 confidence”로 유지/병합을 결정할 수 있다.

### 3.2 i-vector → x-vector/ECAPA: 고정 길이 화자 표현

i-vector는 발화 통계를 total-variability 저차원 공간에 투영했고, PLDA/코사인으로 군집했다. [i-vector spectral clustering](https://www.isca-archive.org/interspeech_2012/shum12_interspeech.html)은 화자 수 추정과 전역 군집을 결합했다. x-vector는 TDNN과 statistics pooling을 화자 분류로 학습해 가변 길이 음성을 고정 벡터로 만들었다. [Snyder et al.(2018)](https://www.danielpovey.com/files/2018_icassp_xvectors.pdf). ECAPA-TDNN은 channel attention, multi-layer aggregation과 attentive statistics pooling으로 이를 강화했으며 AudioForge가 현재 사용하는 계열이다. [ECAPA-TDNN](https://www.isca-archive.org/interspeech_2020/desplanques20_interspeech.html).

적용 원리는 모델 교체보다 먼저 **임베딩 품질 게이트**다. speech duration, overlap probability, SNR proxy가 낮은 창은 centroid 갱신에서 제외하고, 충분한 순수 발화만 화자 prototype으로 삼아야 한다.

### 3.3 VBx: x-vector + Bayesian HMM

VBx는 x-vector의 화자 분별력과 HMM의 시간 연속성을 결합해 hard AHC보다 soft posterior를 반복 정제한다. [Diez et al.(2019)](https://www.isca-archive.org/interspeech_2019/diez19_interspeech.html). 현재 pyannote 공개 pipeline도 segmentation, embedding, PLDA, VBx clustering을 조합하며 일반 diarization과 overlap 없는 exclusive diarization, 화자 embedding을 함께 낼 수 있다. [공식 구현](https://github.com/pyannote/pyannote-audio/blob/main/src/pyannote/audio/pipelines/speaker_diarization.py).

AudioForge에 추출할 핵심은 특정 패키지가 아니라 `frame posterior → temporal transition prior → iterative resegmentation`이다. 기존 ECAPA embedding을 유지한 채 VB-HMM 계열 재분할을 실험할 수 있다.

### 3.4 TS-VAD와 EEND: 목표 화자 활동과 중첩 다중 라벨

TS-VAD는 먼저 얻은 화자 profile마다 프레임별 활동을 예측하므로 겹침에서 여러 화자를 동시에 켤 수 있다. Transformer TS-VAD는 화자 순서에 불변이고 가변 profile 수를 다룬다. [Wang et al.(2022)](https://arxiv.org/abs/2208.13085).

EEND는 diarization을 permutation-invariant multi-label sequence classification으로 직접 학습해 overlap을 명시적으로 표현한다. [Fujita et al.(2019)](https://www.isca-archive.org/interspeech_2019/fujita19_interspeech.html). EEND-EDA/AED-EEND는 attractor 또는 반복 decoding으로 미지 화자 수 문제를 완화하며, EEND-VC/MS-VBx는 chunk 내부 multi-label과 장기 화자 일관성을 군집으로 잇는다. [MS-VBx](https://www.isca-archive.org/interspeech_2023/delcroix23_interspeech.html).

AudioForge에는 1차로 EEND 전체 탑재보다 데이터 계약을 `speaker_label: scalar`에서 `active_speakers: list + probabilities`로 바꾸는 것이 중요하다. 이 계약이 있어야 OSD, TS-VAD, EEND 중 무엇을 시험해도 overlap 정보를 잃지 않는다.

최신 공개 계열인 NVIDIA Sortformer는 permutation-invariant loss 대신 화자의 최초 등장 순서로 출력 열을 정렬하는 arrival-time sorting을 사용한다. streaming 변형은 이전 chunk의 고품질 화자 표현을 Arrival-Order Speaker Cache에 보존해 chunk 간 label consistency를 유지한다. [NeMo 공식 문서](https://github.com/NVIDIA-NeMo/NeMo/blob/main/docs/source/asr/speaker_diarization/models.rst), [Sortformer 논문](https://arxiv.org/abs/2409.06656). 여기서 추출할 원리는 특정 모델보다 **출력 라벨의 결정적 순서 규칙과 명시적 speaker cache**다. 단, 공개 모델의 지원 화자 수 상한과 도메인별 DER 차이는 AudioForge의 2~5명 UI와 그대로 일치하지 않으므로 별도 평가가 필요하다.

### 3.5 overlap detection과 선택적 speech separation

고전 연구에서도 overlap 구간을 임베딩/화자 모델 학습에서 제외하면 DER가 개선되었다. [Boakye et al.(2008)](https://www.isca-archive.org/interspeech_2008/boakye08_interspeech.html). pyannote의 end-to-end segmentation은 VAD·speaker change·OSD를 16ms 수준의 multi-label 문제로 통합하고 overlap-aware resegmentation에 사용한다. [Bredin & Laurent(2021)](https://www.isca-archive.org/interspeech_2021/bredin21_interspeech.html).

OSD는 “누가 말했는가”와 “두 명 이상이 말했는가”를 분리해 다룬다. overlap 검출 후 선택지는 다음 세 단계다.

1. 손실 없는 표기: 원본은 유지하고 두 화자를 동시에 활성화한다.
2. 군집 보호: overlap frame은 prototype/centroid 갱신에서 제외한다.
3. 선택적 분리: overlap 구간에만 PIT/Conv-TasNet/SepFormer/target-speaker extraction 계열을 적용하고, 주변 단일화자 embedding과 permutation을 맞춘다.

현행 전체 파일 마스킹에 바로 분리 모델을 붙이면 separation artifact와 cross-window speaker swap이 생길 수 있다. 현실 조건에서 separation과 clustering을 보완적으로 선택한 연구도 이 위험을 보고했다. [Separation Guided Speaker Diarization](https://arxiv.org/abs/2107.02357).

### 3.6 ASR turn segmentation, word alignment, source attribution

Whisper의 세그먼트 시간은 편집 경계로 쓰기에는 거칠다. WhisperX는 VAD 기반 batch transcription 뒤 phoneme forced alignment로 word timestamp를 만들고 diarization 구간과 단어를 겹침 길이로 결합한다. [공식 저장소](https://github.com/m-bain/whisperX), [화자 할당 구현](https://github.com/m-bain/whisperX/blob/main/whisperx/diarize.py).

권장 내부 단위는 세그먼트 문자열이 아니라 word/token event다.

```text
word_id, text, start, end, asr_confidence,
speaker_candidates[{speaker_id, overlap_ms, posterior}],
source_audio_id, source_interval, diarization_version
```

이후 턴은 word event를 화자 posterior, silence gap, punctuation, semantic completeness로 묶어 만든다. 원본 구간과 처리 버전을 남기면 사용자가 화자를 바꾸거나 경계를 이동해도 source attribution을 잃지 않고 재생·되돌리기가 가능하다.

### 3.7 punctuation/semantic segmentation과 대화 편집

ASR 텍스트의 문장부호 복원은 과거 pause duration/hidden-event LM에서 LSTM과 BERT token classification으로 발전했다. 음향 pause와 텍스트를 결합한 LSTM은 period 복원을 특히 개선했다. [Tilk & Alumäe(2015)](https://www.isca-archive.org/interspeech_2015/tilk15_interspeech.html). BERT 계열은 noisy phone transcript 도메인 적응의 중요성을 보인다. [Fu et al.(2021)](https://aclanthology.org/2021.wnut-1.19/). 최근 long-form ASR 연구는 bidirectional LM으로 의미적으로 완결된 문장 경계를 찾으면 recognition 자체도 개선될 수 있음을 보였다. [Semantic Segmentation for Long-form ASR](https://arxiv.org/abs/2305.18419).

대화 편집에서는 세 종류 경계를 분리 저장해야 한다.

- acoustic turn: VAD/화자 변경으로 생긴 실제 음향 경계
- lexical sentence: 문장부호 복원 경계
- editorial segment: 사용자가 자막·대본 편집을 위해 정한 경계

사용자 편집이 모델 원본을 파괴하지 않도록 correction layer를 delta로 저장하고, split/merge/relabel마다 provenance와 undo stack을 유지한다. 재분석할 때는 확정된 사용자 경계를 lock 또는 soft constraint로 전달한다.

LLM 기반 diarization 후처리는 ASR의 어휘·대화 문맥으로 잘못 붙은 화자 라벨을 재배치하는 연구 방향도 있다. [DiarizationLM](https://arxiv.org/abs/2401.03506). 그러나 음향 근거가 없는 텍스트 추론은 발화 내용을 근거로 화자 정체성을 지어낼 수 있다. 따라서 적용한다면 원본 acoustic posterior를 보존하고, LLM 출력은 자동 확정이 아닌 `suggested correction`으로만 기록하며 WDER와 confidence calibration을 별도로 검증해야 한다.

## 4. AudioForge 개선 후보

### P0 — 정확성과 데이터 손실 방지

1. **다중 라벨 diarization timeline**: `argmax` 전에 frame별 posterior를 보존하고 `overlap=true`, `active_speakers[]`를 산출한다. 기존 speaker WAV는 호환 출력으로 유지한다.
2. **OSD로 centroid 보호**: overlap 가능성이 높은 창을 ECAPA centroid/affinity 계산에서 제외하되, 출력 원본에서는 삭제하지 않는다.
3. **구조화 JSON/RTTM/CTM**: session/turn/word/source interval/version/confidence를 저장하고 TXT/SRT는 파생 산출물로 만든다.
4. **word alignment + speaker attribution**: 원본 한 번 전사/정렬 후 diarization posterior와 단어 구간을 결합한다. 화자별 마스킹 트랙 전사는 비교 baseline으로 남긴다.
5. **confidence와 unknown**: 낮은 posterior margin, 부족한 순수 발화, centroid 거리 초과를 억지로 A~E에 넣지 않고 `UNKNOWN`/`REVIEW`로 노출한다.
6. **짧은 응답 보존**: 500ms hard merge를 제거하거나 confidence 기반으로 바꾸고, “네/응/맞아” 같은 100~500ms backchannel 회수율을 별도 측정한다.

### P1 — 품질 고도화

1. **자동 화자 수**: eigengap/군집 안정도 또는 VBx posterior로 후보 수를 추정하고 UI는 exact 대신 auto/min/max를 제공한다.
2. **VB-HMM/overlap-aware resegmentation**: 기존 ECAPA를 유지한 채 soft temporal decoding을 비교한다.
3. **화자 prototype bank**: 순수·긴 발화만 누적하고 chunk 간 cosine/PLDA calibration으로 speaker consistency를 유지한다. 세션 밖 linking은 기본 비활성/명시 동의.
4. **punctuation + semantic turns**: 음향 경계와 문장 경계를 별도로 계산해 편집 가능한 대화문을 만든다.
5. **overlap 구간 선택적 분리**: OSD 구간+짧은 문맥에만 separation을 적용하고 주변 prototype으로 출력 stream을 재정렬한다.
6. **경계 편집 UI**: 파형 위 다중 화자 lane, overlap hatch, confidence 색상, split/merge/relabel/unknown 확정, 원본 비교 재생과 undo/redo.

### P2 — 연구 트랙

1. EEND-EDA/AED-EEND의 가변 화자 처리와 Sortformer의 고정 capacity·arrival-order cache를 end-to-end diarization 비교축으로 평가.
2. TS-VAD를 prototype refinement용 2차 pass로 사용.
3. EEND-VC/MS-VBx로 long-form chunk 간 화자 permutation 해결.
4. joint speaker-attributed ASR 또는 serialized output training 연구. ASR 품질과 화자 귀속을 cpWER/tcpWER로 함께 평가한다.
5. 다화자 TTS dialogue contract: 분석 speaker ID와 합성 voice ID의 명시적 사용자 매핑, 턴 간 pause/overlap/interrupt 표현, 화자별 일관성 평가.

## 5. 검증 매트릭스

모든 비교는 같은 synthetic/public fixture와 고정 seed/config를 사용하며, 실제 사용자 미디어는 평가셋으로 사용하지 않는다. DER 하나만으로 합격시키지 않는다.

| 축 | fixture/조건 | 지표 | 필수 판정 |
|---|---|---|---|
| VAD | 무음, 잡음, 음악, 작은 음성, 긴 pause | miss/false alarm, onset/offset error | 낮은 음량 진짜 발화 과삭제 없음 |
| 기본 diarization | 1~5화자, 성별/음색 유사 조합 | DER = miss+FA+confusion, JER | collar 0/250ms, overlap 포함/제외를 모두 보고 |
| 화자 수 | true count 1~5 + 미지 화자 진입 | count accuracy, over/under count | exact 강제 baseline보다 평균 DER 비악화 |
| overlap | overlap ratio 0/10/30/50%, 짧은 끼어들기 | overlap precision/recall/F1, overlap DER | 두 화자 동시 라벨 보존; 비중첩 음질 비악화 |
| 화자 일관성 | long-form chunk, 재등장, 채널/잡음 변화 | speaker swap count, cluster purity, linking EER | chunk 경계 swap 별도 보고 |
| ASR | 비중첩/중첩, 다국어, 짧은 backchannel | WER/CER, cpWER 또는 tcpWER, WDER | plain WER와 attribution error 분리 |
| 턴 경계 | 빠른 교대, 100~500ms backchannel | boundary precision/recall/F1@100/250/500ms, latency | 500ms 미만 회수율 별도 보고 |
| 문장/의미 | 불규칙 pause, 무문장부호 ASR | punctuation F1, sentence boundary F1, 편집 횟수 | acoustic/lexical/editorial 경계 혼동 없음 |
| confidence | clean/noisy/OOD | ECE/Brier, risk-coverage, unknown precision/recall | 임계값별 자동확정 오류율 공개 |
| source attribution | split/merge/relabel/재분석 | word→source interval round-trip | 편집 후 원본 재생 구간 일치 |
| long-form | 30/60/120분, 화자 재등장 | peak RAM/VRAM, RTF, 누적 drift, swap | chunk 수 증가에 메모리 선형 증가 금지 |
| 취소 | VAD/embedding/clustering/ASR/write 각 단계 | cancel latency, child process 0, temp residue 0 | 부분 manifest는 `cancelled`, 완성으로 오인 금지 |
| 재개 | 각 checkpoint 직후 중단 | 중복 연산량, 결과 hash/metric parity | config/input fingerprint 일치 시에만 재개 |
| 회귀 | 현행 2화자 turn-taking | DER/JER/WER, output WAV duration | 현재 정상 사례를 golden baseline으로 보존 |

DER은 평가 구간 중 missed speech, false alarm, speaker confusion의 합이다. overlap 포함 여부와 collar 설정에 따라 수치가 크게 달라지므로 반드시 조건을 병기한다. JER은 reference/hypothesis speaker 간 최적 매핑 후 Jaccard error를 평균해 긴 화자에 덜 편향된 보조 관점을 준다. 단어 인식은 WER, 화자 귀속까지는 cpWER/tcpWER 또는 WDER를 함께 사용한다. NeMo의 공식 데이터 문서는 RTTM/UEM과 word-level CTM의 speaker 필드를 평가 계약 예로 제공한다. [NeMo diarization data contract](https://github.com/NVIDIA-NeMo/NeMo/blob/main/docs/source/asr/speaker_diarization/datasets.rst).

## 6. 취소·재개 및 산출물 계약

장시간 파이프라인은 다음 checkpoint를 원자적으로 기록한다.

```text
converted → vad_done → embeddings_done → clustering_done
→ diarization_done → alignment_done → transcript_done → exports_done
```

manifest에는 입력 fingerprint, 단계별 config/model/revision, 시간축 변환, 산출물 hash, 상태(`running|cancelled|failed|complete`)를 둔다. 재개는 fingerprint가 모두 같을 때 다음 미완료 단계부터 수행한다. 취소 시 현재 subprocess tree를 종료하고 이번 run이 만든 임시 경로만 정리하며, 이미 검증된 checkpoint는 보존한다. `complete`는 구조화 timeline과 요청된 파생 출력이 모두 원자 rename된 뒤에만 기록한다.

## 7. 사실·추론·적용 판단 구분

| 항목 | 구분 | 판단 |
|---|---|---|
| 현행은 frame당 한 화자 `argmax` | 코드 사실 | overlap 정보 소실이 구조적으로 발생 |
| 현행 화자 WAV는 원본 마스킹 | 코드 사실 | source separation으로 표현하면 안 됨 |
| OSD frame의 embedding 제외 | 연구 근거 + 적용 추론 | P0 저위험 실험, 출력 음성은 보존 |
| VBx로 현행 spectral clustering 교체 | 연구 근거 + 적용 추론 | P1 A/B 필요; 즉시 우월하다고 단정 금지 |
| WhisperX식 alignment/attribution | 공개 구현 원리 + 적용 추론 | 패키지 탑재와 별개로 word event 계약부터 적용 가능 |
| EEND/TS-VAD가 모든 도메인에서 우월 | 근거 없음 | 데이터/화자 수/overlap mismatch가 커 반드시 평가 필요 |
| separation으로 overlap 완전 해결 | 근거 없음 | artifact, permutation, domain mismatch를 별도 측정 |

## 8. 공식·1차 자료 목록

- Silero VAD 공식 저장소: https://github.com/snakers4/silero-vad
- SpeechBrain ECAPA 공식 모델 출처와 구현: https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb , https://github.com/speechbrain/speechbrain
- ECAPA-TDNN 논문: https://www.isca-archive.org/interspeech_2020/desplanques20_interspeech.html
- x-vector 논문: https://www.danielpovey.com/files/2018_icassp_xvectors.pdf
- VBx 논문: https://www.isca-archive.org/interspeech_2019/diez19_interspeech.html
- EEND 논문/공식 코드: https://www.isca-archive.org/interspeech_2019/fujita19_interspeech.html , https://github.com/hitachi-speech/EEND
- Transformer TS-VAD: https://arxiv.org/abs/2208.13085
- pyannote.audio 논문/공식 코드: https://arxiv.org/abs/1911.01255 , https://github.com/pyannote/pyannote-audio
- WhisperX 논문/공식 코드: https://www.isca-archive.org/interspeech_2023/bain23_interspeech.html , https://github.com/m-bain/whisperX
- NIST Rich Transcription 평가 문서: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication500-257.pdf
- NeMo diarization/RTTM/CTM 공식 문서: https://github.com/NVIDIA-NeMo/NeMo/blob/main/docs/source/asr/speaker_diarization/datasets.rst
- overlap-aware segmentation: https://www.isca-archive.org/interspeech_2021/bredin21_interspeech.html
- punctuation restoration: https://www.isca-archive.org/interspeech_2015/tilk15_interspeech.html

라이선스·모델 약관·오프라인 가능성은 실제 도입 단계에서 **고정 revision별로 다시 감사**해야 한다. 예를 들어 현재 pyannote 공개 pipeline은 모델 사용 조건 동의와 Hugging Face token이 필요할 수 있고, 코드 라이선스와 모델 가중치 약관은 별개다. 이 문서는 다운로드나 도입 승인이 아니다.
