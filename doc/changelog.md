# AudioForge Changelog

## 2026-07-24 — 화자 분리 속도 개선 (M-2 잔여분, 새 의존성 0)

- **임베딩 배치 추론**: 슬라이딩 윈도우를 1개씩 GPU 호출하던 것을 같은 길이 청크끼리
  묶어 배치(32) 추론. 동일 길이만 한 배치로 넣어 패딩이 없으므로 개별 추론과 결과 동일
- **Gaussian 확률맵 벡터화**: Step 5 프레임×화자 이중 파이썬 루프를 numpy 슬라이스 누적으로
  교체 (유예됐던 "M-2 Gaussian 벡터화" — 부동소수 순서 우려 해소)
- **결과 동일성 검증**(격리 테스트, kmeans 무작위성과 무관):
  - Gaussian 벡터화: 기존 루프와 scores/weights **완전 동일**(bit-identical), 프레임 라벨 동일 (n=2/3/5)
  - 배치 임베딩: 개별 추론 대비 최대 오차 1.7e-4, 자기 코사인 0.99999994 — 클러스터링 영향 없음
- 효과: 1시간 통화의 임베딩 추출/후처리 구간 대폭 단축. numpy/기존 speechbrain만 사용
- 참고: `_kmeans` 무작위 시드 미고정(L-7)은 이번 범위 밖 — 실행마다 미세 변동은 그대로

## 2026-07-24 — 품질 로드맵 §9-2 후속: 로컬 LLM 번역 백엔드 (Qwen2.5-3B)

- 번역 백엔드에 로컬 LLM(Qwen2.5-3B-Instruct) 추가 — JA→KO 구어체·문맥 번역이 NLLB보다 나음
- **환경 리스크 없음**: 이미 설치된 transformers(4.57.3, qwen2 지원)+torch를 그대로 재사용.
  새 venv·빌드·설치 없음. 모델(~6GB)은 HF 캐시에 최초 1회 다운로드(NLLB와 동일 방식)
- 백엔드만 교체하는 최소 변경: `translate_to_korean`을 디스패처로,
  `_translate_nllb`(기존)/`_translate_llm`(신규)로 분리. `set_translate_model`이
  config `translateModel` 값으로 라우팅('llm'/'qwen3b'→LLM, 그 외→NLLB 600m/1.3b)
- LLM은 문장을 ~1200자 청크로 묶어 한 번에 번역(문맥 유지 + generate 호출 감소),
  그리디 디코딩(결정적) + "번역문만 출력" 시스템 프롬프트
- UI: 번역 셀렉터에 'LLM' 버튼 추가(600M/1.3B/LLM), hover 힌트로 특성·다운로드 용량 안내
- **VRAM**: Qwen 3B(bf16 ~6GB) + Whisper(~3GB) 공존, 16GB 내 여유
- 검증: py_compile + TS 빌드 + 디스패치 라우팅 6종(모델 로드 없음) + transformers 호환 확인.
  **번역 품질은 실제 GPU 추론+청취로 사용자 검증 필요**(NLLB 1.3B 사례와 동일 원칙)

## 2026-07-05 — 환경 탐지/설치 구조 + 의존성 프레이밍 정정

- **프레이밍 정정**: 의존 대상은 ComfyUI 앱이 아니라 그 안에 설치된 AI 패키지들
  (코드 전수 확인 — 쓰는 건 python.exe 경로뿐, API/노드/모델 미사용)
- python/env_check.py: 환경 doctor (필수 패키지/ffmpeg/CUDA 점검, 단일 목록 소스)
- python/setup_env.py: 파이썬 해석/설치 (attach 우선 → 없으면 전용 venv,
  빌린 환경엔 자동설치 금지, env.json 기록)
- audio.ipc.ts: 하드코딩 경로 → resolvePythonPath (env.json → 기본값 → 시스템)
- .gitignore: externals/ 전체 무시 (venv·모델·env.json 머신별 자산)
- doc/environment.md 신규: 의존성·해석 구조·이식성 체크리스트·한계
- architecture/features/code-review 문서의 "ComfyUI 종속" 표현 정정

## 2026-07-05 — 품질 로드맵 §9-4 (RoFormer 보컬 분리)

- 음악 분리에 BS-RoFormer(SDR 12.97) 보컬/반주 2트랙 옵션 추가
- audio-separator+onnxruntime이 ComfyUI 환경에 이미 설치돼 있어 **환경 리스크 없음**
  (§9-7 격리 우려 해소) — 새 venv/설치 불필요
- music 모드 선택: 기본4트랙 / 고품질4트랙 / 보컬2트랙(RoFormer)
- 모델 610MB는 externals/separator_models 캐싱(gitignore). 15초 ~5초(GPU)
- 스모크 테스트에 music(RoFormer) 추가 → 7 PASS
- TrackList에 instrumental(반주) 색상 추가

## 2026-07-05 — 품질 로드맵 §9-2 (번역 모델 선택)

