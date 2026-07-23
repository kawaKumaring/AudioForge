# AudioForge 전체 코드 리뷰 + 개선 로드맵 (2026-07-05)

전수 리뷰 범위: `python/` 7파일 + `src/` 전체(main/preload/renderer) + `doc/` 8파일 = 소스 4,330줄.
리뷰 방식: 전 파일 완독 + dev-guide.md 잔존 버그 6건 현재 코드 대조 검증.

## 품질 로드맵(§9) 최종 상태 (2026-07-05)

| 항목 | 상태 |
|------|------|
| 9-1 Whisper 환각 대책 | ✅ 완료 (반복 억제 + 언어 강제 UI) |
| 9-2 번역 개선 | ✅ 로컬 LLM 백엔드(Qwen2.5-3B) 추가 (2026-07-24) — API 미사용, transformers 재사용(환경 리스크 0), 백엔드만 교체. 품질은 사용자 청취 검증 대기 |
| 9-3 스모크 테스트 | ✅ 완료 (7 PASS) |
| 9-4 보컬 분리 RoFormer | ✅ 완료 (환경 리스크 없음 — 이미 설치됨) |
| 9-5 GPT-SoVITS TTS | ✅ 파이프라인(한/영/중) / ⚠️ 품질=참조 한계, 일본어·파인튜닝=빌드 부재로 보류 |
| 9-6 pyannote 화자 분리 | ⏸ 보류 (HF 게이트 토큰 + 설치 리스크 + 겹침 미해결, 현행 동작) |

**남은 사용자 결정 대기**: pyannote(9-6, HF 토큰), GPT-SoVITS 일본어/파인튜닝(VS Build Tools + 데이터).
(9-2 LLM 번역은 2026-07-24 로컬 LLM으로 결정·구현 — API 미사용)

## 수정 현황 (리뷰 당일 처리 — 커밋별 1건, 각각 테스트 후 push)

| 항목 | 상태 | 검증 |
|------|:---:|------|
| C-1 번역 torch import | ✅ 74978b1 | py_compile + AST 정적 검증 |
| C-3 stdout 라인 버퍼링 | ✅ ad00b6c | 1MB 한글 JSON 통합 테스트 통과 |
| H-1 track-process config화 | ✅ 9d8c9b5 | 빌드 + separate.py --config 경로 검증 |
| C-2 TTS 엔진 캐싱 | ✅ 8370f52 | 캐싱/재사용/폴백 유닛 테스트 |
| H-2 torchaudio 지연 로딩 | ✅ 8703ecc | import 0.01초·torch 미로딩 + split e2e 0.78초 |
| H-3 trackRunner 수명 관리 | ✅ a1063a0 | 빌드 (BUG-5/6 해소) |
| M-3 CJK 문장 분리 | ✅ 5d94eb8 | 유닛 테스트 6케이스 |
| M-6 TTSEditor 상태 초기화 | ✅ abafc98 | 빌드 |
| M-5 subprocess 실패 감지 | ✅ 1792635 | 손상 파일 → 에러 emit 확인 |
| M-7 SplitEditor 리스너 / M-8 daemon | ✅ 738ef72 | 빌드 + py_compile |
| M-4 ffmpeg 입력 시킹 | ✅ df8f68e | 분할 결과 10.000s/42.459s 정확 |
| M-2 화자 분리 루프 불변 (안전 부분) | ✅ 745b25b | 실제 통화 52초 e2e — 2화자 분리 정상 |
| M-1 F5 ref_text | ⏸ 보류 | **청취 검증 필요** — 코드만으로 품질 판단 불가, 사용자 확인 후 진행 |
| M-2 Gaussian 루프 벡터화 | ✅ (2026-07-24) | 격리 테스트로 기존 루프와 scores/weights 완전 동일 확인 + 배치 임베딩 추론 추가 |
| L-1~L-11 | ⏸ 대기 | 기능 작업 없는 날 한 개씩 (L-4 requirements는 ✅) |
| 9-1 Whisper 환각 대책 | ✅ 4b2f4b1 + 3b81f33 | condition_on_previous_text=False + 언어 강제 UI. VAD 사전필터는 보류(조용한 발화 손실 위험) |
| 9-3 스모크 테스트 | ✅ 7155178 | C-1 회귀 감지 확인. TTS 포함 시 7 PASS |
| 9-5 GPT-SoVITS 완성 | ✅ 파이프라인 / ⚠️ 품질 한계 | **한/영/중 출력 동작**(VS Build Tools 없이 — shim+프리빌트 휠). 일본어 출력/참조는 pyopenjtalk 필요(빌드 부재로 보류, graceful fallback 구현). 청취 결과 speaker_b(분리 조각) 클로닝 품질 낮음 = 참조 음원 한계. **파인튜닝은 컴파일러 부재+데이터 부족(~20초 조각)으로 보류** — 상세 tts-setup-guide.md. 사용자 결정으로 TTS 여기서 정리 |

