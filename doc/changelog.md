# AudioForge Changelog

## 2026-08-16 — LLM 잔재 글자 NLLB 수리 + 구글 번역 백엔드

실제 앙상블+LLM 실행 산출물 확인 결과: 최악(중국어 문장·영어 통째)은 사라졌으나 36줄 중 9줄에
원문 한 글자(`風`, `致`, `스スキ`)가 잔존 → Qwen2.5-3B가 문장은 옮기되 가끔 한 글자를 베낌.

- **LLM 잔재 글자 수리**(`_translate_segments_llm` 후단): LLM 출력에 한자/가나가 남은 줄만
  NLLB로 재번역(NLLB는 JA→KO 혼입 없음). 깨끗한 줄은 LLM 그대로. 검증: 한자 줄만 교체·나머지 유지.
- **구글 번역 백엔드 추가**(`translateModel: 'google'`): 비공식 무료 엔드포인트(`translate_a/single`)
  를 `requests`로 호출 — **새 패키지 0**. 세그먼트별 1:1, 실패 시 NLLB 폴백. `set_translate_model`
  ·`translate_to_korean`·`translate_segments_to_korean` 분기 추가. UI '구글' 버튼(툴팁에 네트워크·
  프라이버시·비공식 고지). **검증(네트워크)**: 일본어 5세그 모두 깨끗한 한국어, CJK 잔재 0.
- **정직한 고지**: 구글은 (1)네트워크 필수(오프라인 원칙 이탈) (2)전사 텍스트가 구글로 전송(프라이버시)
  (3)비공식이라 막힘/레이트리밋 가능 → 그때 NLLB 폴백. 로컬 원칙 유지가 필요하면 NLLB/LLM 사용.
- py_compile·TSC OK.

## 2026-08-16 — 유틸 검증 후속: 에너지 게이트(아웃로 환각) + Mel-Band 단일 모드

유틸로 before/after를 수치 측정한 뒤(아래) 드러난 한계를 보완.

- **환각 검증(유틸)**: 실제 스템으로 옛/새 비교 → `hallucination_silence_threshold`는 **무음이
  있을 때만** 작동. 인트로 `作詞・作曲…`는 제거됐지만(총 성공), 아웃로 `ご視聴…`는 [235-265s]→
  [249-250.4s]로 줄되 **잔존**. 순수 악기 트랙(drums 7→6, other 16→5)은 덜 줄지만 음악 모드는
  보컬만 전사라 무관.
- **에너지 게이트 추가**(`_filter_silent_segments`, `run_transcribe` 단일 지점): 세그먼트 구간의
  실제 오디오 RMS가 임계(0.005) 미만이면 환각으로 간주해 폐기. **측정 근거**: 진짜 무음 RMS≈0.0002
  ≪ 실제 가사 RMS≈0.11 (세 자릿수 차이) → 임계 0.005는 양쪽 20배 이상 여유. 과삭제 가드(60% 초과
  삭제 시 원본 유지). **검증**: 실제 스템 재전사 → 인트로·아웃로 환각 0, 진짜 가사 35줄 보존.
- **번역 검증(유틸)**: 같은 41줄에서 한자/가나 혼입 16 + 영어 3 → **0 + 0** 확정.
- **Mel-Band 단일 분리 모드 추가**(`roformer_melband`): bleed 측정에서 **단일 Mel-Band FT2
  bleedless가 앙상블보다 잔음↓·2배 빠름**(인트로 bleed RMS: BS 0.0474 / Mel-Band 0.0466 /
  앙상블 0.0469 — 앙상블은 두 모델의 산술평균이라 더 나은 단일을 못 이김)이라 별도 모드로 노출.
  `run_roformer_separation(model_name)` 일반화 + 강건 스템 매칭(대소문자·other). UI 3택
  (보컬 2트랙/Mel-Band/앙상블), 타입 유니온 확장.
