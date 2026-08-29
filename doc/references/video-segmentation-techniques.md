# 영상·장면·트랙 분할 기술 계보와 AudioForge 고도화 후보

> 조사일: 2026-08-23  
> 목적: 특정 모델의 즉시 탑재 선별이 아니라, 고전 신호처리부터 shot/scene/event 계층까지 **작동 원리·품질 기여·검증법**을 추출해 AudioForge 분할 기능을 고도화하기 위한 참고 문서다.  
> 조사 제한: 사용자 영상·이미지·프롬프트·ComfyUI workflow, 외부 API, 모델 다운로드와 GPU 실행을 사용하지 않았다. 현재 저장소는 read-only로 조사했고 production/test/package는 수정하지 않았다.

## 1. 용어와 근거 표기

- **[사실]** 원 논문, 공식 저장소·문서 또는 현재 AudioForge 코드로 직접 확인한 내용.
- **[제작자 보고]** 논문/저장소가 보고한 성능. AudioForge에서 같은 조건으로 재현하기 전에는 제품 성능으로 간주하지 않는다.
- **[추론]** 공개 원리와 현행 구현을 연결한 개선 가설. synthetic/open benchmark 검증 전에는 사실로 취급하지 않는다.
- `track split`은 음원을 곡/구간으로 자르는 현행 기능, `shot boundary`는 카메라 take 사이의 hard cut·gradual transition, `scene boundary`는 여러 shot을 의미적으로 일관된 장면으로 묶는 경계, `event/topic boundary`는 그보다 긴 사건·이야기·주제 단위다. 이 네 층은 같은 문제가 아니다.
- 코드, checkpoint, 학습 데이터와 benchmark 영상의 사용권은 서로 별개다. 저장소 라이선스만으로 가중치·데이터 재배포 가능성을 추론하지 않는다.

## 2. 현재 AudioForge 구현 기준선

### 2.1 실제로 하는 일

**[사실]** 현재 `split`은 일반적인 영상 장면 분할기가 아니다. 입력 컨테이너의 오디오를 다음 두 방식으로 나누고 각 구간을 PCM 16-bit WAV로 재인코딩한다.

1. **수동/붙여넣기 타임스탬프:** `SplitEditor.tsx`가 `M:SS`, `H:MM:SS` 텍스트 또는 파형 marker를 초 단위 `splitMarkers`로 저장하고, `separate.py::_run_split`이 `[0, marker..., duration]` 경계로 추출한다.
2. **무음 자동 감지:** 편집기에서는 이미 디코드한 첫 채널을 50 ms RMS frame으로 분석해 하위 10 percentile 기반 threshold와 1초 이상 무음의 중심을 marker로 만든다. marker 없이 실행하면 Python이 FFmpeg `silencedetect=noise=-35dB:d=1.5`의 무음 중심을 사용하고 인접 경계를 최소 10초 간격으로 거른다.

**[사실]** 출력은 각 구간의 `.wav`와 `.json`, `_tracklist.txt`다. JSON에는 원본 절대 경로, 시작·끝·duration, label, 생성시각을 기록한다. 분할 뒤 각 WAV의 `track-process` 버튼은 Whisper 전사, timestamp text/SRT, 번역을 별도 Python runner에서 생성한다.

**[사실]** 입력 `-ss` 뒤 디코드·PCM 재인코딩을 사용한다. FFmpeg 공식 문서상 transcoding 시 기본 `-accurate_seek`가 seek point부터 요청 시각까지를 디코드해 버리므로 stream-copy보다 정확한 방향이다. 다만 경계 검증은 초 단위 metadata가 아니라 실제 첫/마지막 sample timestamp와 duration으로 해야 한다.

### 2.2 현재 품질 경계