---

## 1. 총평

**아키텍처는 건강하다.** JSON-lines stdout 프로토콜, config 파일로 spawn 인코딩 문제 원천 차단,
worker 간 상호 의존 없음, watchdog, GPU 타임아웃 폴백(`get_device`) — 반복된 버그에서 뽑아낸
규칙들이 실제 코드에 반영되어 있고 dev-guide.md의 회고 문화도 훌륭하다.

**그러나 현재 3개 기능이 실제로 고장 상태다** (아래 C-1~C-3). 모두 TTS 기능 추가 시기
(커밋 `23bbe67`~`1a59c22`) 이후 발생했으며, 그 시기 이후 **코드 리뷰와 문서 갱신이 모두 중단**된
것이 원인이다. dev-rules.md의 "3-4개 기능 추가마다 코드 리뷰" 규칙이 지켜지지 않았다.

| 영역 | 평가 |
|------|------|
| 아키텍처 (프로세스 분리, IPC 설계) | 양호 — 규칙이 코드에 살아있음 |
| Python 워커 품질 | 중간 — 번역 크래시 1건, 성능 여지 큼 |
| TTS (베타) | 미완 — 문장마다 모델 재로딩, 실사용 불가 수준 |
| Electron 메인 | 중간 — stdout 버퍼링 결함, track-process 규칙 위반 |
| React 렌더러 | 양호 — 소소한 상태/리스너 문제만 |
| 문서 | **낡음** — TTS 시대 이전에서 멈춤, 코드와 불일치 다수 |

---

## 2. dev-guide.md 잔존 버그 6건 — 현재 상태 검증 결과

| 버그 | 문서 상태 | 실제 현재 상태 |
|------|-----------|---------------|
| BUG-1 datetime import 누락 | 미해결로 기재 | ✅ **해결됨** — [separate.py:311](../python/separate.py)에서 `_run_split` 상단 import |
| BUG-2 conversation ImportError 보호 | 미해결로 기재 | ✅ **사실상 해결** — torch/numpy는 try/except([conversation_worker.py:18](../python/conversation_worker.py)), speechbrain 실패는 separate.py 최상위 except가 emit("error") 처리 |
| BUG-3 임시 파일명 input 잔류 | 미해결로 기재 | ✅ **해결됨** — source 접두어 사용 확인 |
| BUG-4 크로스 드라이브 renameSync | 미해결로 기재 | ✅ **무효화** — createSafePaths 자체가 제거되고 config 파일 방식으로 대체됨 |
| BUG-5 trackRunner done/cancel 없음 | 미해결로 기재 | ❌ **여전히 존재** — 아래 H-3 |
| BUG-6 즉시 크래시 시 listener leak | 미해결로 기재 | ⚠️ **부분 잔존** — exit code가 null(외부 kill)이면 error 미발생 → cleanup 안 됨 |

→ dev-guide.md의 버그 목록은 4/6이 현실과 다르다. 문서 갱신 필요 (§7).

---

## 3. 신규 발견 버그 — Critical (기능 고장)

### C-1. 한국어 번역 전체 크래시 — `torch` 미임포트 NameError
- **위치**: [transcribe_worker.py:64](../python/transcribe_worker.py)
- **내용**: `translate_to_korean()`이 `with torch.no_grad():`를 사용하지만 이 함수(및 모듈 상단)에
  `import torch`가 없다. `_get_whisper_model()` 안의 import는 함수 지역 바인딩이라 무관.