- **정직한 한계**: 앙상블의 이론상 이점(무상관 오차 상쇄)은 reference 없어 수치 증명 불가 —
  소스마다 유불리 달라 최종 선택은 귀. py_compile·TSC OK.

## 2026-08-16 — 보컬 앙상블 (BS-RoFormer + Mel-Band 2모델, 잔음 최소)

목적: "보컬 추출 한계 돌파". 조사 결과 SOTA는 RoFormer 계열이고, 단일 모델 교체보다
**아키텍처가 다른 두 모델의 앙상블이 잔음·bleed 감소에 지각적으로 크다**는 결론.

- **새 분리 모드 `roformer_ensemble`** — `music_worker.run_roformer_ensemble`.
  BS-RoFormer(`ep_317`, SDR 12.98) + Mel-Band(`kim_ft2_bleedless_unwa`, bleed 억제 특화)를
  각각 돌려 **보컬/반주를 파형 평균(avg_wave)** 한다. 두 모델을 임시 폴더에 따로 분리 후 섞음.
- 스템 명명이 모델마다 달라(BS=`(Vocals)/(Instrumental)`, Mel-Band=`(vocals)/(other)`)
  대소문자 무시 + 반주 명칭 변형(other/no vocals/accompan) 인식으로 매칭.
- UI: 분리 앵커에 '보컬 앙상블' 버튼 추가(툴팁: 잔음 최소, 2배 느림). 타입 유니온 확장.
- audio-separator 0.44.2가 두 모델 모두 네이티브 지원 — **새 의존성 0**, Kim FT2 ckpt만 첫 실행 시
  `externals/separator_models`에 다운로드(gitignore).
- 검증: 실곡(250초)으로 실행 → 보컬/반주 스템 생성(각 44MB), 스테레오 44.1k·250.4초·
  피크<1.0(클리핑 없음)·NaN 없음 확인. py_compile·TSC OK.
- **한계(정직)**: SDR 이득은 reference 스템이 없어 수치 검증 불가 — 앙상블은 SDR이 아니라
  아티팩트 감소가 목적이라 최종 품질 판단은 귀로 해야 한다. 커뮤니티 ckpt(Kim FT2)는 상업
  라이선스 불명확(개인 사용 무방).

## 2026-08-16 — Whisper 환각 억제 + 타임라인 번역 한 번에(언어 혼입 제거)

실사용 산출물(`F:/Download/AudioForge_output`)에서 두 결함을 근거로 확인해 수정.

- **원인 A — "作詞・作曲…"·"ご視聴ありがとうございました"는 파일 정보가 아니라 Whisper 환각.**
  무음/연주 구간(예: 반주만 있는 29초 인트로)에서 모델이 학습 자막의 상투 문구를 지어냄.
  결정적 증거: 반주 트랙(bass/drums/other)이 통째로 환각(`音楽`/`BGM`/`me me me`/시청 감사)이었고
  29초 균일 세그먼트가 지문. → **`run_transcribe`에 환각 억제 추가**: `word_timestamps=True` +
  `hallucination_silence_threshold=2.0`(무음 위 지어낸 세그먼트 폐기). 음악 모드는 보컬 스템만
  전사하므로 인트로/아웃로가 실제로 거의 무음 → 특히 잘 듣는다. `condition_on_previous_text=False`는 유지.
- **원인 B — 타임라인 번역이 뒤죽박죽(중국어·영어 혼입)인 건 '줄마다 따로' LLM 번역 탓.**
  `異郷の月`처럼 3~4글자 조각은 문맥이 없어 소형 LLM(Qwen)이 자기 우세 언어(중국어)로 흐르거나
  원문을 못 지움. → **`write_translation_timeline`을 '전 세그먼트 한 번에 번역'으로 교체.**
  새 `translate_segments_to_korean`: NLLB는 세그먼트별(안정적·혼입 없음), LLM은 번호 매겨 청크 단위로
  한 번에 번역 후 번호로 1:1 되돌림 + 정합 실패 시 그 청크만 NLLB 폴백(언어 혼입·유실 방지).