1. **[사실] 영상 신호를 보지 않는다.** hard cut, dissolve/fade, 카메라 이동, flash, 자막·대화·음악 변화는 경계 후보가 아니다. 현행 자동 감지는 “오디오 무음 기반 트랙 분할”로 명명해야 한다.
2. **[사실] 동일 기능에 서로 다른 무음 규칙이 있다.** UI는 adaptive RMS/1초/첫 채널이고 Python은 고정 -35 dB/1.5초/FFmpeg mix 규칙이다. 사용자가 marker를 확정했는지에 따라 결과가 달라질 수 있으며 detector/version/config provenance가 남지 않는다.
3. **[사실] marker validation이 없다.** 음수·duration 초과·중복·비단조·NaN, 너무 짧은 구간을 Python 경계 생성 전에 거부하거나 정규화하지 않는다. 빈/0 duration probe도 명시적 실패로 정착하지 않는다.
4. **[사실] 복수 산출물이 작업 출력 폴더에 즉시 publish된다.** 중간 트랙 실패·취소 시 이미 생성된 WAV/JSON이 남고 `_tracklist.txt`만 없거나 이전 실행의 파일과 섞일 수 있다. 기존 정상 결과를 한 번에 교체하는 atomic publish가 아니다.
5. **[사실] `_extract_tracks_ffmpeg`는 트랙마다 별도 FFmpeg 프로세스를 동기 실행한다.** PythonRunner의 tree kill은 취소 시 자식까지 종료하려 하지만, worker에는 cooperative cancel/checkpoint가 없고 트랙 단위 resume manifest도 없다.
6. **[사실] `trackRunner` IPC는 실행 중 가드, 5분 inactivity watchdog, done 정리와 tree cancel을 갖는다.** 그러나 `audio:process-track` 호출은 spawn 직후 성공으로 반환되는 fire-and-forget 형태다. clean exit인데 result/error가 없거나 전역 cancel이 발생하면 해당 TrackList 행에 terminal event가 전달되지 않아 `processing`이 남을 수 있다. config는 done에서만 지워지며 앱 crash 이후 orphan 청소 규칙이 없다.
7. **[사실] track-process는 `.txt`, `_timestamps.txt`, `.srt`, `_korean.txt`를 제자리에서 순차 write한다.** 실패/취소 시 일부 텍스트만 publish될 수 있고, 재시도·resume가 기존 산출물의 세대와 source fingerprint를 판별하지 않는다.
8. **[사실] 경계 품질 회귀는 없다.** quick smoke는 synthetic audio의 지정 marker 4초/8초 실행 성공만 확인한다. 자동 검출 precision/recall, 실제 출력 경계 오차, A/V sync, 취소 후 부분물, chunk seam을 측정하지 않는다.

## 3. 기술 계보와 품질 기여

### 3.1 고정 길이·키프레임·메타데이터 기준

| 계열 | 작동 원리 | 품질 기여와 한계 | AudioForge 적용 |
|---|---|---|---|
| 고정 길이 | 전체 duration을 일정 초/프레임 수로 자름 | deterministic, 병렬 처리와 resume가 쉬우나 의미 경계를 무시 | 분석 chunk의 1차 partition으로만 사용하고 overlap/context를 둔다. 사용자 최종 scene으로 표시하지 않는다 |
| container chapter/EDL/timestamp | 제작자가 넣은 chapter, cue sheet, 편집 목록을 경계로 사용 | 신뢰 가능한 경우 가장 저렴하고 설명 가능. 누락·오염 가능 | provenance와 우선순위를 가진 `manual/embedded/detected` boundary로 보존 |
| keyframe/GOP | 독립 디코딩 가능한 I-frame/seek point에 맞춰 stream-copy | 매우 빠르고 무손실이나 요청 경계와 어긋날 수 있음 | preview/proxy에는 keyframe snap, 최종 export에는 경계 주변만 재인코딩하거나 전체 accurate transcode. 요청시각·실제시각을 모두 기록 |

**[사실]** FFmpeg는 대부분 형식에서 정확한 위치로 바로 seek할 수 없어 가까운 이전 seek point로 이동한다. transcoding+기본 `accurate_seek`는 그 사이를 decode/discard하지만 stream copy는 보존한다. 따라서 “keyframe 정확도”는 detector 오차와 exporter 오차를 분리해 측정해야 한다.

### 3.2 전통적 shot-boundary detection