- **증상**: 번역 옵션을 켜면 `NameError: name 'torch' is not defined` — **모든 번역 경로**
  (텍스트 추출 번역, 분리 후 번역, 트랙별 번역 버튼)가 100% 실패.
- **원인 추정**: `1504bfb` 모듈 분리 시 import 누락 (분리 전에는 상위 파일의 import에 의존).
- **수정** (1줄): `translate_to_korean` 함수 상단에 `import torch` 추가.

### C-2. TTS가 문장마다 AI 모델을 새로 로딩 (베타 미완이지만 구조 결함)
- **위치**: [tts_worker.py:375](../python/tts_worker.py) (`_select_engine`을 루프 안에서 호출),
  [tts_worker.py:156](../python/tts_worker.py) (`if self._pipeline is None or True:` — 항상 재로딩)
- **내용**: `synthesize()` 루프가 문장마다 `_select_engine()`으로 **새 엔진 인스턴스**를 생성한다.
  F5-TTS의 `_model` 캐시는 인스턴스 필드라 매 문장 ~1.2GB 모델을 다시 로딩. Kokoro는
  `or True`가 박혀 있어 인스턴스를 재사용해도 무조건 재로딩. GPT-SoVITS는 문장마다 venv
  프로세스 spawn + 모델 로딩.
- **증상**: 10문장 대본 = 모델 로딩 10회. 문장당 수십 초 → TTS 실사용 불가.
- **수정**: 엔진 인스턴스를 `synthesize()` 스코프(또는 모듈 레벨 dict)에 캐싱 —
  `engines = {}` / `engines.setdefault(name, cls())`. Kokoro는 `or True`를 언어 변경 감지
  (`self._lang != new_lang`)로 교체. GPT-SoVITS는 세션형 브리지(stdin으로 여러 요청)로 개선
  가능하나 베타 단계에서는 후순위.

### C-3. stdout JSON 라인 버퍼링 부재 — 긴 결과가 통째로 유실
- **위치**: [python-runner.ts:41-59](../src/main/services/python-runner.ts)
- **내용**: `data` 청크를 그대로 `split('\n')` 한다. 파이프 청크 경계(보통 64KB)에서 JSON 한 줄이
  두 청크로 잘리면 양쪽 다 `JSON.parse` 실패 → **무시**된다. `emit("result")`는 전사 텍스트
  전문을 tracks에 담으므로 (large-v3 + 장시간 오디오 + 번역) 64KB를 쉽게 넘는다.
- **증상**: 처리 자체는 성공했는데 result가 UI에 도달하지 않아 99%에서 멈춘 것처럼 보임.
  "대화 분리 무한 대기"류 증상의 잠재 원인 중 문서(§4 dev-guide)에 없는 8번째 지점.
- **수정** (~10줄): 잔여 버퍼 유지 방식 —
  ```ts
  let lineBuf = ''
  stdout.on('data', (d) => {
    lineBuf += d.toString('utf-8')
    const lines = lineBuf.split('\n')
    lineBuf = lines.pop() ?? ''   // 마지막 불완전 라인은 다음 청크와 합침
    for (const line of lines) { ...기존 파싱... }
  })
  ```

---

## 4. High (규칙 위반 / 기능 신뢰성)

### H-1. track-process가 한글 경로를 spawn 인자로 직접 전달
- **위치**: [audio.ipc.ts:191](../src/main/ipc/audio.ipc.ts)
- **내용**: `['--mode', 'track-process', '--input', trackPath, '--output', outputDir]` —
  출력 폴더명은 원본 파일명에서 파생되므로 (`...\2026-07-05_..._통화 녹음 양소영...\vocals.wav`)
  한글이 spawn 인자에 그대로 들어간다. **이 프로젝트가 3번 반복 끝에 만든 최우선 규칙**
  ("한글 경로는 spawn 인자 금지 → JSON config") 위반. audio:process만 config 방식으로 고치고
  track-process는 누락된 것.
- **증상**: 한글 파일명 작업물에서 트랙별 가사/번역 버튼이 CP949 변환 깨짐으로 실패 가능.
- **수정**: audio:process와 동일하게 config JSON 파일로 전달 (separate.py는 이미 --config 지원).