- 검증: 문제의 실제 파일로 재생성 시 41/41 줄 정합 + 한자/가나 혼입 0(NLLB 경로),
  LLM 번호-파싱·불일치 폴백 단위검증 PASS. `py_compile` OK.

## 2026-08-16 — 트랙 재생 버튼 원위치 복귀 + 전환 중첩 버그 수정

- **재생 버튼을 원래 위치(트랙 행 오른쪽)에 고정** — 재생 시 숨기고 좌측하단에 새 버튼을 띄우던 것을,
  같은 자리에서 **아이콘만 ▶↔❚❚**로 바꾸도록 변경(사용자 의견). 플레이어 내부 재생 버튼 제거(중복 방지).
  재생/일시정지는 행 버튼이 `paused` prop으로 제어(TrackPlayer는 준비된 뒤 반영), 정지/닫기는 플레이어의 ✕.
- **전환 시 중첩 재생 버그 수정** — A 재생 중 B를 틀면 A가 안 꺼지고, 다시 켜면 중복되던 문제.
  원인: 언마운트 시 `destroy()`만으로 재생이 확실히 멈추지 않아 이전 wavesurfer가 잔존.
  **cleanup을 `pause()` 후 `destroy()`(try/catch)로 강화** — 전환·재활성 시 이전 인스턴스 확실 종료.
- 일시정지는 언마운트가 아니라 `ws.pause()`라 재생성 없음 → 중첩 원천 차단. 검증: TSC 무에러.

## 2026-08-16 — 세션 저장/복원 (재분리 없이 이전 결과 불러오기)

동기: 툴 재시작 시 이전 결과·설정을 보려면 매번 다시 분리해야 했음.

- **완료 시 `session.json` 저장**: 출력 폴더(`AudioForge_output/<타임스탬프>_<곡명>/`)에 원본 경로·모드·
  옵션(분리모델/Whisper/번역백엔드/언어/무음/출력포맷/화자수 등)·트랙 목록·생성시각을 매니페스트로 저장.
  폴더가 자기완결적 — 이동해도 정보 보존 (`audio.ipc.ts` result 핸들러).
- **불러올 때 자동 감지**: 노래를 열면 `<원본폴더>/AudioForge_output/*/session.json`을 훑어 **원본이
  일치하는 최신 세션**을 찾음(`audio:find-session`). 트랙 파일이 실제로 남아 있는 것만 유효.
- **안내 후 선택(권장안)**: 이전 결과가 있으면 배너로 "다시 분리하지 않고 불러올까요? [불러오기]/[새로 분리]"
  표시(자동 즉시 복원 아님). 불러오기 → 설정+트랙을 원자적으로 복원(`restoreSession`), status=done.
- 배선: `store.restorable`/`restoreSession`, `preload.findSession`, `DropZone` 로드 후 탐색, `App` 배너.
- 기존 수동 "이전 결과 폴더 열기"(`restore-from-folder`)는 그대로 유지 — 이번 건 자동 감지 + 설정 복원 추가.
- 검증: TSC 무에러. 실제 감지/복원은 빌드 후 확인 필요.

## 2026-08-16 — 결과 트랙 재생기: 파형 + 시간 + 볼륨 + 드래그 이동

- **결과 트랙 재생을 밋밋한 `new Audio` → wavesurfer 파형 플레이어로 교체**. 재생 버튼을 누르면
  트랙 아래로 **파형 + `현재/전체 시간` + 재생/일시정지 + 볼륨(듣기 전용) + 드래그 이동**이
  펼쳐짐(상단 파일 카드와 동일한 결). 트랙 색을 파형/컨트롤에 반영.
- 새 `TrackPlayer` 컴포넌트(`TrackList.tsx`). **재생 시에만 지연 생성** — 트랙 4개를 동시에
  디코드하지 않음. 접히면 wavesurfer destroy(누수 방지). 한 번에 한 트랙만 재생(기존 semantics 유지).
