# 텍스트 추출 기술 조사와 AudioForge 적용 후보

> 조사일: 2026-08-23  
> 범위: 공개 논문·공식 저장소·공식 문서의 원리 분석. 모델 다운로드, API, GPU, 사용자 미디어, ComfyUI 자료에는 접근하지 않았다.  
> 원칙: 크기·현재 실행 가능성은 분석 대상 제외 조건이 아니다. 기술 원리 추출과 실제 탑재 판단을 분리한다.

## 1. 결론

AudioForge의 현재 `텍스트 추출`은 이미지 OCR이 아니라 **오디오 Whisper 전사**다. 환각 억제와 TXT·타임라인·SRT 출력은 이미 있으나, 세그먼트 신뢰도/provenance, 자막용 cue 재분할, 시간 교정, 영상 프레임 OCR·추적은 없다.

우선순위는 다음과 같다.

1. **P0:** Whisper 원시 세그먼트·단어 시간·점수·필터 사유를 sidecar JSON에 보존하고 모든 출력이 하나의 canonical segment list를 쓰게 한다.
2. **P0:** 겹침·역전·0길이 cue를 막고 문장부호·침묵·글자수·CPS로 자막 cue를 재분할한다.
3. **P1:** 영상은 프레임별 독립 OCR이 아니라 keyframe 검출 → text tracking → 여러 프레임 인식 융합 → 출현 시간 복원의 구조로 도입한다.
4. OCR 1차 비교는 **전처리+Tesseract CPU baseline**과 **PaddleOCR 방향/왜곡 보정+검출+한·일·중·영 인식**이다. CRAFT, DBNet, TrOCR, PARSeq, Donut, DeepSolo, GoMatching은 전체 탑재 여부가 아니라 각 품질 원리를 추출한다.

표기: **[코드 사실]**은 저장소 확인, **[공식 사실]**은 논문/공식 자료, **[적용 추론]**은 검증 전 AudioForge 제안이다. 제작사 수치는 AudioForge 성능으로 전이해 표현하지 않는다.

## 2. 현재 구현 감사

### 현재 경로와 강점 — [코드 사실]

- `python/transcribe_worker.py`가 OpenAI Whisper `small/medium/large-v3/large-v3-turbo`로 오디오를 전사한다. 언어는 자동 또는 `ko/en/ja/zh` 강제다.
- `run_transcribe()`는 `condition_on_previous_text=False`, `word_timestamps=True`, `hallucination_silence_threshold=2.0`을 쓴다.
- `_filter_silent_segments()`는 세그먼트별 원본 RMS가 `0.005` 미만이면 제거하되 60% 초과 삭제 상황에서는 원본을 유지한다. 보존 세그먼트로 전체 text도 재구성한다.
- 음악 모드는 보컬 stem만, 대화/분할은 트랙별 전사가 가능하다.
- TXT, `[start → end]` 타임라인, 선택적 SRT와 한국어 번역을 저장한다. 번역 타임라인은 번호 기반 1:1 정합 실패 시 NLLB로 폴백한다.
- 참조 음성 전사는 구조화된 `ok/empty/failed`와 경로·size·mtime·모델 캐시를 갖는다.
- UI는 원문/번역 펼치기와 복사는 지원하지만 cue별 재생·수정·낮은 신뢰도 검토는 없다.
- 프레임/문서 OCR, bitmap subtitle demux/OCR, scene-text tracking 구현과 런타임 의존성은 발견되지 않았다.