### H-2. 모든 모드가 시작 시 torch를 로딩 (최상단 torchaudio 패치)
- **위치**: [separate.py:23-54](../python/separate.py) `_patch_torchaudio()` — 모듈 최상단에서 실행
- **내용**: `import torchaudio`가 torch를 끌고 온다. dev-rules §5.1 "heavy import는 emit 후
  함수 내부에서" 규칙을 **엔트리포인트 자신이 위반**. split/meta-fix/tts(gptsovits)처럼 torch가
  필요 없는 모드도 시작 전 10-30초 무응답 구간이 생기고, 이 구간엔 emit조차 불가능
  (audio_utils import가 패치 뒤에 있음).
- **수정**: `_patch_torchaudio()` 호출을 최상단에서 제거하고, torch를 쓰는 모드 분기
  (music/conversation/transcribe/track-process) 진입 직후 + progress emit 후에 호출.
  patch는 멱등이므로 여러 번 불려도 안전하게 가드 추가.

### H-3. trackRunner 수명 관리 부재 (BUG-5 잔존 + 에러 시 UI 고착)
- **위치**: [audio.ipc.ts:179-208](../src/main/ipc/audio.ipc.ts), [TrackList.tsx:61-84](../src/renderer/components/TrackList.tsx)
- **내용**: ① trackRunner에 done/watchdog/cancel 없음 — 연타 시 프로세스 누적, 취소 불가.
  ② TrackList는 `onTrackResult`만 구독하고 `audio:error`는 구독하지 않음 — Python이 에러를
  emit하면 해당 트랙은 영원히 "처리 중..." 상태, 리스너도 해제 안 됨.
- **수정**: IPC에 실행 중 trackRunner 가드 + done에서 정리. TrackList에 onError 구독 추가
  (또는 track 전용 `audio:track-error` 채널) + 타임아웃 시 processing 해제.

---

## 5. Medium (품질 / 성능)

### M-1. F5-TTS `ref_text`에 감정 프롬프트를 전달 — 클로닝 품질 저하
- **위치**: [tts_worker.py:135-138](../python/tts_worker.py)
- **내용**: F5-TTS의 `ref_text`는 **참조 음성의 실제 전사 텍스트**여야 한다 (빈 문자열이면
  내부 Whisper 자동 전사). 현재 감정 프롬프트(`"(happily, ...)"`)를 넣고 있어 모델이 "참조
  음성이 이 내용을 말했다"고 오인 → 클로닝 품질/발음 저하. 커밋 `3bd5095`가 "Whisper
  자동 전사로 한국어 품질 수정"이라 했으나 현재 코드는 다시 감정 프롬프트를 전달 중.
- **수정**: `ref_text=""`로 자동 전사에 맡기고, 감정 힌트는 `gen_text` 앞에 붙이는 방식으로
  분리 실험 (효과는 모델 특성상 제한적 — 감정별 참조 음성 등록이 정공법이며 이미 구현됨).

### M-2. conversation_worker 성능 — 순수 Python 루프 3곳
- **위치**: [conversation_worker.py:190-230](../python/conversation_worker.py)
- **내용** (1시간 통화 기준 윈도우 ~7,200개):
  1. **윈도우마다 클러스터 중심을 재계산** (line 205-211) — 중심은 클러스터링 직후 1회만 계산하면 됨
  2. center_time 선형 탐색 매칭 (line 194-198) — `valid_windows` 인덱스 dict로 O(1) 가능
  3. 프레임×화자 이중 Python 루프 (line 224-229) — numpy 브로드캐스트로 벡터화 가능
  4. 임베딩 추출이 윈도우 1개씩 GPU 호출 (line 134-137) — 배치 인퍼런스로 수 배 단축 가능
- **효과**: 후처리(임베딩 이후) 구간이 분 단위 → 초 단위로 줄어들 수 있음. 단, **동작은 정상**이므로
  수정 시 결과 동일성 비교 테스트 필수 (한 항목씩, 규칙 §2.1).
- **✅ 2026-07-24 전부 완료**: 1·2는 745b25b, 3(이중 루프 벡터화)·4(배치 임베딩)는 2026-07-24.
  격리 테스트로 동일성 검증(Gaussian 벡터화=bit-identical, 배치 임베딩 자기코사인 0.99999994).
  kmeans 무작위성(L-7)과 무관하게 각 최적화를 순수 numpy / 개별-vs-배치로 격리 검증.