- 볼륨은 `setVolume`(Web Audio 게인) — 원본 파일 미변경. 드래그 이동은 `dragToSeek`.
- 기존 `new Audio`/audioRef 경로 및 L-11 언마운트 정리 제거(플레이어가 자체 정리). 검증: TSC 무에러.

## 2026-08-16 — 타임라인 번역 파일 생성 (_korean_timeline.txt)

- **번역 시 세그먼트별 타임라인 번역 파일 추가**: `{base}_korean_timeline.txt`
  (`[0:01 → 0:03] 번역문` 형식). 전사 타임라인(`_timestamps.txt`)을 세그먼트별로 번역.
- 재사용 헬퍼 `write_translation_timeline(output_dir, base, src_lang)` 신설
  (`transcribe_worker.py`). `_save_transcription`(텍스트 추출·음악/대화 전사+번역)과
  `_run_track_process`(트랙별 번역·재번역)에서 호출. 루프 중 진행률 emit(워치독 방지).
- `_run_track_process` 전사 시 `_timestamps.txt`도 저장하도록 보강(트랙별 전사에도 타임라인 근거 확보).
- **설계 선택**: 전체 번역 `_korean.txt`(문맥·자연스러움)는 그대로 유지하고 타임라인은 별도 파일.
  타임라인은 세그먼트별 번역이라 문맥이 약할 수 있으나 시간축 대조에 유용. 현재 번역 백엔드
  (600M/1.3B/LLM)를 그대로 사용. **주의: LLM은 세그먼트 수만큼 호출이 늘어 느려짐**(전체+세그먼트 2회).
- 검증: 헬퍼 로직 테스트(스탬프 보존·빈 세그먼트·timestamps 부재 시 None), 구문 OK

## 2026-08-16 — 음악 전사는 보컬만 + 재번역 경로 + 트랙 번역 백엔드 반영

- **음악 모드 텍스트/SRT는 보컬 트랙만** (사용자 관찰): 켜면 드럼·베이스·기타까지 전부
  Whisper에 넣어 환각·시간낭비였음. `_post_process`에서 `mode=='music'`이면 `name=='vocals'`만
  전사(대화 모드는 전 화자 그대로). 개별 트랙 전사는 TrackList '가사' 버튼으로 여전히 가능
  (`python/separate.py`)
- **재번역 경로 추가** (사용자 관찰): 한 번 번역하면 번역 버튼이 사라져 다시 번역할 방법이 없었음.
  번역 결과가 있으면 **"다시 번역"** 버튼 표시 → 현재 번역 설정으로 재실행 (`TrackList.tsx`)
- **트랙 번역이 백엔드 선택을 무시하던 잠복 버그 수정**: TrackList가 `translateModel`을 안 넘겨
  항상 600m였음. 이제 Options의 600M/1.3B/LLM 선택을 첫 번역·재번역 모두 반영
  (`TrackList.tsx` → `audio:process-track`)

## 2026-08-16 — 파형 재생 편의: 볼륨(듣기 전용) + 드래그 이동

- **재생 볼륨 조절**: 파형 컨트롤 행에 스피커 아이콘 + 슬림 슬라이더 추가. `ws.setVolume`
  (Web Audio 게인) — **듣기 전용, 원본 파일 미변경**. 음소거 시 아이콘 X 표시. 파일/모드
  재초기화 후에도 볼륨 재적용. 색은 모드 액센트.
- **드래그로 스크럽/이동**: `dragToSeek: true` — 파형을 끌어서 재생 위치 이동, 왼쪽으로 넘겨
  끌면 처음으로. 기존엔 정확히 클릭해야 했던 불편 해소. (`src/renderer/components/Waveform.tsx`)

## 2026-08-16 — 무음 감지 미리보기 + 청취 (Phase A)