- NLLB 모델 선택 옵션 추가 (600M 기본 / 1.3B) — config/store/UI 배선, 캐시 무효화 처리
- **실측 결론**: 1.3B는 신뢰할 만한 개선 아님 (일부 문장 오히려 환각 심화) → 선택 옵션으로만
  제공, 기본 600M 유지, UI 라벨 중립화("고품질"→"1.3B"). 강제 다운로드 없음
- 진짜 번역 품질 레버는 LLM(문맥 인지) — 외부 서비스 결정 필요로 사용자 대기

## 2026-07-05 — 품질 로드맵 §9-1/§9-3/§9-5

### 9-1 Whisper 환각 대책
- condition_on_previous_text=False로 분리/무음 트랙의 반복 환각 억제
- 언어 강제 옵션(자동/한국어/영어/일본어/중국어) UI + config 배선

### 9-3 스모크 테스트 (python/smoke_test.py)
- 6개 모드 + 번역 경로를 result까지 검증, C-1 회귀 감지 설계

### 9-5 GPT-SoVITS 한국어 TTS 완성
- **VS Build Tools 없이 해결**: jieba_fast→jieba shim, eunjeon→python-mecab-ko shim
  (프리빌트 cp312 휠), 둘 다 격리 venv에 생성
- v2 사전학습 모델 다운로드(~1GB), 재현용 python/setup_gptsovits.py 작성
- 브리지 재작성: torchaudio soundfile 패치, sys.path/chdir 정리,
  run() (sr,ndarray) 튜플 파싱 버그 수정, all_ko 언어 매핑
- 참조 음성 Whisper 자동 전사(prompt_text)로 클로닝 품질 향상 + ref-free 폴백
- 검증: 스모크 tts PASS (7/7). 청취 품질은 사용자 검증 필요
- tts-setup-guide.md 전면 갱신

### 9-5 후속: 일본어 참조 대응 + 품질 한계 확정 (TTS 정리)
- fast_langdetect(lid.176.bin) 셋업 추가 (일본어/중국어 언어 구분)
- pyopenjtalk 미설치 graceful fallback: 일본어 출력=명확한 에러, 일본어 참조=ref-free 강등
- **사용자 청취 결과**: speaker_b(분리 조각) 클로닝 품질 낮음 → 참조 음원 한계로 진단
- 파인튜닝 검토: C++ 컴파일러 부재(pyopenjtalk 빌드 불가) + 데이터 부족(~20초 조각)으로 보류
- 언어별 지원 확정: 한/영/중 출력 = 빌드 불필요 동작, 일본어 = pyopenjtalk 빌드 필요
- 사용자 결정으로 TTS 여기서 정리 (재개 조건: VS Build Tools + 1~3분 깨끗한 화자 음성)

## 2026-07-05 — 리뷰 후속 수정 12건 (커밋별 1건 + 테스트)

### Critical
- **번역 torch import 누락 복구** (C-1): 번역 옵션 100% 크래시 해소
- **stdout JSON 라인 버퍼링** (C-3): 64KB 청크 분할로 result 유실 → 99% 멈춤 증상 방지. StringDecoder로 한글 분할도 방어. 1MB JSON 통합 테스트
- **TTS 엔진 캐싱** (C-2): 문장마다 모델 재로딩(10문장=10회) → 1회. Kokoro `or True` 제거

### High
- **track-process config화** (H-1): 한글 경로 spawn 인자 마지막 잔존 경로 제거
- **torchaudio 패치 지연 로딩** (H-2): 전 모드 시작 시 torch 10-30초 로딩 제거 (split 모드 e2e 0.78초)
- **trackRunner 수명 관리 + audio:track-error 채널** (H-3): 가사/번역 버튼 '처리 중' 고착/연타 누적/취소 불가 해소 (구 BUG-5/6 종결)

### Medium
- **NLLB CJK 문장 분리 + 400자 하드 청크** (M-3): 일본어 번역 조용한 유실 차단
- **TTSEditor 상태 store 초기화** (M-6): 모드 전환 시 대사 유실 방지
- **ffmpeg 실패 감지** (M-5): 손상 파일/디스크 부족 시 '완료!' 대신 명확한 에러
- **SplitEditor 리스너 정확 해제** (M-7) + **get_device daemon 스레드** (M-8)
- **트랙 분할 입력 시킹** (M-4): 곡마다 처음부터 디코딩 제거 (10.000s/42.459s 정확 검증)
- **화자 분리 루프 불변 최적화** (M-2 안전 부분): 중심 재계산 제거 + O(1) 인덱스 (통화 52초 e2e 검증)

### 문서/환경
- requirements.txt 실사용 기준 재작성 (pyannote 제거, whisper/speechbrain/f5-tts/kokoro 추가)
- architecture.md 현행화 (TTS 계층 반영, 구조 문제 목록 갱신)
- dev-guide.md 구버그 6건 종결 표기 — 버그 단일 소스는 code-review-2026-07-05.md
- 보류 항목: M-1(F5 ref_text — 청취 검증 필요), M-2 벡터화(동일성 검증 체계 필요), L-1~11