### M-3. NLLB 번역이 CJK 문장을 분리하지 못함 — 조용한 텍스트 손실
- **위치**: [transcribe_worker.py:59](../python/transcribe_worker.py)
- **내용**: `'. '` 기준 분리는 일본어(。)·중국어 문장에 안 통함 → 전체 텍스트가 한 문장으로
  들어가 `max_length=512` 토큰에서 **잘린 만큼 번역이 소리 없이 유실**된다. 일본어 노래
  가사·통화가 주 사용례인 이 앱에서 발생 빈도 높음.
- **수정**: `re.split(r'(?<=[.。！？!?])\s*', text)` 방식으로 CJK 문장부호 포함 분리.

### M-4. ffmpeg 트랙 분할이 곡마다 파일 처음부터 디코딩
- **위치**: [separate.py:365](../python/separate.py) (`-i` 뒤에 `-ss`)
- **내용**: 출력 시킹(`-i` 뒤 `-ss`)은 매 트랙마다 처음부터 디코딩 — 80분 앨범 20곡이면
  누적 O(n²). 입력 시킹(`-ss`를 `-i` **앞**에)으로 바꾸면 즉시 점프 (WAV/일반 포맷에서 정확도
  손실 없음, `-to` 대신 `-t {dur}` 사용).
- **효과**: 분할 시간 수 배 단축. 현재도 "~30초"라 급하지 않지만 공짜 최적화.

### M-5. subprocess.run 결과 미확인 — 실패해도 성공처럼 보임
- **위치**: [separate.py:371, 469, 549](../python/separate.py), `_post_process` mp3/flac 변환
- **내용**: ffmpeg 추출/변환의 returncode를 확인하지 않는다. 디스크 부족·코덱 문제 시 빈 트랙이
  생기거나 조용히 누락되고 UI는 "완료!"를 표시.
- **수정**: returncode != 0 이면 stderr 끝부분을 포함해 emit("error") 또는 해당 트랙 스킵 경고.

### M-6. TTSEditor 로컬 상태가 store를 덮어씀 — 모드 전환 시 대사 유실
- **위치**: [TTSEditor.tsx:92-103](../src/renderer/components/TTSEditor.tsx)
- **내용**: `useState('')`로 초기화 후 useEffect가 store에 동기화. 다른 모드에 다녀오면
  컴포넌트가 재마운트되며 빈 값이 store를 덮어씀 → 입력한 대사·감정 등록 전부 소실.
- **수정**: `useState(() => useAppStore.getState().ttsText)`처럼 store 값으로 초기화하거나,
  로컬 상태를 없애고 store를 직접 바인딩 (splitMarkers처럼 이미 store에 필드 존재).

### M-7. SplitEditor 리스너 누적
- **위치**: [SplitEditor.tsx:97](../src/renderer/components/SplitEditor.tsx)
- **내용**: `regions.un('region-updated')`를 리스너 인자 없이 호출 — wavesurfer 7의 `un(name, fn)`은
  특정 리스너만 제거하므로 아무것도 제거되지 않고 marker 변경마다 핸들러가 쌓인다
  (setMarkers가 멱등이라 눈에 안 보일 뿐).
- **수정**: cleanup에서 `regions.un('region-updated', handleUpdate)`로 자기 핸들러를 정확히 제거.

### M-8. get_device 프로브 스레드가 non-daemon
- **위치**: [audio_utils.py:160](../python/audio_utils.py)
- **내용**: CUDA가 진짜로 멈춘 경우 프로브 스레드가 살아 있어 Python 프로세스가 정상 종료 후에도
  안 죽음 (watchdog 5분까지 대기). `threading.Thread(target=_probe, daemon=True)` 1단어 수정.

---

## 6. Low (정리 대상 — 급하지 않음)