| 특징/방법 | 원리 | 강점 | 주요 실패와 보완 |
|---|---|---|---|
| pixel/frame difference | 연속 frame의 절대·제곱 오차가 threshold를 넘으면 cut | 가장 단순·고속 | motion, zoom, flash에 과검출. block/region voting과 motion compensation 필요 |
| color histogram | RGB/HSV/YUV histogram 거리(chi-square, intersection 등) | 위치 변화와 작은 물체 motion에 pixel diff보다 강함 | 같은 색 분포의 다른 장면 누락, flash·조명 변화. 지역 histogram과 adaptive threshold 결합 |
| SSIM/perceptual hash | 구조적 또는 perceptual 유사도가 급락하는 지점 탐지 | 압축·미세 잡음에 비교적 둔감 | 큰 camera motion/occlusion과 진짜 cut 구분 한계. 단독 gate보다 ensemble feature |
| Edge Change Ratio | motion-compensated edge map에서 들어오고 나가는 edge 비율 측정 | 색/밝기 변화보다 구조 변화를 직접 봄 | edge 추출·matching 비용, motion compensation 오류. histogram/temporal pattern과 결합 |
| optical flow/motion vector | 전역 camera motion을 보상한 잔차 또는 flow 불연속 사용 | pan/tilt/zoom과 cut 구분에 도움 | flash, blur, textureless frame, 계산량. coarse flow나 codec motion vector를 보조 feature로 사용 |
| twin/adaptive threshold | 낮은 threshold로 후보 구간을 모으고 누적 변화가 높은 threshold를 넘을 때 gradual transition 판정 | dissolve/wipe처럼 여러 frame에 퍼진 변화 대응 | transition 길이·콘텐츠별 tuning 필요. multi-scale temporal window와 fade 전용 규칙 |
| fade/monochrome detector | 평균 luminance가 단색 frame으로 수렴/발산하는 temporal pattern 검출 | fade-in/out에 설명 가능 | 검은 장면 자체를 별도 shot으로 오인. 양쪽 문맥을 묶어 하나의 transition interval로 정착 |

**[사실]** PySceneDetect 공식 detector는 HSV weighted difference(`ContentDetector`), 그 score의 local rolling-average outlier(`AdaptiveDetector`), RGB intensity 기반 fade(`ThresholdDetector`), Y-channel histogram, perceptual hash를 제공한다. Adaptive 방식은 지속적인 fast motion에서는 local 평균도 높다는 점을 이용해 단일 spike인 cut의 과검출을 줄인다. `FlashFilter`와 최소 scene length도 post-filter의 중요성을 보여준다.

**[추론]** AudioForge의 첫 실용 단계는 새 neural model보다 CPU two-pass ensemble이 적합하다. downscaled frame에서 histogram/HSV/edge/SSIM score를 캐시하고, adaptive local threshold + flash suppression + fade interval detector를 적용한 뒤 사용자가 파형/thumbnail에서 보정하게 한다. 이 feature cache는 이후 TransNet/scene model의 fallback·설명에도 재사용할 수 있다.

### 3.3 neural shot detection

| 기술 | 공개 원리·보고 | 추출할 원리 |
|---|---|---|
| TransNet / TransNetV2 | **[사실]** 연속 frame window의 spatiotemporal feature로 hard/gradual transition을 예측한다. 공식 TransNetV2 저장소는 inference/training/evaluation과 MIT 코드를 제공하고 ClipShots, BBC Planet Earth, RAI 재평가 F1을 공개한다. | 한 frame pair가 아니라 앞뒤 temporal context, hard/gradual 분리 score, overlap window의 중앙부만 publish |
| ClipShots/DSM | **[사실]** 다양한 온라인 영상의 handheld vibration, occlusion, dissolve/fade/slide를 포함하고 공식 저장소에 cut/gradual 별 평가 도구가 있다. | 정적인 방송물만으로 threshold를 맞추지 말고 transition type·도메인별 slice를 둔다 |
| AutoShot 계열 | **[사실]** 짧은 온라인 영상의 다양성과 큰 shot benchmark를 겨냥한다. | 세로형·편집효과·빠른 montage 같은 AudioForge 실제 입력 도메인을 별도 평가 |