설계 문서 `silence-preview-design.md` 기준. 완전 자동 위에 숨겨둔 확인 레이어.

- **감지 유틸** `src/renderer/lib/silenceDetect.ts` — Python `trim_silence` 감지/세그먼트 로직을
  충실히 복제(프레임 20ms/홉 10ms/−40dB/50ms 병합, 말소리 세그먼트의 여집합=제거 무음).
  **실측 검증: 제거 총량 JS=PY 완전 일치**(일반 1.940=1.940, 선행·후행 2.470=2.470, 전체무음
  0=0 — 원본 유지 가드). 경계당 frameLen 과다계상 함정을 여집합 계산으로 회피(§5 거짓 미리보기 방지).
- **GUI(옵션 패널 불가침)**: 파형 카드에만 추가. Layer 1 = 컨트롤 행 왼쪽 ghost 👁 "무음" 토글
  (music/conversation 모드). Layer 2 = 켤 때만 열리는 얇은 스트립: 무음 N곳 + 전/후 길이
  `1:12 → 0:48 (−24초)` + `◀ N/총 ▶` 스테퍼 + `▶시작 ▶끝` 경계 청취(전환을 걸쳐 재생, R1).
- **오버레이**: wavesurfer Regions로 파형 위에 모드 액센트 저알파(0.14) 표시 — 레이아웃 무변경,
  비인터랙티브(drag/resize off).
- **성능(R5)**: 감지는 미리보기 켤 때 1회, 지연 실행(클릭 블로킹 방지) + fileUrl당 캐시.
- 새 Python 파라미터 없음(현재 동작 시각화만). 감지 민감도 수동 knob은 Phase B(미착수).
- ⚠️ 인앱 시각/조작 확인은 다음 빌드에서(여기선 감지 알고리즘 동일성만 실측). smoke test 형태의
  JS↔Python 드리프트 자동 가드는 후속 후보.

## 2026-08-16 — 파일 열기 시 마지막 폴더 기억

- **문제**: 파일 열기 다이얼로그에 `defaultPath`가 없어 OS 공용 "마지막 다이얼로그 경로"에
  의존 → 다른 Electron 앱이 그 값을 바꾸면 AudioForge도 엉뚱한 폴더로 열림(사용자 관찰 정확)
- **수정**: `userData/settings.json`에 마지막 폴더(`lastDir`) 기억. `audio:get-file-info`가
  다이얼로그·드래그앤드롭 공통 경로이므로 거기서 `dirname` 저장, `audio:select-file`은
  `defaultPath`로 사용. 저장 유틸을 `saveSetting(key,value)`로 일반화(L-6 pythonPath와 공유)
  (`src/main/ipc/audio.ipc.ts`). 결정적 — 다른 앱 영향 없음

## 2026-08-16 — 옵션 패널 레이아웃 wrap + Whisper 툴팁

- **레이아웃 깨짐 수정**: 옵션 서브컨트롤이 `flexWrap` 없는 단일 행이라, 옵션을 켤수록
  항목이 오른쪽으로 밀리며 "화자 수 2명"이 세로로 깨지던 문제. 서브옵션/모델 두 행을
  **하나의 `flexWrap: wrap` 컨테이너로 통합**하고, 항상 표시되는 앵커(출력/화자수/분리)를
  앞에 배치 → 토글 컨트롤(무음간격/Whisper/언어/번역)은 오른쪽으로 밀리지 않고 아래로 줄바꿈.
  무음간격 슬라이더는 wrap에서 한 줄 독차지 않게 고정 폭(240px), 버튼에 `whiteSpace:nowrap`로
  라벨 세로 깨짐 방지 (`src/renderer/components/Options.tsx`)
- **Whisper 모델 툴팁**: Small/Medium/Large/Turbo 의미를 알기 어렵던 문제 → 크기별 설명
  툴팁 추가(WHISPER_HINTS, 아티스트 친화 평이한 용어: 속도·정확도·용량 트레이드오프)