| # | 항목 | 위치 |
|---|------|------|
| L-1 | `_run_split` 타임스탬프/자동감지 경로에 추출 루프 ~70줄 중복 — 공통 함수 `_extract_tracks(boundaries, labels, ...)` 추출 | separate.py:349-400 vs 447-486 |
| L-2 | 무음 감지 구현이 3벌 (클라이언트 RMS / ffmpeg silencedetect / trim_silence) — SplitEditor의 클라이언트 감지를 Python silencedetect 호출로 통일 검토 | SplitEditor.tsx:167 |
| L-3 | 감정 정의가 TS/Python 두 곳에 중복 (라벨 오타 = 조용한 기본값 폴백) — Python이 단일 소스, config에 id만 전달하는 방향 | TTSEditor.tsx / tts_worker.py |
| L-4 | requirements.txt 낡음: pyannote.audio(미사용) 기재, whisper/speechbrain/transformers/silero-vad/f5-tts/kokoro 누락 | python/requirements.txt |
| ~~L-5~~ ✅ | `audio:get-file-info` exec→execFile 전환 완료 (833fff6) — 한글 경로 CP949 손상 실제 발생 확인 후 수정 | audio.ipc.ts |
| L-6 | pythonPath 설정이 메모리에만 존재 — 재시작 시 초기화. userData JSON 1개로 영속화 | audio.ipc.ts:21 |
| L-7 | `_kmeans` 난수 시드 없음 — 같은 파일도 실행마다 화자 분리 결과 변동. `np.random.default_rng(0)` 고정 검토 | conversation_worker.py:366 |
| L-8 | HOP_SEC 주석 불일치 (docstring 0.75s, 코드 0.5s) | conversation_worker.py:11,102 |
| L-9 | cancel()이 python만 kill — 자식 ffmpeg/venv 프로세스는 잠시 잔존 가능. Windows는 `taskkill /T` 검토 | python-runner.ts:104 |
| L-10 | gptsovits_bridge: `models_dir` 계산 후 미사용, TTS_Config에 모델 경로 미지정 — 셋업 미완 상태 그대로 (베타 문서화됨, 유지) | gptsovits_bridge.py:37 |
| L-11 | KaraokeButton 오디오 엘리먼트 언마운트 시 미정리, TrackItem도 동일 | TrackList.tsx |

---

## 7. 문서 상태 평가 (코드와의 불일치)

문서 문화는 이 프로젝트의 강점이지만, **TTS 개발 시기 이후 갱신이 멈춰** 현재는 오히려
오판을 유발하는 상태다 (이번 리뷰에서도 dev-guide 버그 목록 4/6이 이미 무효였음).

| 문서 | 문제 |
|------|------|
| architecture.md | tts_worker.py(411줄)·gptsovits_bridge.py·TTSEditor.tsx·externals/ 부재. 줄 수 전부 낡음. "알려진 구조 문제" §4(ImportError)는 해결됨 |
| dev-guide.md | 잔존 버그 6건 중 4건이 이미 해결/무효 (§2 표 참조). createSafePaths 서술은 제거된 코드. 코드 현황 3296줄 → 실제 4330줄 |
| changelog.md | 2026-04-12에서 정지. TTS 5모드·엔진 추상화·GPT-SoVITS 커밋 15개분 누락 |
| features.md | Kokoro 엔진 미기재 (자동 선택 폴백으로 실사용됨) |
| dev-rules.md | 최신 (기준 문서로 유지) |
| requirements.txt | L-4 참조 |

**권장**: 이번 수정 작업(§8) 완료 시점에 architecture/dev-guide/changelog 3개를 일괄 갱신하고,
dev-guide의 버그 목록은 이 문서의 §3~5로 대체.

---

## 8. 수정 우선순위 로드맵

규칙 준수: **한 항목씩 수정 → 빌드/테스트 → 커밋** (dev-rules §2.1).

| 순위 | 항목 | 규모 | 근거 |
|:---:|------|:---:|------|
| 1 | C-1 torch import 1줄 | 1분 | 번역 기능 100% 고장 |
| 2 | C-3 stdout 라인 버퍼링 | 10분 | 결과 유실 = 무한 대기 증상 재발 방지 |
| 3 | H-1 track-process config화 | 20분 | 3회 반복된 인코딩 버그의 마지막 잔존 경로 |
| 4 | C-2 TTS 엔진 캐싱 + Kokoro `or True` 제거 | 30분 | TTS 실사용 가능하게 만드는 최소 수정 |
| 5 | H-2 torchaudio 패치 지연 로딩 | 20분 | 전 모드 시작 지연 제거 |
| 6 | H-3 trackRunner 수명 관리 + TrackList 에러 구독 | 40분 | 가사/번역 버튼 신뢰성 |
| 7 | M-3 CJK 문장 분리 | 10분 | 일본어 번역 텍스트 유실 |
| 8 | M-6 TTSEditor 상태 초기화 | 10분 | 대사 유실 UX |
| 9 | M-5 subprocess returncode 확인 | 20분 | 조용한 실패 방지 |
| 10 | M-1 / M-2 / M-4 / M-7 / M-8 | 각 10-60분 | 품질/성능 — 여유 있을 때 |
| 11 | §7 문서 3종 갱신 + L-4 requirements | 30분 | 위 수정 반영하며 일괄 |
| 12 | L-1~L-11 정리 | - | 기능 작업 없는 날 한 개씩 |