Whisper 공식 구현은 이전 창 문맥을 끄면 반복 루프/타임스탬프 이탈이 줄 수 있으며, 단어 시간은 cross-attention+DTW, hallucination threshold는 의심 환각 주변 무음을 건너뛴다고 설명한다. 현재 구현 방향은 공식 경로와 맞는다. [Whisper transcribe 구현](https://github.com/openai/whisper/blob/main/whisper/transcribe.py)

### 위험과 누락 — [코드 사실 + 적용 추론]

- 고정 RMS는 저음량 실제 발화를 버리거나 잔류 반주 위 환각을 살릴 수 있다. 60% guard는 소수 오삭제를 잡지 못한다.
- `avg_logprob`, `no_speech_prob`, `compression_ratio`, 단어 probability, 제거 사유가 결과에서 사라진다.
- SRT는 Whisper 세그먼트를 그대로 써 글자수, 두 줄, CPS, 최소/최대 지속시간, cue gap을 보장하지 않는다.
- 일반 전사와 track-process 저장 코드가 중복된다.
- raw prediction, 수동 correction, 재실행 결과와 engine/model/device provenance가 분리되지 않는다.
- 파일 전체 언어 하나로 코드 스위칭을 표현할 수 없고, 현재 `Track`에는 영상 좌표·시간 provenance가 없다.

## 3. 기술 계보와 품질 기여

### 전통 OCR: 이진화·deskew·연결요소

grayscale/채널 선택 → Otsu·Adaptive Otsu·Sauvola → morphology → connected components/contours → 크기·종횡비·stroke filtering → Hough/projection deskew → EXIF/90도 방향·원근 보정 → 여백 crop·작은 글자 확대 순서다.

Tesseract 공식 품질 문서는 Tesseract 5의 Adaptive Otsu/Sauvola, 침식·팽창, deskew, border 영향을 명시한다. [Tesseract ImproveQuality](https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md) Tesseract는 Apache-2.0이다. [공식 문서 저장소](https://github.com/tesseract-ocr/tessdoc)

**기여:** CPU fallback, 결정성, 실패 시각화, 선명한 UI/자막의 저비용 baseline.  
**적용:** 같은 crop의 raw/CLAHE/Sauvola/2x/invert 변형을 저신뢰 때만 재시도하고 합의로 고른다.

### 검출: CRAFT·DBNet·PaddleOCR

- **CRAFT [공식 사실]:** 문자 region과 문자 사이 affinity score를 예측하고 binary map에서 polygon을 얻는다. 곡선/불규칙 line 검출 원리가 중요하다. 공식 코드는 MIT지만 전체 훈련 코드는 IP 사유로 미공개다. [CRAFT 공식 저장소](https://github.com/clovaai/CRAFT-pytorch)
- **DBNet [공식 사실]:** segmentation network 내부의 differentiable binarization으로 thresholding을 학습한다. 빠른 임의 모양 검출과 precision/recall 조절이 핵심이다. [논문](https://arxiv.org/abs/1911.08947) 원 저자 저장소는 오래된 CUDA/DCN 요구사항이며 명확한 루트 라이선스가 없어 직접 복사·배포 대상으로 삼지 않는다. [공식 저장소](https://github.com/MhLiao/DB)
- **PaddleOCR [공식 사실]:** 방향 분류, unwarping, text-line orientation, 검출과 인식을 조합하는 Apache-2.0 pipeline이다. PP-OCRv5 문서는 한국어 전용 모델을 포함한 106개 언어를 명시한다. 제작사의 세대 간 향상 수치는 별도 재검증 대상이다. [공식 저장소](https://github.com/PaddlePaddle/PaddleOCR), [다국어 문서](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.en.md)

**적용 추론:** 첫 neural baseline은 재현성과 다국어 구성이 좋은 PaddleOCR로 잡되 Windows 패키징, CPU 지연, 모델 weight 라이선스를 별도 감사한다. DB 원 코드 대신 PaddleOCR/MMOCR 구현을 비교한다. MMOCR 배포표에는 DBNet의 ONNX Runtime/TensorRT/ncnn/OpenVINO 경로가 있다. [MMDeploy 표](https://github.com/open-mmlab/mmdeploy/blob/main/docs/en/04-supported-codebases/mmocr.md)

### 인식: CRNN/CTC·TrOCR·PARSeq

- CRNN/CTC는 빠르고 보수적인 baseline이며 ONNX/CPU 경로가 성숙했다. MMOCR는 detector와 recognizer를 표준 인터페이스로 분리한다. [MMOCR](https://github.com/open-mmlab/mmocr)
- TrOCR는 image Transformer encoder와 text Transformer decoder로 wordpiece를 생성한다. 인쇄/필기에 강하지만 생성형 decoder의 그럴듯한 오인식도 별도 측정해야 한다. [Microsoft Research](https://www.microsoft.com/en-us/research/publication/trocr-transformer-based-optical-character-recognition-with-pre-trained-models/)
- PARSeq는 permuted autoregressive 학습으로 양방향 문맥을 이용하면서 외부 LM 비용을 피한다. 공식 구현은 문자 logits/confidence를 노출하며 대부분 Apache-2.0이다. [PARSeq](https://github.com/baudm/parseq)

**적용 추론:** recognizer를 `crop -> text, token scores, script, orientation, model_id` 계약으로 감싼다. 저신뢰만 다른 전처리/인식기로 재판정하고 불일치는 자동 확정하지 않는다.

### OCR-free 문서 이해: Donut

Donut은 Swin encoder와 multilingual BART decoder로 이미지에서 구조화 sequence를 직접 만들며 SynthDoG 합성기를 포함한다(MIT). [Donut](https://github.com/clovaai/donut) 폼/영수증 구조화에는 유용하지만 생성 환각과 좌표 provenance 약화가 있어 일반 영상 자막 기본값이 아니라 문서 profile 연구 대상이다.

### End-to-end spotting

DeepSolo는 explicit point query의 DETR-like decoder에서 곡선 text detection+recognition을 함께 하고, DeepSolo++는 script identification·다국어로 확장한다. [공식 저장소](https://github.com/ViTAE-Transformer/DeepSolo), [논문](https://arxiv.org/abs/2211.10772) 스타일 효과음/간판 연구에는 유용하나 첫 자막 구현은 모듈식 pipeline이 디버깅·CPU fallback·provenance에 유리하다.

### Video tracking과 temporal fusion

필요한 상태는 `(track_id, first/last seen, polygons, frame observations, fused_text, confidence)`다.

1. 장면 전환+주기 sampling으로 keyframe 선택
2. detector 실행 후 IoU·중심 이동·appearance/semantic feature로 연결
3. 단기 공간 일치와 장기 의미 일치로 track 유지
4. sharpness·글자 크기·정면성·confidence가 좋은 여러 crop 선택
5. 문자 alignment majority vote 또는 edit-distance medoid로 text 융합
6. 안정 검출의 출현/소멸을 hysteresis로 cue 시간화

Semantic-Aware Video Text Detection은 semantic feature tracking을, GoMatching은 long/short-term matching을 제안한다. [CVPR 2021](https://openaccess.thecvf.com/content/CVPR2021/html/Feng_Semantic-Aware_Video_Text_Detection_CVPR_2021_paper.html), [GoMatching](https://github.com/Hxyz-123/GoMatching) CoText는 contrastive representation으로 장기 프레임 정보를 모델링한다. [CoText](https://arxiv.org/abs/2207.08417)

**적용 추론:** Paddle/DB detector + 경량 tracker + multi-frame consensus로 먼저 검증한다. detector를 매 프레임 호출하지 않고, dedupe는 문자열뿐 아니라 위치·시간 gap·scene boundary를 함께 쓴다.

### Subtitle extraction

- PGS/VobSub/DVB 등 bitmap subtitle은 컨테이너에서 bitmap과 timecode를 직접 demux해 timing을 보존한다.
- burned-in subtitle만 frame ROI·change detection·OCR·tracking이 필요하다. 세로/상단/노래방 자막은 고정 하단 ROI를 해제한다.

Subtitle Edit는 PGS, VobSub, DVB, BDN XML, Matroska/MP4 bitmap subtitle OCR과 Tesseract/nOCR 교정을 지원한다. [공식 OCR 문서](https://github.com/SubtitleEdit/subtitleedit/blob/main/docs/features/ocr.md) 이 프로젝트는 GPL-3.0이므로 UX/형식 원리 참고와 코드 결합을 구분한다.

### ASR timing

WhisperX는 VAD 후 Whisper를 실행하고 wav2vec2 계열 phoneme model로 forced alignment하며 선택적으로 diarization을 결합한다. [공식 저장소](https://github.com/m-bain/whisperX), [Interspeech 논문](https://www.isca-archive.org/interspeech_2023/bain23_interspeech.pdf)

**적용 추론:** 전체 교체 전에 VAD probability 보존, 문자 인식과 timing 평가 분리, alignment 실패 시 Whisper timestamp fallback+`timing_source` 기록을 이식한다. 대화 분리 결과는 기존 speaker track identity를 우선한다.

## 4. 다국어·layout·신뢰도

- 한 화면에 Hangul/Kana/Kanji/Hans/Hant/Latin이 섞인다. script와 language를 하나로 합치지 않는다.
- 원문 Unicode는 보존하고 NFKC·전각/반각·공백 정규화 문자열은 검색/dedupe용 별도 필드로 둔다.
- 세로쓰기와 90도 회전을 구분한다. 일본어/중국어의 공유 한자 비율만으로 언어를 덮어쓰지 않는다.
- 좌상단 정렬은 다단 문서·말풍선·세로쓰기에서 실패한다. PP-StructureV3는 layout region, 다단 reading order, 표/수식/차트와 Markdown을 제공한다. [공식 문서](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PP-StructureV3.html)
- detector score, token softmax, Whisper logprob는 곧바로 같은 “확률”이 아니다. held-out fixture의 reliability/ECE를 보고 temperature scaling 같은 calibration을 적용한다. [Guo et al.](https://proceedings.mlr.press/v70/guo17a.html)
- 결과는 `accept / review / suppress-with-reason`으로 나누고 suppress도 삭제하지 않는다.

최소 provenance 필드:

```json
{
  "source": {"kind": "audio|video-frame|bitmap-subtitle|image|document", "sha256": "..."},
  "engine": {"detector": "...", "recognizer": "...", "versions": {}, "device": "cpu|gpu"},
  "region": {"track_id": "...", "polygon": [], "frame_indices": [], "start_ms": 0, "end_ms": 0},
  "text": {"raw": "...", "normalized": "...", "corrected": null, "language": "...", "script": "..."},
  "scores": {"raw": {}, "calibrated": null, "temporal_agreement": null},
  "decision": {"state": "accept|review|suppress", "reasons": []},
  "timing_source": "container|tracker|whisper|forced-alignment|manual"
}
```

## 5. 자막 timing·dedupe 정책

- OCR track 안에서 위치가 같고 normalized edit similarity가 높으며 gap이 짧을 때만 병합한다.
- fade 관측은 경계에는 쓰되 text vote 가중치를 낮춘다. scene boundary 양쪽의 같은 문장은 분리한다.
- karaoke 누적 글자는 substring 기반 monotonic-growth profile로 cue 폭증을 막는다.
- ASR은 word time이 있으면 문장부호·침묵·CJK grapheme·CPS·최대 두 줄을 함께 고려한다.
- `start < end`, media 범위, non-overlap, 최소 gap을 강제한다.
- 번역은 원문 cue ID/time을 유지하며 번역 모델이 cue 수를 바꾸게 하지 않는다.
- WER/CER 외에 timestamp MAE, boundary F1, CPS 위반, overlap/zero duration을 잰다. SubER는 `<eol>/<eob>`를 포함한 segmentation-aware 평가를 제공한다. [SubER](https://github.com/apptek/SubER)

## 6. CPU/GPU와 교정 UX

- CPU: OpenCV/Leptonica 전처리, Tesseract, Paddle mobile/ONNX/OpenVINO 후보. GPU: server detector/recognizer, ASR, alignment. keyframe·ROI·batch와 저신뢰 재시도로 비용을 제한한다.
- CPU fallback이 품질 profile을 조용히 바꾸면 안 된다. engine/device/model/profile을 manifest에 남긴다.
- 교정 UI는 cue↔타임라인 이동, 구간 반복 재생, frame crop/polygon/관측 비교, 낮은 신뢰도 필터, raw 불변+correction 별도, undo, 일괄교정 preview, 재실행 diff 병합을 지원해야 한다.

## 7. 개선 후보

### P0

1. Whisper raw → normalize/filter → TXT/timeline/SRT/translation/UI가 하나의 segment list 사용.
2. word/segment time과 raw scores, energy/VAD, suppress 사유, model/language/device sidecar 저장.
3. SRT sanitizer/segmenter: clamp, sort, overlap/zero 제거, punctuation/silence/CPS/CJK 분할.
4. fixed RMS에 noise floor/peak 대비 상대 점수를 추가 비교하고 저음량 발화 오삭제 fixture 고정.
5. CJK/Latin 혼합의 공백·구두점 결정적 재조립과 track-process 저장 중복 제거.

### P1

1. VAD+선택적 forced alignment 연구 gate; WER와 timing을 분리 평가.
2. cue 교정 UI와 provenance/낮은 신뢰도 queue.
3. subtitle stream probe → bitmap demux/OCR 또는 burned-in keyframe OCR → tracking/consensus.
4. `ko/ja/zh-Hans/zh-Hant/mixed` profile과 Unicode 원문 보존.
5. 동일 corpus CPU/GPU CER·timing·RAM/VRAM·RTF benchmark.

### P2

1. DeepSolo++와 modular Paddle pipeline의 곡선/스타일 text 비교.
2. GoMatching식 long/short-term matcher로 이동·가림·재등장 안정화.
3. PP-StructureV3/Donut 문서·스크린샷 구조화와 reading order.
4. recognizer ensemble/calibration 및 교정 기반 active learning.
5. 화면 OCR과 ASR의 시간 overlap 교차검증. 간판과 대사처럼 다른 내용을 강제 병합하지 않는다.

## 8. Synthetic 검증 매트릭스

사용자 자료 없이 합성 WAV/무음, 폰트·도형, ffmpeg color source로 생성하고 seed·GT를 보존한다.

| ID | 합성 입력 | 핵심 단언 | 지표/우선순위 |
|---|---|---|---|
| A01 | 2/10/60초 무음 | accept text 0, suppress 사유 보존 | false chars/min, P0 |
| A02 | -35/-45 dB 발화+무음 | 실제 발화 보존 | recall/CER, P0 |
| A03 | 무음 위 tone/반주 | energy 단독 우회 방어 | false chars/min, P0 |
| A04 | 같은 구절 반복 | 시간 진행, n-gram loop flag | duplicate ratio, P0 |
| A05 | ko/ja/zh/en 짧은 음성 | 강제 언어 보존, auto 기록 | lang accuracy/CER, P0 |
| A06 | ko↔ja 혼합 | 구간 불확실·원문 보존 | span CER, P1 |
| A07 | 단어 경계 tone anchor | timing source/fallback 기록 | MAE/p95 ms, P1 |
| S01 | 역전·겹침·0길이 segment | monotonic/non-overlap/positive | violation=0, P0 |
| S02 | 80자 CJK·긴 영어 | grapheme/word cue split | CPS/line violation=0, P0 |
| S03 | 5 cue+번역 줄수 오류 mock | cue ID/time 100% 유지 | mapping, P0 |
| O01 | 저대비/gradient/반전 | best preprocessing 보존 | CER delta, P1 |
| O02 | ±1/3/7/15°, 90/180/270° | angle·text·polygon | angle/CER, P1 |
| O03 | perspective/curved warp | unwarp 효과 분리 | CER delta, P1/P2 |
| O04 | 6~32 px, blur/JPEG | 크기별 성능곡선 | recall/CER, P1 |
| O05 | 한글/가나/한자/라틴 혼합 | raw Unicode round-trip | script CER, P1 |
| O06 | 세로 일본어+가로 주석 | orientation/order 분리 | order edit, P2 |
| O07 | 2/3단·표·제목·각주 | block/order/parent 보존 | order/table, P2 |
| V01 | 5초 고정 자막+fade | cue 1개 | duplicates/boundary, P1 |
| V02 | 누적 karaoke | monotonic-growth track | fragmentation, P1 |
| V03 | 이동/회전+가림 | track 유지/명시 split | IDF1, P2 |
| V04 | scene 양쪽 동일 text | scene에서 분리 | false merge=0, P1 |
| V05 | frame별 1글자 noise | fused CER 개선 | CER delta, P1 |
| V06 | bitmap+container time mock | container timing 우선 | exact match, P1 |
| C01 | 과신 logits | calibration 후 ECE 감소 | ECE/Brier, P1 |
| U01 | raw→교정→재실행 | correction 유실 0, undo | data loss=0, P1 |
| R01 | CPU/GPU 동일 fixture | profile 기록·결과 diff | RAM/VRAM/RTF/CER, P1 |

P0 invariant인 시간 역전 0, 0길이 cue 0, 수동교정 유실 0, source support 없는 accept 0은 절대 기준이다. OCR은 detection H-mean/CER, video는 IDF1·fragmentation·boundary error, ASR은 WER/CER·non-speech false chars를 분리하고 언어·크기·회전·blur 최악 bucket도 보고한다.

## 9. 라이선스·재현성

| 자료 | 관찰 | 적용 분류 |
|---|---|---|
| Tesseract | Apache-2.0, CPU/문서 성숙 | 직접/변형 baseline |
| CRAFT | MIT 추론, 전체 훈련 미공개 | 추론 비교·재현 제한 |
| DB 원 repo | 라이선스 불명확, 오래된 CUDA/DCN | 원리만; 직접 복사 금지 |
| PaddleOCR | Apache-2.0, weight/data 별도 확인 | 1차 neural 비교 |
| MMOCR/MMDeploy | Apache 계열, upstream 고지 확인 | 배포 비교 harness |
| PARSeq | 대부분 Apache-2.0, NOTICE | recognizer/confidence 연구 |
| TrOCR | 공개 논문/모델, checkpoint 조건 확인 | 인쇄/필기 비교 |
| Donut/SynthDoG | MIT, checkpoint/data 조건 확인 | 문서 구조 연구 |
| DeepSolo/GoMatching | 공개 repo, 기반 코드/weight/data 감사 필요 | spotting/tracking 연구 |
| Whisper | MIT 코드, 현재 사용 | 기존 ASR 개선 |
| WhisperX | BSD 계열, pyannote/CTC 등 전이 조건 | VAD/alignment 연구 |
| Subtitle Edit | GPL-3.0 | UX/형식 분석, 코드 결합 주의 |

도입 승인 시 코드, checkpoint, 학습 데이터, 폰트, transitive dependency, 배포 방식을 따로 확인한다.

## 10. 연구 순서

1. 모델 없이 canonical segment/SRT/provenance contract와 synthetic invariant를 고정한다.
2. 현재 Whisper raw score 보존과 RMS 실패군을 측정한다.
3. Tesseract+전처리와 PaddleOCR를 동일 synthetic OCR corpus에서 CPU/GPU 비교한다.
4. burned-in subtitle tracker/temporal consensus를 recognizer와 분리해 mock 관측으로 검증한다.
5. forced alignment, PARSeq/TrOCR, DeepSolo/GoMatching, Donut/PP-Structure를 각각 timing·recognition·곡선·layout 실패군에 비교한다.
6. 사용자 자료 검증은 별도 명시 승인 후 수행한다.

목적은 최신 모델을 고르는 것이 아니라 **어느 기술이 어느 실패를 줄였는지 증명 가능한 구조**를 만드는 것이다.