- **툴팁 확충(의미 불분명 컨트롤 전반)**: 힌트맵 패턴을 다른 컨트롤에도 적용 —
  Options: 출력 포맷(WAV/MP3/FLAC=OUTPUT_HINTS), 음악 분리 모델(4트랙/2트랙 설명),
  언어(자동 vs 강제 이유), 칩 전체(무음제거/텍스트변환/번역/SRT=전문용어 풀이).
  TTSEditor: 엔진(auto/GPT-SoVITS/F5/Kokoro), 속도·간격 슬라이더. 모두 아티스트 친화 용어
  (`Options.tsx`, `TTSEditor.tsx`). 모드 탭은 라벨이 이미 명확해 제외

## 2026-08-16 — 완성도 개선 패스 (L-items + 잔여 정리)

기능 결함이 아닌 유지보수성·정확성·견고성 정리. 그룹 단위 진행.

**그룹 A — 자잘한 안전 수정**
- L-8: `conversation_worker` docstring hop 표기 수정(0.75s→0.5s, 코드가 권위 HOP_SEC=0.5)
- F2: `_get_llm` 진행 메시지가 "Qwen2.5-3B" 하드코딩 → `model_name` 변수 기반으로(모델 바꿔도 정확)
- F3: `find_ffmpeg` 결과 모듈 캐시 — 반복 호출 시 winget 폴더 `os.walk` 재탐색 제거
- L-4: requirements.txt 정정 — **audio-separator 누락 추가**(RoFormer 9-4 기능 의존, 실제 구멍),
  transformers 주석에 로컬 LLM(Qwen) 추가 + 버전을 검증 환경(4.57.3)에 맞게 `>=4.57.0`으로,
  whisper 주석에 large-v3-turbo 추가. (07-05 이후 speechbrain/whisper/f5-tts/kokoro는 이미 반영돼 있어
  L-4 원문의 "누락" 지적 대부분은 이미 해결된 상태였음 — 실제 남은 건 audio-separator였음)

**그룹 B — 취소 견고성**
- L-9: `PythonRunner.cancel()`이 `kill()`로 부모 python만 종료 → 자식(ffmpeg/격리 venv) 잔존 가능.
  Windows에서 `taskkill /pid <pid> /T /F`로 프로세스 트리 전체 종료, 실패 시 `kill()` 폴백.
  비 Windows는 기존 `kill()` 유지 (`src/main/services/python-runner.ts`)

**그룹 C — 설정 영속화**
- L-6: 사용자가 고른 python 경로가 메모리에만 있어 재시작 시 초기화되던 문제.
  `userData/settings.json`에 저장(`settings:set`/`settings:select-python-path`), 시작 시 우선 적용.
  사용자 명시 선택이 자동 해석(env.json/기본값)보다 우선. app.getPath는 ready 이후에만 접근
  (`registerAudioIpc` 내부에서 로드) (`src/main/ipc/audio.ipc.ts`)

**그룹 D — 렌더러 정리**
- L-11: `TrackItem`/`KaraokeButton`의 `HTMLAudioElement`가 언마운트 시 미정리 → 재생 중
  트랙 목록 교체/언마운트 시 소리 잔존. 각 컴포넌트에 unmount cleanup useEffect 추가
  (pause + src 해제). KaraokeButton은 조기 `return null`보다 위에 배치해 훅 규칙 준수
  (`src/renderer/components/TrackList.tsx`)
- F1: 입력 포맷 개방 이후 디코딩 불가/손상 파일 드롭 시 `loadFile`이 `console.error`만 하고
  **사용자에겐 무반응**이던 문제 → `setError`로 안내 메시지 표시 (`src/renderer/components/DropZone.tsx`)