**하지 말 것** (과잉 엔지니어링 방지):
- audio.ipc.ts / SplitEditor.tsx 파일 분리 — 문서에 "분리 예정"으로 남아 있으나 현 규모(316/364줄)에서
  실익보다 회귀 위험이 큼. 실제 고통이 생길 때까지 보류.
- GPT-SoVITS 세션형 브리지 — 베타 확정 전까지 현행 프로세스-per-문장 유지.
- 설정 시스템/플러그인화 등 신규 추상화 — 현재 필요 없음.

---

## 9. 품질 개선 로드맵 (버그 수정 이후 단계)

결과물 품질(분리·전사·번역·합성의 질)을 올리는 방법. §8의 Critical/High 수정 완료가 전제.
효과 대비 비용 순.

### 9-1. Whisper 환각 대책 — 비용 거의 0, 확실
분리된 보컬/화자 트랙은 긴 무음·연주 구간이 많아 Whisper 환각(문장 반복, 없는 문장 생성)이
잘 생기는 최악의 입력이다. 모델 교체 없이 호출 방식으로 개선:
- `condition_on_previous_text=False` — 반복 환각 억제 (1줄)
- 무음 구간 VAD 필터 후 발화 구간만 전사 (Silero VAD가 이미 프로젝트에 있음)
- UI 언어 고정 옵션 — 짧은/노이즈 클립의 언어 오판 방지

### 9-2. 번역 — ⚠️ NLLB 크기 업그레이드는 효과 없음 (검증 완료)
NLLB-600M distilled는 일→한 구어체·가사에서 품질 낮음. 1.3B로 키우면 나아질 것으로
가정했으나 **실측 결과 신뢰할 만한 개선이 아님**:
- 깨끗한 일본어 입력 비교(2026-07-05): 1.3B가 어떤 문장은 더 완전하지만, 다른 문장은
  오히려 환각이 심함("영화 보러 갔다" → 없는 "책을 읽었습니다" 생성). 600M이 더 충실한 경우도.
- 손상된 ASR 입력에서는 두 모델 다 무의미(입력 품질이 병목).
- **결론**: 5GB 다운로드+VRAM을 정당화 못 함. 1.3B는 선택 옵션으로만 제공(기본 600M),
  UI 라벨도 "고품질"→"1.3B"(중립)로 정정. 강제/기본화하지 않음.
- **진짜 레버 = LLM 번역**: 문맥 인지 + 환각 억제로 구어체 JA→KO에서 NLLB 대비 격차 큼.
- **✅ 2026-07-24 구현 (로컬 LLM, API 미사용)**: Qwen2.5-3B-Instruct 백엔드를 추가.
  이미 설치된 transformers(4.57.3)+torch 재사용이라 새 venv·빌드·설치 없음(환경 리스크 0) —
  GPT-SoVITS 때의 컴파일러/휠 문제가 여기선 없음. `translate_to_korean`을 백엔드 디스패처로
  나누고 config `translateModel='llm'`로 선택. 문장 ~1200자 청크·그리디 디코딩. 기본은 NLLB 유지.
  **품질 확정은 실제 GPU 추론+청취 필요**. 후보 개선: 7B 격상(Whisper 언로드 필요), 문맥 배치 번역.