**[추론]** neural detector는 P0 안정성 작업 뒤 optional high-quality detector로 넣는다. CPU 전통 detector 후보를 neural score로 rerank하거나, 두 detector의 confidence가 갈릴 때 UI 확인 대상으로 보내면 전체 frame GPU inference와 불투명한 자동 확정보다 안전하다. 모델 버전·가중치 hash·frame sampling·window overlap·threshold를 result metadata에 고정해야 한다.

### 3.4 shot을 scene으로 묶기

shot detector는 편집 cut을 찾을 뿐, 동일 장소의 shot/reverse-shot 대화를 하나의 scene으로 묶지 못한다.

| 기술 | 작동 원리 | AudioForge 적용 |
|---|---|---|
| temporal clustering/graph cut | shot embedding을 node로, 인접/반복 appearance·시간 거리를 edge로 두고 cohesion이 낮은 곳을 scene boundary로 선택 | 반복되는 두 인물 angle을 같은 scene으로 묶고 최소/최대 scene 길이 prior 적용 |
| place/character/action/audio fusion | 장소, 인물, 행동, 음향의 shot-level embedding을 융합 | 화면 cut만 많은 대화·공연에서 audio continuity와 speaker continuity로 과분할 억제 |
| ShotCoL | **[사실]** 가까운 유사 shot을 positive, 무작위 shot을 negative로 삼는 self-supervised contrastive representation을 학습하고 적은 scene label로 fine-tune한다. 논문은 MovieNet에서 약 25% label, 9배 적은 parameter, 7배 빠른 runtime을 보고한다. | 사용자 미디어 학습 없이 공개 representation 원리만 참고. 반복 shot/근거리 cohesion score와 boundary confidence 설계 |
| LGSS | **[사실]** clip/segment/movie의 local-to-global 계층에서 place, audio, human, action, speech 등 multi-modal semantics를 통합한다. 공식 SceneSeg 저장소는 현재 공개 demo가 image input 중심임을 명시한다. | detector의 직접 탑재보다 계층형 data contract와 modality-missing fallback을 채택 |
| scene consistency/boundary-aware SSL | scene 내부 일관성과 scene 사이 판별 또는 pseudo-boundary pretext를 학습 | label이 적은 장르에서 boundary만 감독하는 것보다 shot representation의 cohesion을 함께 측정 |

### 3.5 subtitle/audio-informed boundary

- **[사실]** LGSS와 NewsNet 계열 연구는 visual-only보다 audio/text를 포함한 multi-modal·hierarchical modeling이 긴 영상 segmentation에 유용하다고 보고한다.
- **[추론]** AudioForge에는 이미 waveform, Whisper segment, 대화/화자 처리와 음악 분리 결과가 있으므로 별도 대형 VLM 전에 다음 저비용 score를 만들 수 있다: 장기 무음/음악 cue 변화, speaker-set 변화, transcript topic embedding change, subtitle gap, 장소/색상 변화.
- **[추론]** subtitle gap을 곧바로 경계로 확정하면 무대사 action scene을 놓치고 자막 분절 습관을 장면으로 오인한다. 각 modality는 timestamp와 confidence를 가진 evidence이며, visual cut 후보 근방에서만 boost/veto하는 것이 안전하다.
- **[추론]** 오디오·자막 clock과 video PTS의 offset/drift를 먼저 보정해야 한다. A/V sync가 불명확한 입력은 fusion을 끄고 visual-only 결과와 경고를 남긴다.

### 3.6 장시간 영상의 계층 분할

**[사실]** NewsNet은 900시간 이상 뉴스에 scene/story/topic/event 등 4단계 annotation과 multi-modal 정보를 제공하며, 긴 범위의 story/topic은 하위 event/scene과 계층적으로 모델링할 때 이득이 있음을 보고한다. 고전 hierarchical graph video segmentation은 overlapping clip을 순차 처리하며 일관성을 강제하는 방식으로 긴 영상 확장성을 다뤘다.

**[추론]** AudioForge의 장시간 구조는 다음처럼 분리하는 편이 낫다.

1. decode/index pass: PTS, keyframe, audio clock과 저비용 frame feature를 순차 저장.
2. shot pass: 겹치는 고정 window에서 hard/gradual transition interval과 confidence 생성.
3. scene pass: shot token을 수십 분 context에서 묶되, 앞 chunk의 마지막 context를 다음 chunk에 넘긴다.
4. event/topic pass: scene summary/audio/text cue로 더 긴 계층을 생성한다.
5. user correction layer: 자동 경계를 원본에서 삭제하지 않고 lock/merge/split delta와 provenance로 저장한다.