**그룹 E — 리팩터(신중)**
- L-1: 트랙 분할의 타임스탬프 모드와 자동감지 모드에 있던 추출 루프 ~50줄 중복을
  공통 함수 `_extract_tracks_ffmpeg(...)`로 통합(차이는 진행률 범위·라벨 규칙뿐 → 파라미터화).
  실행 검증: 6초 입력 2,4초 분할 → 3트랙(0-2/2-4/4-6), 라벨/파일명/메타데이터/진행률 정확
  (`python/separate.py`)
- L-3: 감정 정의 TS(TTSEditor.tsx)/Python(tts_worker.py) 중복 → **드리프트 가드로 해결**.
  두 정의는 관심사가 달라(TS=색상/그룹, Python=한/영 태그·프롬프트) 분리 유지하되,
  smoke_test에 `_check_emotions()` 추가: TS의 emotion id를 파싱해 `id ⊆ EMOTION_PROMPTS 키
  ∩ EMOTION_TAGS 값` 불변식 대조, 어긋나면 조용한 기본값 폴백 대신 FAIL. 양쪽에 교차참조 주석.
  공유 JSON(단일 소스) 방식은 Vite의 src 밖 import + 패키징 포함이 필요하고 이 환경에서
  프로덕션 빌드 검증이 불가('dev OK, 배포 깨짐' 리스크)해 **의도적으로 채택 안 함**.
  검증: `smoke_test --quick`에서 TS 50종 ⊆ Python 일치 PASS(가드가 스코핑 오탐도 잡아냄)
- L-2: 무음 감지 3벌(클라이언트 RMS / ffmpeg silencedetect / trim_silence) → **평가 후 통일 안 함**.
  SplitEditor의 자동 감지를 Python silencedetect로 통일하면 클릭마다 서브프로세스 왕복으로
  즉답성 상실 = UX 후퇴. 3벌은 목적(즉시 인터랙티브/배치 정확도/트리밍)이 달라 정당한 분리.
  실제 결함이던 오해 소지 주석("calls Python"인데 실제 클라이언트)만 정정 (`SplitEditor.tsx`)

**그룹 F — L-10**
- L-10: `gptsovits_bridge`의 죽은 `models_dir` 변수는 이미 제거된 상태(obsolete). 현재 bridge는
  `TTS_Config(yaml)`로 모델 경로를 로드 — 코드 변경 불필요, 문서만 정리

**요약**: code-review L-1~L-11 전부 소진(L-5·L-7 기존 완료 + 이번 A~F). 신규 결함 0,
기능 회귀 0. 검증: TSC 무에러, python 구문 OK, split 실행 검증, smoke_test --quick 3/3 PASS.

## 2026-08-16 — 입력 포맷 전면 개방 (ffmpeg 디코딩 가능 전부, mo3 등 포함)

- **동기**: 개발자 실사용으로 트래커 모듈(mo3 등) 등 비주류 포맷 입력 필요. UI에는
  대표 포맷만 유지(긴 나열 회피), 실제 허용은 ffmpeg가 디코딩 가능한 전 포맷으로 확장
- **입력 필터 개방(2곳)**:
  - 드래그앤드롭 확장자 화이트리스트 제거 — 모든 파일 허용, 디코딩 불가 시 파이프라인이 에러 처리
    (`src/renderer/components/DropZone.tsx`)
  - 파일 다이얼로그에 'All Files'(`*`) 필터 추가, 대표 Audio/Video 필터는 편의용으로 유지
    (`src/main/ipc/audio.ipc.ts`)
  - UI 표시 텍스트/배지는 **의도적으로 그대로**(짧게 유지) — 요구사항
- **RoFormer 경로 ffmpeg 정규화**: 유일하게 원시 입력을 audio-separator 자체 로더로
  직행하던 `run_roformer_separation`에 `convert_to_wav` 전처리 + 임시파일 정리 추가
  (`python/music_worker.py`). 나머지 모드는 이미 ffmpeg 경유(Demucs·대화=convert_to_wav,
  Whisper=내부 ffmpeg, split=ffmpeg 직접)라 무변경