### 9-3. 스모크 테스트 스크립트 — ✅ 완료 (python/smoke_test.py)
합성/실제 샘플로 6개 모드 + 번역 경로를 돌려 result JSON까지 확인.
Electron과 동일한 config→separate.py→stdout 방식으로 호출해 충실도 높음.
- **번역(en→ko) 체크가 C-1 회귀를 실제로 감지**하도록 설계 (한국어 샘플은
  조기 반환으로 torch 경로를 안 타므로 비한국어 입력 강제 — 시뮬레이션으로
  C-1 재현 시 FAIL 확인 완료)
- 사용법 dev-rules.md §1.3. 현재 6 PASS / 1 SKIP(tts, 참조음성 필요)

### 9-4. 보컬 분리 RoFormer — ✅ 완료
BS-RoFormer(model_bs_roformer_ep_317_sdr_12.9755, SDR 12.97)로 보컬/반주 2트랙 분리.
- **환경 리스크 없음**: audio-separator 0.44.2 + onnxruntime 1.24.4(CUDAExecutionProvider)가
  ComfyUI 환경에 **이미 설치돼 있어** 별도 venv 불필요 (§9-7 우려가 해소된 케이스).
- music 모드에 'roformer' 선택 추가(기본4트랙/고품질4트랙/보컬2트랙), model 값으로 라우팅.
- 모델(610MB)은 externals/separator_models에 캐싱(gitignore). 15초 클립 ~5초(GPU).
- 스모크 music(RoFormer) PASS. 청취 품질(Demucs 대비)은 사용자 검증 권장.

### 9-5. TTS — 새 방법 불필요, 시작한 통합을 완성
한국어/일본어 클로닝은 GPT-SoVITS가 정답이라는 기존 판단(커밋 387bc2a)이 맞다.
브리지 미완성(모델 경로 미지정, models_dir 미사용)을 완성하는 것이 유일한 품질 레버.
+ C-2(엔진 캐싱), M-1(ref_text 오용) 수정.

### 9-6. 화자 분리 pyannote — ⏸ 보류 (사용자 결정, 2026-07-05)
현재 구현은 분리가 아니라 구간별 원본 복사(마스킹) — 겹쳐 말하는 구간은 한 화자에게
통째로 배정되며 원리적으로 개선 불가.
- **보류 사유(검증)**:
  1. pyannote.audio 미설치 — ComfyUI 환경에 없음(audio-separator와 달리). 설치 시
     torch/asteroid 등 버전 충돌로 ComfyUI 손상 위험 → 격리 venv 필요(무거움).
  2. **모델 게이트** — pyannote/speaker-diarization-3.1은 HF 약관 동의 + 토큰 필요.
     사용자만 가능(내가 대신 못 함).
  3. **겹침 미해결** — pyannote는 "누가 언제"(구간)만 정확히 잡음. 실제 언믹싱이 아니라
     현행처럼 마스킹으로 트랙 생성 → 경계/화자배정 정확도만 오르고 겹침은 그대로.
  4. 현행 자체 분리가 턴테이킹 통화(주 사용례)에서 정상 동작(2화자 검증 완료).
- **재개 조건**: HF 게이트 토큰 확보 + 실사용 정확도 불만 발생 시. 그 전엔 자체 파이프라인
  파라미터 튜닝(경계 정확도)이 게이트/설치 없는 대안.

### 9-7. 환경 리스크 (모든 항목의 공통 전제)
이 앱은 **ComfyUI 앱이 아니라, ComfyUI가 설치해 둔 AI 패키지들에 의존**한다
(정정: 코드가 쓰는 건 python.exe 경로뿐, ComfyUI API/노드/모델 미사용 — doc/environment.md).
그 파이썬을 **빌려 쓰므로**, 신규 패키지를 거기에 설치하면 ComfyUI까지 깨질 수 있다.
→ 원칙: **빌린 환경엔 자동설치 금지**, 충돌 패키지는 gptsovits_venv처럼 전용 venv 격리.
환경 탐지/해석은 env_check.py + setup_env.py가 담당(attach 우선, 없으면 전용 venv).

### 품질 개선이 아닌 것 (오분류 주의)
- faster-whisper 교체: 4배 빨라지지만 정확도 동일 — 속도 개선으로 분류
- M-2 벡터화: 처리 속도 개선일 뿐 분리 품질 무관
- 엔진 선택지 추가: 금물 (PixelForge 교훈) — 기존 슬롯의 엔진 교체/완성만