chunk overlap에서는 양쪽 결과를 단순 합치지 말고 중앙 `valid region`만 publish하고 overlap 내 후보는 one-to-one matching/NMS로 정착한다. resume checkpoint는 feature/index와 미publish 결과까지만 허용하고, detector/config/source fingerprint가 다르면 재사용하지 않는다.

## 4. 권장 데이터 계약

경계 하나를 숫자 배열로만 보관하지 말고 최소 다음 envelope를 사용한다.

```text
Boundary {
  boundaryId, level: track|shot|scene|event|topic,
  transition: cut|fade|dissolve|wipe|silence|manual|unknown,
  startPts, endPts, representativePts,
  requestedPts?, exportedStartPts?, exportedEndPts?,
  confidence, evidence[{modality, detector, score, interval}],
  sourceFingerprint, detectorVersion, configHash,
  provenance: embedded|manual|detected|edited,
  lockState, parentSegmentId
}
```

- gradual transition은 한 점이 아니라 `[startPts,endPts]` interval로 보존한다.
- 시간의 권위는 float second가 아니라 원본 time base의 integer PTS로 두고 UI에서만 초로 변환한다.
- `requestedPts`와 실제 export 경계를 분리해 keyframe snap/encoder rounding을 숨기지 않는다.
- scene/event는 하위 segment를 정확히 덮는 parent이며 overlap/gap 정책을 schema에 명시한다.
- confidence는 calibration dataset과 detector version에 종속된다. 서로 다른 detector의 raw score를 같은 확률처럼 비교하지 않는다.

## 5. 검증 설계

### 5.1 경계 품질

| 항목 | 측정 |
|---|---|
| hard cut | tolerance `±0/1/2/5 frame`별 greedy one-to-one precision/recall/F1. 넓은 tolerance 하나로 frame 정확도 결함을 숨기지 않음 |
| gradual | 예측 interval과 GT interval의 point-in-interval hit, temporal IoU, start/end MAE를 함께 기록 |
| scene/event | boundary F1과 함께 segment covering, over-segmentation/under-segmentation, 평균/분포 길이, hierarchy consistency 측정 |
| confidence | threshold PR curve/AP와 reliability/calibration. 자동확정·확인필요·미확정 band를 별도 평가 |
| runtime | decode 포함 wall time, CPU/GPU peak, feature cache 크기, realtime factor를 영상 길이·해상도별 측정 |

PySceneDetect 공식 benchmark는 hard cut에 configurable frame tolerance를 둔 greedy one-to-one nearest matching, fade에는 point-in-interval matching을 사용한다. AudioForge도 이 규칙을 baseline으로 고정하되 strict 0/1-frame 결과를 항상 함께 남긴다.

### 5.2 반드시 분리할 오류 slice

- hard cut, fade-in/out, dissolve, wipe/slide
- 단발 flash/strobe, black frame, title card
- 빠른 pan/tilt/zoom, handheld shake, motion blur, large occlusion
- 애니메이션, 게임, screen recording, 세로형 short, 낮은 frame rate/VFR
- 동일 장소 shot/reverse-shot, montage, 긴 take, 무대사 action
- audio silence가 있으나 scene은 유지되는 경우와, 무음 없이 scene이 바뀌는 경우
- 자막 gap/화자 변화/음악 cue의 true/false boundary 조합

### 5.3 synthetic/mock 회귀 fixture

사용자 미디어 없이 FFmpeg test source/color/sine/noise로 다음을 생성한다.

1. 색/패턴 clip A/B의 정확한 frame hard cut, 10~30 frame dissolve/fade, wipe.
2. 동일 shot에 1-frame white flash, brightness ramp, pan/zoom, shake를 넣은 negative fixture.
3. video cut과 audio silence/cue change를 일치·불일치시키고 known offset/drift를 넣은 A/V fixture.
4. non-zero start time, VFR, uncommon time base, 긴 GOP를 가진 container로 requested/exported PTS 검증.
5. 고정 길이 chunk 경계 `N-1/N/N+1 frame`에 transition을 배치해 overlap 결과가 중복·누락되지 않는지 검증.
6. track 2/3 FFmpeg mock 실패, 취소, timeout, 앱 restart를 주입해 기존 결과 보존·staging 정리·orphan 탐지 검증.