## 2026-07-05 — 전체 코드 리뷰 (4,330줄 전수)

- **doc/code-review-2026-07-05.md 작성**: Critical 3건(번역 torch NameError, TTS 문장별 모델 재로딩, stdout JSON 라인 버퍼링 부재) + High 3건 + Medium 8건 + Low 11건, 수정 우선순위 로드맵 포함
- dev-guide.md 잔존 버그 6건 재검증: BUG-1/2/3/4는 이미 해결/무효, BUG-5 잔존, BUG-6 부분 잔존
- 문서-코드 불일치 확인: architecture/dev-guide/changelog가 TTS 추가(커밋 15개분) 이전에서 정지 상태
- 참고: 이 changelog 아래 항목들은 TTS 관련 커밋(감정 50개, 엔진 추상화, GPT-SoVITS 등)을 누락하고 있음 — 차기 갱신 시 보완 필요

## 2026-04-12 — 성능 최적화 + 구조 정리

### 트랙 분할 최적화
- 타임스탬프 분할: ffmpeg 직접 추출 (WAV 변환/메모리 로딩 불필요, 80분 파일 ~30초)
- 자동 감지: ffmpeg silencedetect 필터로 교체 (Python RMS 분석 제거)
- 파일명에 곡 제목 포함 (`01_恋愛サーキュレーション.wav`)
- JSON 메타데이터 + 오디오 태그 내장 + meta-fix 모드
- `_tracklist.txt` 자동 저장 (트랙번호 + 타임스탬프 + 제목)
- 이전 결과 폴더 열기 (앱 재시작 후 복원)
- 첫 번째 트랙 제목 정상 적용

### 성능 개선
- NLLB-200 GPU 가속 + 모델 캐싱 (3-5배 빠른 번역)
- Whisper 모델 크기 선택 (Small/Medium/Large)
- Demucs 모델 선택 (htdemucs 기본 / htdemucs_ft 고품질)
- 처리 시간 예측 표시
- 대화 분리 2-5명 화자 지원

### Python 모듈 분리
- separate.py (1231줄) → 5개 파일로 분리
  - separate.py (486줄): CLI 라우팅 + 후처리
  - audio_utils.py (155줄): I/O, ffmpeg, 유틸
  - music_worker.py (70줄): Demucs
  - conversation_worker.py (377줄): 화자 분리
  - transcribe_worker.py (139줄): Whisper + NLLB

### UX 개선
- 파일 정보 + 파형 통합 카드
- 탭 형태 모드 선택 (4개)
- 접이식 옵션 (활성 뱃지 미리보기)
- 결과 화면 재처리 버튼
- 트랙별 개별 가사/번역 버튼
- 노래방 모드: drums+bass+other 동시 재생

### 인터랙티브 트랙 분할 에디터
- wavesurfer.js + Regions 플러그인
- 타임스탬프 붙여넣기 파싱 (다양한 포맷 지원)
- 자동 감지 결과 수정 가능
- 마커: 더블클릭 추가, 드래그 조정, 5초 미리듣기, 삭제
- 트랙 번호 표시

### 버그 수정
- ffprobe 경로: dirname+join (replace가 폴더명 깨뜨림)
- 임시 파일명: input→source (ffmpeg 동일 파일 충돌)
- sys.path.insert: 모듈 import 실패 방지
- MP4/MKV/AVI/MOV/WebM 영상 파일 지원

### 미완료 (롤백됨)
- split_worker.py 분리: 테스트 없이 진행하여 기능 고장 → 롤백
- 교훈: 한 파일씩 분리 → 테스트 → 커밋 순서 필수

## 2026-04-12 — UX 개선 + 트랙 분할 + Phase 2

### Phase 2 기능
- **NLLB-200 한국어 번역**: 28개 언어 → 한국어 자동 번역
- **SRT 자막 내보내기**: Whisper 타임스탬프 → 표준 SRT 포맷

## 2026-04-11 — Phase 1 + 핵심 기능

### Phase 1 기능
- 텍스트 단독 추출 모드, 클립보드 복사, 출력 포맷 선택
- 노래방 모드, 시간별 출력 폴더

### 대화 분리 v3
- Silero VAD + ECAPA-TDNN + 스펙트럴 클러스터링
- 슬라이딩 윈도우 + 프레임별 확률 맵 + 시간 스무딩

### 버그 수정
- 드래그앤드롭 (webUtils), 한글 경로 (-X utf8)
- Windows symlink, Tailwind v4 레이아웃

## 2026-04-11 — 초기 생성
- Electron + React + TypeScript 프로젝트
- Demucs 음악 분리, ECAPA-TDNN 대화 분리
- wavesurfer.js 파형, 무음 구간 제거