- **검증**:
  - 앱이 실제로 고르는 ffmpeg(winget Gyan 8.1)에 `libopenmpt`/`libmodplug` 존재 확인,
    데뮤서 `libopenmpt — Tracker formats` 등록 확인 → mo3 디코딩 능력 실측
  - soundfile 불가·ffmpeg 가능 부류(m4a 프록시)로 메커니즘 증명: soundfile 직접 read는
    LibsndfileError, `convert_to_wav` 경유 시 44100Hz wav 정상 + cleanup 정상
  - TSC 무에러, music_worker 구문 OK
  - ⚠️ 실제 `.mo3` 샘플 파일 e2e는 미실행(샘플 부재) — 능력·메커니즘은 검증됨

## 2026-08-14 — Whisper Turbo 옵션 추가 + 모델 업그레이드 검증

- **Whisper large-v3-turbo 옵션 추가** (기본 large-v3 유지, 비파괴적):
  - 디코더 4층(large-v3는 32층) → 약 8배 빠름, 정확도 ≈ large-v2
  - UI Whisper 셀렉터에 "Turbo" 버튼 + 툴팁(한/일 CJK는 Large가 근소 우위 안내)
  - `whisperModel` 유니온에 'large-v3-turbo' 추가, config→args.whisper_model→
    whisper.load_model 전체 배선 확인, 화이트리스트 없음. whisper 20250625가
    available_models()에 'large-v3-turbo' 보유(검증). 최초 선택 시 ~1.6GB 다운로드
- **검증으로 반려된 후보(중요 — 무턱대고 교체 금지 근거)**:
  - **Mel-Band RoFormer 교체 반려**: 이 환경 audio-separator 0.44.2 번들 목록 기준,
    일반 보컬 분리는 현행 BS-RoFormer `ep_317`=**SDR 12.98**이 최고. 번들 Mel-Band
    일반 보컬 `ep_3005`=**11.44로 오히려 낮음**. SDR 27.99/19.17짜리 Mel-Band는
    디노이즈·디리버브 **전용**(보컬 분리 아님). 최신 커뮤니티 체크포인트
    (kim_ft2_bleedless_unwa, vocals_revive_v3e_unwa 등)는 파일명 SDR 부재로 수치
    우위 증명 불가 → 실측 A/B 없이는 교체하면 품질 저하 위험. **보류.**
  - **Qwen3 번역 백엔드 교체 보류**: 8B bf16≈16GB인데 번역 시 Whisper(~3GB)가
    캐시 잔존해 공존 OOM → 4B(bf16≈8GB)라야 공존 가능. 게다가 Qwen2.5-3B 품질이
    아직 사용자 청취 검증 전 → 미검증 모델을 미검증 모델로 바꾸는 churn. **2.5-3B
    청취 후 판단.** (교체 시엔 thinking 태그 회피 위해 Instruct-2507 변형 사용)

## 2026-08-14 — 화자 분리 재현성 (L-7 kmeans 시드 고정)

- **문제**: `_kmeans` k-means++ 초기화가 `np.random`(전역·비시드)을 써서 같은 입력도
  실행마다 화자 분리 결과가 미세하게 달라짐 → 위 M-2 속도 검증 때 old/new 전체 파이프라인
  대조가 불가능했던 원인
- **수정**: `_kmeans(data, k, rng=None)`로 생성기 주입. 호출부에서 `default_rng(0)` 하나를
  10회 재시작 전체에 **공유** → 재시작 간 초기화 다양성은 유지, 실행 간에는 완전 동일
- **검증**(격리): 같은 시드 2회 실행 라벨/inertia 완전 동일 ✓ / 어려운 데이터 10회 재시작
  inertia 5종(초기화가 재시작마다 실제로 다름) ✓ / 3군집 순수 분리 ✓ / 비시드 경로 유지 ✓
- 새 의존성 0. numpy Generator API만 사용

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