출력 검사는 boundary JSON만 보지 않는다. 각 segment의 첫/마지막 decoded frame 또는 audio sample timestamp, 합계 duration, gap/overlap, A/V sync, 파일 decode 가능 여부와 manifest hash를 검사한다.

## 6. AudioForge 적용 우선순위

### P0 — 품질 연구 전에 결과 안전성

1. `split`을 UI/문서에서 **오디오 트랙 분할**로 명확히 하고 향후 영상 shot/scene 기능과 구분한다.
2. boundary 정규화: finite, `0 < t < duration`, strictly increasing, epsilon duplicate 병합, minimum segment policy, label cardinality를 main/worker 양쪽에서 검증한다.
3. 실행 전용 staging directory에 WAV/JSON/tracklist를 모두 생성·검증한 후 manifest 단위로 publish한다. 실패·취소 시 이번 job의 staging만 지우고 기존 결과는 보존한다.
4. main split과 `trackRunner`에 jobId/source fingerprint/result generation/terminal event를 부여한다. `process-track`의 spawn acknowledgement와 terminal completion을 분리하고 cancel/clean-no-result에도 해당 행을 정착시킨다.
5. worker/FFmpeg tree 종료 확인 후 cleanup을 수행하고 앱 시작 시 job manifest 기반 orphan staging/config만 정리한다.
6. 위 synthetic failure/cancel/restart fixture를 cross-mode conformance에 추가한다.

### P1 — 저비용 품질 상승

1. 현재 RMS와 FFmpeg silence detector의 config/provenance를 통일하거나 명시적으로 `interactive-preview`/`batch`로 구분하고 결과 차이를 표시한다.
2. visual shot detector CPU baseline: downscale → HSV/Y histogram + SSIM/hash + edge score → adaptive threshold → flash filter → fade interval detector.
3. PTS/keyframe index와 reusable feature cache를 만들고 manual/embedded/silence/visual 후보를 confidence/evidence와 함께 편집기에 겹쳐 표시한다.
4. boundary F1/tolerance, gradual IoU, over/under-segmentation, actual export PTS, A/V sync를 CI의 작은 synthetic gate로 고정한다.
5. long-video chunk overlap/valid-region merge와 detector/config/source fingerprint 기반 resume를 구현한다.

### P2 — 의미 장면·계층 고도화

1. TransNetV2 같은 temporal neural detector와 CPU ensemble을 공개 benchmark에서 비교하고 domain slice별 fallback을 결정한다.
2. shot token에 place/character/audio/speaker/subtitle/topic cue를 결합해 shot grouping과 scene boundary를 분리 구현한다.
3. scene→event→topic parent hierarchy, 사용자 correction delta/lock, confidence calibration을 도입한다.
4. 설명 가능한 evidence panel과 low-confidence review queue를 제공한다. 모델의 자연어 설명은 근거 score를 대체하지 않는다.

## 7. cross-mode job safety 계약에 전달할 항목

- `split` 한 job은 detector/index/extract/publish child job을 가지며 parent cancel은 모든 child를 terminal 상태로 만든 뒤에만 완료된다.
- 복수 산출물의 원자 단위는 개별 WAV가 아니라 `manifest + 모든 segment + metadata` 세대다.
- staging/cache/result ownership을 나누고 cache는 fingerprint/config hash가 맞을 때만 resume한다. cleanup은 job manifest가 소유한 정확한 경로만 삭제한다.
- `trackRunner`는 IPC return을 completion으로 보지 않는다. `accepted(jobId)`와 `completed|failed|cancelled(jobId)`가 필요하며 renderer는 terminal event로만 row 상태를 끝낸다.
- inactivity timeout, per-stage timeout, 전체 hard deadline을 분리한다. 긴 무음·긴 scene 자체는 inactivity가 아니며 worker heartbeat/progress authority를 정의한다.
- detector 결과와 실제 export 경계를 별도 보존한다. export 실패가 detector 결과를 오염시키지 않고, 이전 publish 세대도 덮어쓰지 않는다.
- 앱 restart에서 running manifest는 orphan으로 판정하되, source/result를 삭제하지 않고 staging 검증 후 resume 가능/폐기 가능 상태로 노출한다.
- 원본 절대 경로·자막/전사 본문은 일반 progress/log/telemetry에 넣지 않는다. source ID/fingerprint와 allowlisted metadata만 사용한다.

