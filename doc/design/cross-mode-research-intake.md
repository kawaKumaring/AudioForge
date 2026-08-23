# Cross-Mode Research Intake (요약표 · DOC ONLY)

브랜치: `design/cross-mode-job-safety-contract`(origin/develop `b933ab5` 기준). 동반 계약: `cross-mode-job-safety-contract.md`.
목적: 완료된 기술 조사(음악·대화·텍스트)를 job-safety 계약 절과 fixture로 연결하는 intake 표. 영상 분할은 조사 진행 중.

사실 등급: [F] 코드/문서 확인 · [I] 적용 추론 · [R] 후속 슬롯. 원문·전사·prompt 본문은 이 문서에 넣지 않는다.
"현재 실제 동작"은 develop `b933ab5` 코드 대조로 확인한 사실이다.

## 요약표

| 기능 | 현재 실제 동작[F] | 가장 큰 품질 손실 | P0 | P1 | P2 | 필요한 fixture | 적용 계약 절 | reference 문서 |
|---|---|---|---|---|---|---|---|---|
| 음악 분리 | `separate.py` 5 preset(htdemucs·htdemucs_ft·roformer·roformer_melband·roformer_ensemble). 앙상블=`music_worker.run_roformer_ensemble`의 stem별 0.5/0.5 파형 평균. mixture consistency·정렬·manifest 없음 | 앙상블이 sr/offset/polarity/gain 검증 없이 최소 길이·채널로 잘라 평균 → transient·고역 흐림·leakage 증가 | ①inference contract 고정(model·hash·sr·segment·overlap·shifts·dtype) ②앙상블 정합 검증(불일치 시 조용한 truncate 금지) ③mixture/reconstruction gate ④weight provenance(URL·SHA-256·license) | ①aligned/complex-STFT/median ensemble stem별 비교 ②vocal-clean/instrumental-clean+residual preset ③shifts/overlap/segment Pareto ④Wiener/consistency 후처리 | ①SCNet sparse-freq ②Banquet query-bandit ③BSMamba2 긴문맥 ④HPSS/NMF/RPCA를 confidence feature로 | Tier A synthetic(impulse·sweep·polarity·pan·silence→vocal·동시 onset·상이 sr/mono) + 라이선스 명확 짧은 multitrack | §21 manifest · §22 two-phase(다중 stem) · §24 MUS1–4 · §8 품질 metric | music-separation-techniques.md |
| 대화 처리 | `conversation_worker.py`: Silero VAD + ECAPA-TDNN(1.5s/0.5s) + spectral clustering + 10ms frame **단일 화자 argmax 마스킹**. 고정 n_speakers(2~5). 선택적 화자별 Whisper | argmax 단일 라벨이 **겹침 프레임을 한 화자에만 귀속**(분리 아님, overlap 정보 소실) + unknown/confidence/구조화 산출 부재 | ①다중 라벨 timeline(active_speakers[]+posterior) ②OSD로 centroid 보호 ③구조화 RTTM/CTM/JSON ④word alignment+attribution ⑤UNKNOWN/REVIEW ⑥짧은 backchannel 보존 | ①자동 화자 수 ②VB-HMM/overlap resegmentation ③화자 prototype bank ④punctuation/semantic turns ⑤overlap 선택적 분리 ⑥경계 편집 UI | ①EEND/Sortformer 비교 ②TS-VAD refine ③MS-VBx long-form ④speaker-attributed ASR ⑤다화자 TTS dialogue contract | 1~5화자·유사음색·overlap 0/10/30/50%·짧은 끼어들기·long-form 재등장 synthetic + RTTM/CTM GT | §20 KIND(analysis) · §25 DLG1–6 · §23 PROV · §9 checkpoint | dialogue-processing-techniques.md |
| 텍스트 추출 | `transcribe_worker.py`: OpenAI Whisper(small~large-v3-turbo) **오디오 ASR**(이미지 OCR 아님). condition_on_previous_text=False·word_timestamps=True·hallucination 2.0. `_filter_silent_segments` RMS 0.005. TXT/타임라인/선택 SRT/번역 | 고정 RMS가 저음량 실발화 삭제/반주 위 환각 잔존 + raw score·provenance·SRT cue 규칙(겹침/CPS/2줄) 부재 | ①canonical segment+raw score+filter 사유 sidecar ②SRT sanitizer(clamp·sort·overlap/0 제거·punct/CPS/CJK 분할) ③RMS에 noise-floor 상대점수 ④track-process 저장 중복 제거 | ①VAD+forced alignment(WER/timing 분리) ②cue 교정 UI+low-conf queue ③subtitle demux/burned-in OCR ④ko/ja/zh 혼합 profile+Unicode 보존 ⑤CPU/GPU CER·RTF | ①DeepSolo++/Paddle 곡선 text ②GoMatching tracker ③PP-Structure/Donut layout ④recognizer ensemble/calibration ⑤화면 OCR↔ASR 시간 교차검증 | A0x(무음·저음량·반주위 tone·반복·다국어) + S0x(역전/겹침/0길이·CPS·번역 cue) synthetic + GT | §20 KIND(analysis) · §26 TXT1–5 · §23 PROV · §27 CF03/CF12 | text-extraction-techniques.md |
| 영상 분할 | **조사 진행 중** — 문서 미도착 | [R] | [R] | [R] | [R] | [R] | §28 placeholder(trackRunner P0-1·shot/scene 경계·two-phase·resume·cleanup) | (도착 시 추가) |

## 세 분야 P0 요약 (계약 반영 우선순위)

- **공통(모든 모드)**: §21 artifact manifest · §22 다중 산출 two-phase publish · §23 provenance+confidence 분리금지 · §14 metadata 민감정보 제외.
- **음악**: inference contract 고정 · 앙상블 정합 검증(조용한 truncate 금지) · mixture gate · weight provenance.
- **대화**: 다중 라벨(overlap 보존) · 구조화 RTTM/CTM · word attribution · UNKNOWN/REVIEW · "분리 아님" [F] 명시.
- **텍스트**: canonical segment+sidecar · SRT sanitizer · "OCR 아님, Whisper ASR" [F] 명시 · 저음량 오삭제 방지.

## 미결정 (fixture·수치 확정 대기)

- 각 모드 promotion threshold(SDR/DER/WER 등)는 첫 baseline 측정 후 동결 — 현재 미확정.
- 앙상블/분리/전사의 resume 가능 조건(§9)은 결정성·산출 원자성 확보 시 — 모드별 판정 필요.
- 영상 분할 계약 전체(§28) — 조사 완료 후.
- video OCR과 ASR의 artifact kind 경계 세부(§26 TXT4) — OCR 도입 시.

## 안정선·범위

DOC ONLY. production/test/package 무변경. develop/master/expression-integration 무병합. `8481930` amend 없이 후속 커밋으로만 추가.