## 8. 공개 참고자료와 재현성·라이선스 메모

- [PySceneDetect detector 공식 문서](https://www.scenedetect.com/docs/latest/api/detectors.html), [공식 benchmark](https://www.scenedetect.com/benchmarks/): Content/Adaptive/Threshold/Histogram/Hash, flash filtering과 TRECVID식 평가. 공식 GitHub 프로젝트의 코드는 BSD-3-Clause이며 실제 도입 시 고정 version의 LICENSE를 재확인한다.
- [TransNetV2 공식 저장소](https://github.com/soCzech/TransNetV2), [논문](https://arxiv.org/abs/2008.04838): inference/training/evaluation, MIT 코드. checkpoint와 학습·평가 영상의 권리는 별도 확인한다.
- [ClipShots 공식 저장소](https://github.com/Tangshitao/ClipShots), [DSM 논문](https://arxiv.org/abs/1808.04234): cut/gradual annotation과 평가 도구, 저장소 MIT. 포함 영상의 제품 재배포 권리와 학습 이용 조건은 별도 감사한다.
- [ShotCoL CVPR 2021 논문](https://openaccess.thecvf.com/content/CVPR2021/html/Chen_Shot_Contrastive_Self-Supervised_Learning_for_Scene_Boundary_Detection_CVPR_2021_paper.html): self-supervised shot representation과 scene/ad cue boundary. 논문 원리 참고 단계이며 공식 code/checkpoint license가 확인되기 전 탑재하지 않는다.
- [LGSS CVPR 2020 논문](https://openaccess.thecvf.com/content_CVPR_2020/html/Rao_A_Local-to-Global_Approach_to_Multi-Modal_Movie_Scene_Segmentation_CVPR_2020_paper.html), [공식 SceneSeg 저장소](https://github.com/AnyiRao/SceneSeg): multi-modal local-to-global scene segmentation. MovieNet 영상/annotation 권리는 별도 확인한다.
- [NewsNet CVPR 2023 논문](https://openaccess.thecvf.com/content/CVPR2023/html/Wu_NewsNet_A_Novel_Dataset_for_Hierarchical_Temporal_Segmentation_CVPR_2023_paper.html): scene/story/topic/event 계층과 multi-modal long-form benchmark. dataset 사용 조건은 다운로드 전 별도 확인한다.
- [FFmpeg 공식 문서](https://ffmpeg.org/ffmpeg.html): `-ss`, `-accurate_seek`, timestamp/keyframe 동작. AudioForge 배포 FFmpeg의 exact version과 LGPL/GPL build configuration을 manifest에 고정한다.
- [Shot-boundary 방법론 review](https://pmc.ncbi.nlm.nih.gov/articles/PMC7512729/): histogram, edge, motion, hard/gradual transition 계보와 실패 유형을 교차 확인하는 보조 문헌.

## 9. 결론

현행 기능의 가장 큰 품질 오해는 “영상 분할”이라는 이름 아래 **오디오 무음/수동 marker 분할**과 **시각 shot·의미 scene·장기 event 분할**이 섞여 있다는 점이다. 즉시 효과가 큰 순서는 모델 교체가 아니라 (1) 경계·시간축 schema, (2) 복수 출력 atomic publish와 terminal lifecycle, (3) synthetic boundary/export gate, (4) CPU 전통 detector baseline, (5) temporal neural shot detector, (6) audio/text/visual scene grouping이다. 오래된 histogram·edge·fade 규칙은 최신 모델의 대체재만이 아니라 flash/camera-motion 방어, 설명 가능한 evidence, CPU fallback과 회귀 oracle로 계속 가치가 있다.
