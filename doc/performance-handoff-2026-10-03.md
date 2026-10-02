# 성능 검수 인계 — 낭독 · 합성 카드 (2026-10-03)

> 목적: 관리자가 현재 구조와 기존 측정 근거를 직접 검수하기 위한 인계. **최적화·구조 변경 없음.**
> 기준 코드: develop `d0eda7f`. 행 번호는 그 시점 기준의 대략값(편집하면 어긋난다 — 함수 이름으로 찾을 것).
> 근거 수준 표기: [코드] 코드를 읽어 확인 · [실측] 과거 측정 · [추정] 이론값·계산 · [미확인] 확인하지 않음.

## 0. 검수 중 발견한 결함 (즉시 보고, 수정하지 않음)

1. **낭독 참조 목소리가 앱을 다시 켜면 사라진다** [코드] — 설정 유실
   - 낭독에서 내 목소리 파일을 고르면 3~10초 구간을 잘라 `userData/refclips/audioforge_refclip_<uuid>/` 에 둔다. 그 **잘라 둔 조각의 경로**를
     `prefs.voice` 와 `recentVoices` 에 저장한다(`ReaderWorkspace.tsx` pickVoiceFile ~566행).
   - 그런데 앱 시작(`audio.ipc.ts` ~457행)과 종료(before-quit ~471행)에서 `sweepRefClipDirs(clipRoot())` 가 `audioforge_refclip_*` 를 전부 지운다.
     낭독에서 다른 파일을 새로 준비해도 `releaseRefClip('reader')`(~785행)가 앞 조각을 지운다.
   - 결과: 다시 켜면 고른 목소리가 '내 목소리 파일을 찾지 못했습니다' 로 막히고, 최근 목소리 칩도 죽은 경로가 된다. 원본 음성 파일은 건드리지 않는다(원본 훼손 아님).
   - 구간을 자르지 않고 원본을 그대로 쓴 경우에는 생기지 않는다. 실제 재시작 재현은 하지 않았다.
2. **문단 이동으로 덩이를 다시 나눈 뒤, 늦게 온 앞 결과가 새 덩이 자리에 들어갈 수 있다** [코드 · 재현 안 함]
   - `useReadAloud.ts` ~250행: 결과 수락 조건은 `acceptResult`(`readerQueue.ts` ~178행) = **같은 목소리 + 그 번호가 '만드는 중'** 뿐이다. 덩이 나눔(chunks)이 바뀌었는지는 보지 않는다.
   - 다시 나눈 뒤 새 큐의 같은 번호가 '만드는 중' 이고 앞 요청이 먼저 끝나면, **다른 글로 만든 소리**가 그 자리에 들어가 재생된다(따라가기 표시와 소리 불일치).
3. **카드 감정 표시가 실제와 다르다** [코드] — 표시 결함
   - Qwen 지정 목소리 + 1.7B 가 있으면 카드 감정은 실제로 보내진다(`cardScriptWithEmotion`, `synthesisCardVoice.ts` ~57행 → `cardSynthesis.ts` ~389행).
   - 그런데 `cardApplied`(`synthesisCardJob.ts` ~82행)는 감정이 '자연스럽게' 가 아니면 늘 "반영되지 않습니다" 를 붙여, 카드에 미적용 표시가 뜨고 생성본 기록에도 남는다.

## 1. 현재 구현 — 낭독

### 1-1. 엔진·모델과 선택 [코드]
- 목소리 목록: `python/builtin_voices.py` main()(~165행) → `card:builtin-voices`. piper 는 목록에서 빠졌다(~170행, 엔진 파일은 남음).
- 분기 한 곳: `makeChunk()`(`src/main/ipc/reader.ipc.ts` ~260–341행).
  - Supertonic(`engineId==='supertonic'`, CPU·ONNX) → 기본 목소리 상주 실행기(`reader_voice_server.py`).
  - Qwen 지정 목소리(`qwen-custom`) → `qwenVoiceOf()`(~147행)로 풀이:
    - 소희 등 화자 → 0.6B CustomVoice(`speak`).
    - 설계 목소리(`voices/qwen/*.json` 의 `clone`) → Base 1.7B clone. 감정 무시.
    - 감정 켬(`segments` 있음 + 1.7B 있음) → **덩이 전체**를 1.7B CustomVoice 로(~303행).
  - 참조 목소리(`kind==='reference'`) → **덩이마다 `separate.py` 새 프로세스**(~313행). 설정은 `readerRunConfig`(`reader-run.ts` ~77행), 엔진 'auto'
    → 한국어면 `tts_worker._select_job_engine`(~1647행)이 qwen3 일괄(Base, `qwen_bridge.py`). Base 크기 선택(`_qwen_active_snapshot`)은 [미확인].
- 감정 켬 조건: 화면 `emotionUsable`(ReaderWorkspace ~286행, 목록의 emotion=1.7B 존재) · 본체 `segmentsOf()`(~117행, qwen-custom 만).
- Qwen 가속: `qwen_fast.apply()`(`python/qwen_fast.py`)를 `qwen_custom_voice.load()` 가 모델을 열 때 붙인다(CUDA graph + StaticCache). 끄는 환경 변수 `AUDIOFORGE_QWEN_FAST/GRAPH/TALKER_GRAPH/SAMPLE_GRAPH`.

### 1-2. 로딩·상주·해제 [코드]
- 기본 목소리 상주: `readerWorker()`(reader.ipc ~190행), 첫 호출에 뜸, 유휴 **10분** 내림, 덩이 상한 10분. `{warm:true}` 로 미리 열기.
- Qwen 상주: `qwenWorker()`(`services/qwen-resident.ts` ~36행) → `python/qwen_voice_server.py`(격리 환경 파이썬). 유휴 **3분**, 조각 상한 10분(`qwen-voice-worker.ts` ~39행).
  모델 최대 2개(`MAX_MODELS`, 넘치면 오래 안 쓴 것 내림 + empty_cache). **낭독과 카드가 같은 실행기를 쓴다.**
- 목록을 열 때(`prepareQwen` → `reader:prepare`, reader.ipc ~371행): 모델 없이 실행기만 띄우고 torch·qwen_tts 를 미리 import, 고를 법한 모델 파일을 미리 읽음(prefetch).
- 목소리를 고를 때(`chooseBuiltin` → `reader:warm`, ~386행): 줄 안에서 다른 작업이 없으면 모델을 열고 `PRIME_TEXT` 한 번 생성해 버림(첫 생성 준비).
- 고아 방지: will-quit 에서 두 실행기 stop(stdin 닫고 kill), 파이썬은 stdin EOF 면 스스로 끝남(Qwen 은 PeekNamedPipe). OS job object 는 안 씀 — 본체 강제 종료 시 EOF 에만 기댐([추정] 고아 가능).
- 참조 목소리는 상주 없음 — 덩이마다 모델을 연다.

### 1-3. 참조 목소리 준비·재사용 [코드]
- `pickVoiceFile()`(ReaderWorkspace ~538행) → 줄이 빌 때까지 대기(`reader:idle`) → `runVoicePrep`(`lib/voicePrepRunner.ts`) → 분석(`audio:analyze-reference`) → 자르기(`audio:trim-reference`).
- 본체 캐시: 분석 `[clipKey, 경로, 크기·시각, extra]`, 자르기 `[clipKey, 경로, 크기·시각, start, dur, extra]`(조각이 살아 있을 때만).
- 재사용은 '최근 목소리' 칩뿐 — **0절 결함 1** 때문에 재시작 뒤엔 깨진다.
- 생성 쪽 참조 전사(Whisper)는 `tts_worker._qwen_ref_text_cache`(프로세스 안 dict) — 덩이마다 새 프로세스라 매번 새로 전사한다.

### 1-4. 분할·선행 생성·버퍼 [코드]
- 덩이: `splitForReading()`(`shared/readerChunks.ts` ~88행). 9.2자/초 기준, 목표 20초·최소 12·최대 35초, **첫 덩이 4~8초 · 둘째 9~18초**(`START_RAMP_SECONDS=[4,9]`).
  문장 끝에서만 자르고, 사용자가 고른 시작 자리(breakAt)에서 반드시 자른다.
- 구절(따라가기용): `readingPlan()`(`shared/readerText.ts` ~145행), 소리 시각 맞춤 `readerTiming.alignParts()`.
- 선행 생성: GPU 목소리 **2개 앞**(`DEFAULT_AHEAD`), CPU 목소리 **6개 앞**(`BUILTIN_AHEAD`). 한 번에 하나만 보냄(`useReadAloud` ~216행), 본체도 줄 하나(`inLane`).
  CPU 목소리는 재생 전에도 만든다(책을 열면 최대 7덩이).
- 재생 버퍼: 소리 요소 2개를 번갈아. 다음 덩이가 준비돼 있으면 미리 불러 두고 끝나는 즉시 이어 틂(`useReadAloud` ~351행, onended ~271행). **한 덩이 앞만.**
- GPU 공용 판정: `usesGpu()`(`readerQueue.ts` ~57행, 참조·qwen-custom) → `setReaderRunning` → 합성 차단 판정 `readerJob`. 낭독은 시작 전 `synthesisBusy('낭독')` 확인.

### 1-5. 캐시 [코드]
- 위치: `<userData>/readerChunks/*.wav`, 이름 = `sha256(voiceKey + 읽을 글)` 앞 24자리(reader.ipc ~52행).
  voiceKey = `kind:engineId:경로`. 감정 켬이면 글에 덩어리 JSON, 키에 `|감정`.
- 키에 **없는 것**: 모델·참조 파일의 내용·수정 시각, 설계 목소리 json 내용, 감정 모델 경로, 엔진·qwen_fast 판. 같은 경로의 파일이 바뀌면 옛 소리가 나올 수 있다([코드], 실측 아님).
  빠르기는 재생 쪽에서만 적용하므로 키와 무관(정상).
- 무효화: 400MB 초과 시 수정 시각 오래된 것부터(`trimCache` ~63행). 적중 때 시각을 갱신하지 않아 실제로는 **만든 순서대로** 지운다(주석 '오래 안 쓴 것부터' 와 다름). 수동 비우기 `reader:clear-cache`.
- 큐: 목소리·괄호 한자 설정·감정이 바뀌면 큐를 비운다(`changeVoice`). 디스크 파일은 남아 A→B→A 는 적중.

### 1-6. 문단 이동·목소리 변경·중지 [코드]
- **실행 중 생성을 취소하는 수단이 없다.** 중지는 소리만 멈춘다(`useReadAloud` stop ~192행). 줄에 들어간 작업·상주 요청은 끝까지 간다.
  그래서 목소리를 바꾸거나 자리를 옮기면 새 첫 덩이가 **앞 작업이 끝날 때까지 줄에서 기다린다.**
- 목소리 변경: 소리 멈춤 + 큐 비움, 자리는 유지. 옛 결과는 voiceKey 가 달라 버림.
- 문단 이동: 기존 경계면 `seek`(지나온 것 버림, 만드는 중은 유지). 새 경계면 다시 나누고 큐 재생성 → **0절 결함 2** 위험.

## 2. 현재 구현 — 합성 카드

- 목소리 종류: `cardVoiceOf`(`shared/synthesisCardVoice.ts` ~69행) — 기본 목소리 > 참조 원본 > 없음. 요청은 `startCardGeneration`(`lib/cardSynthesis.ts` ~347행).
- **생성마다 `separate.py` 새 프로세스**(`audio:process`, `audio.ipc.ts` ~890행 → `tts_worker`). 엔진 캐시는 그 프로세스 안에서만 산다.
  - Supertonic 카드: 생성마다 모델을 새로 연다(낭독 상주 실행기 안 씀).
  - 참조 목소리 카드: 한국어 + Qwen 있으면 qwen3 일괄(`_synthesize_qwen_job` → `qwen_bridge.py` 새 프로세스, Base). 참조 방식 auto = ICL 먼저, 정렬 실패 시 x-vector 로 한 번 더(~4010행).
    한국어가 아니거나 Qwen 없으면 문장별(GPT-SoVITS → 실패 시 piper/Kokoro, 영어 F5).
  - Qwen 지정 목소리 카드: `QwenCustomEngine`(`tts_worker.py` ~509행)이 **이름 있는 파이프로 상주 실행기에** 붙는다(`_via_resident` ~620행, 실패하면 조각마다 새 프로세스).
    감정 있는 줄만 1.7B + 영어 지시, 없는 줄은 0.6B. 설계 목소리는 Base 1.7B(상주 필수). 빠르기는 적용 안 함(알림만).
- 참조 준비: `prepareCardReference`(`cardSynthesis.ts` ~267행) → 영상이면 소리 꺼내기 → `runVoicePrep`(자동) 또는 사용자 구간 → 자르기. 카드 클립 자리 `card:<id>`.
  자르기 때 만든 전사는 합성에서 다시 쓰지 않는다([추정] — 요청에 `ttsReferencePrompts` 없음).
- 생성 단위: 카드 1장 = `audio:process` 1회 = 결과 1개(생성본 추가). 안에서 줄 단위 나눔, qwen3 은 토큰 예산으로 한 번 더. **동시 1건**, 카드 대기열 없음.
- 이어 붙이기: `runJoin` → `buildJoinPlan` → `card:join`(`card_join.py`, 음량 맞춤 최대 +6dB·이음매 5ms·피크 0.97). 이어 듣기 결과는 계획 지문으로 재사용.
- 캐시: 같은 글·목소리 재생성도 **재사용 없음**(매번 새 출력 폴더). 바뀐 카드의 생성본은 '수정 전' 표시만.
- 취소: `clientRequestId`(UUID)로 자기 요청만 받음. 멈춤은 프로세스 트리 종료(`audio:cancel`). 단 **상주 실행기 안에서 돌던 조각은 취소 요청이 없어 끝까지 GPU 를 쓴다**([추정]).
  카드 삭제는 실행 중 생성을 멈추지 않고, 결과가 오면 버린다.

## 3. 낭독과 카드 — 같은 것 / 다른 것 [코드]
- 같다: Qwen 상주 실행기 하나 · 감정 표 `qwen_emotions.QWEN_EMOTION_INSTRUCTS` · 합성 차단 판정(`synthesisGate`, 서로 막음).
- 다르다:
  - 입구: 낭독은 표준 입력 직접 요청(감정이면 덩이 전체 1.7B) · 카드는 separate.py → tts_worker → 파이프로 줄마다(감정 없는 줄 0.6B).
  - 기본 목소리: 낭독 상주 · 카드 생성마다 새로.
  - 참조 목소리: 둘 다 상주 없음. 낭독은 준비 실행기 결과 경로를 직접 넘김 · 카드는 `card:<id>` 준비.
  - 기호 규칙: 낭독은 화면 쪽 `speechSymbols.ts` · 카드는 파이썬 `speech_symbols.py` 를 문장별 경로에서만(참조 qwen3 일괄 경로엔 없음).
  - 결과 캐시: 낭독 있음(지문 파일) · 카드 없음.
  - 로그: 낭독은 생성 시간·모델 열림을 남김 · 카드 Qwen 지정 목소리 경로는 실행기 답의 `gen_sec`/`loaded_now` 를 버림.

## 4. 문서와 코드의 차이 [코드]
- `doc/architecture.md`: 낭독 내용 없음. tts_worker '~420줄·F5/Kokoro/GPT-SoVITS'(지금 4천여 줄, Supertonic·qwen 계열), Qwen 상주·카드 이어 붙이기 없음.
- `doc/reader-engine-2026-09-29.md`: 덩이 '15~30초'(지금 12/20/35 + 첫 덩이 4~8초) · '기본 목소리 누르기 전 덩이 셋'(지금 최대 7) · '줄에 표시를 안 남긴다'(지금 GPU 목소리는 readerJob) ·
  'CustomVoice 는 낭독용으로 받지 않았다'(뒤집힘, 주석 없음) · §6 reader-aloud 검사 'piper'(목록에서 빠짐).
- `doc/reader-ui-handoff-2026-09-29.md`: GUI 초안 단계 — 엔진 미연결·복원 없음·UTF-8만 등 대부분 지나간 내용. 캐시 키 '설정 지문'은 실제로 '목소리 경로 + 읽을 글'.
- `doc/synthesis-card-connection.md`: '감정 보내지 않음'(지금 지정 목소리+1.7B 는 보냄) · '속도 네 엔진 모두'(Qwen 지정 목소리는 무시) · '최종 음성 비활성'(이어 듣기·저장 구현됨).
- `doc/synthesis-card-feature-map.md`: '다시 시도 단추 없음'(있음) · '옛 작업 가져오기 없음'(있음).
- 코드 주석: `trimCache` '오래 안 쓴 것부터'(실제 만든 순서).

## 5. 기존 성능 자료

현재 버전 적용 판단 근거: `cdc442a`(10-02) 이후 낭독 생성 경로를 바꾼 커밋은 `9b135ba`(설계 목소리 분기 추가)·`0a5e455`(modelId 필드)·`ff6f3f2`(폴더 가져오기)뿐 — 소희·Supertonic 속도 경로는 그대로.
**원본 결과 파일은 거의 남아 있지 않다.** 수치 출처는 대부분 `doc/changelog.md` 와 `doc/reader-engine-2026-09-29.md` 의 문장이다. GPU 는 RTX 5070 Ti.

### 지금도 적용되는 자료
- **소희 낭독 상주 + 가속** — 10-01 `3ef3de3`·`714aa0f` [실측, 앱 GPU 검사 `test/e2e/reader-qwen.e2e.mjs`(AF_E2E_GPU=1) 의 INFO 출력]
  - 모델 열린 상태 생성 배수 x0.95 → x2.85 → **x3.49**.
  - `714aa0f` 기준: 첫 덩이 8.2초 분량 3.4초, 둘째 18.6초 분량 5.1초(낭독 덩이 생성 시간 — 첫 재생 시각 아님).
  - **덩이 사이 끊김 0ms (4번 중 4번)** — 일회성 측정, 재는 스크립트·검사가 저장소에 없다. 끊김은 '이어 틂 지연'이며, 이음의 자연스러움·말끝 보존은 잰 적 없다.
  - 되감아 다시 듣기 대기 2.8초 → 0초(캐시 적중).
  - 다른 ComfyUI 가 GPU 99% 쓰면 x1.3~1.7.
- **소희 첫 소리 앞당기기** — 10-02 `cdc442a` [실측, 측정 스크립트 없음]
  - 사용자 기록: 고른 뒤 첫 소리 79초(GPU 99% 경합, 첫 덩이 생성 16.5초).
  - 빈 GPU 분해: 모델 열기 13초 = 불러오기 6.5(torch 1.9·qwen_tts 4.6) + 올리기 3.3, 첫 생성 준비 +1.3, 세션 첫 디스크 읽기 +7.3(처음 한 번 17.1초).
  - 고친 뒤 '고른 순간 → 첫 소리'(낭독 첫 재생): 15.5초 → 곧바로 12초 안팎 · 4초 둘러보면 8초 · 8초면 6초. 첫 덩이 생성 4.3 → 2.1초.
  - 디스크 미리 읽기 이득(최대 7초)은 **[추정]**(OS 캐시를 비울 수 없어 미측정).
- **낭독 감정(1.7B 덩이 전체)** — 10-02 `37737ed` [실측, MCP 실제 앱]: 모델 열린 상태 5.9초 분량 4.3초 · 12.8초 분량 5.6초 · 4.5초 분량 1.9초(x1.4~2.5). GPU 경합 99% 면 x0.5~0.6(낭독이 멈칫).
- **설계 목소리(Base 1.7B)** — 10-02 `9b135ba` [실측]: 소녀 첫 덩이 7.3초 분량 2.3초 · 둘째 17.1초 분량 5.4초(x3.2), 6목소리×3문장 평균 x3.1.
- **카드 감정 생성(1.7B 상주)** — 10-01 `d870738` [실측, MCP 실제 앱] — **카드 생성 완료 시간**(낭독 아님): 첫 번 13.7초(1.7B 열기 포함) · 다음 2.4초(예전 30~60초).
- **큰 책 화면 반응** — 09-30 `a8f0006` [실측, `test/e2e/reader-bigbook.e2e.mjs`]: 3만 문단 열기 3.7→0.28초, 문단 누름 120~170→23~35ms. 생성 시간 아님.

### 지금은 맞지 않는 자료 (참고용)
- Supertonic 속도(09-30 `6e928bc`): 모델 열기 0.86초, 10초 분량 1.7~2.0초(x5~6) — 당시 조각마다 새 프로세스. 지금은 상주라 이보다 빠를 것([추정]), 상주 상태로 다시 잰 값 없음.
  10-01 기록 'Supertonic 첫 소리 약 4초(CPU 가 다른 일로 바쁠 때, 모델 열기 포함)'.
- 참조 목소리(Qwen 0.6B Base, 09-30, `python/bench_tts.py --repeat 2`): x0.35, 고정비 11초 — 이후 `88fa6b9` qwen_fast 로 19.1초 분량 생성 56→18.8초·전체 67→34.7초. **낭독 참조 목소리의 현재 덩이별 시간은 잰 값이 없다.**
- qwen_fast 비교 벤치(09-30 `88fa6b9`, `python/bench_qwen_fast.py`): 29 → 27.5 → 약 10초 — 이후 본 모델·값 뽑기까지 묶여 더 빨라짐.
- piper 속도 공식(09-29, `scripts/measure-read-aloud-speed.mjs`) — **카드 생성 완료 시간**이었고 piper 는 목록에서 빠짐. 스크립트는 시작 화면 처리가 없어 지금 그대로는 안 돈다.
- 참조 목소리 시간 수식 45초 + 길이×2.47(09-29) — [추정], 원본 없음.
- 소희 구간별 분석(09-30 `7e7f80f`, 보조 모델 74%) — qwen_fast 이전.

### 남은 원본 파일
- `_local/tmp/qf_fast.npy`·`qf_orig.npy`(09-30, qwen_fast 비교용 배열)만 남음. 그 밖 `_local/experiments/perf-2026-09-25`·`longform-2026-09-25/result.json`·`_local/artifacts/bench/*` 는 낭독 이전 합성·분리 벤치.

## 6. 관리자가 직접 재는 방법 (MCP)

등록: `.mcp.json` 의 `audioforge-devtool` → `tools/mcp/server.cjs`(앱 전용 기능 `tools/mcp/audioforge.cjs`, 설명 `doc/mcp-devtool.md`). 이 폴더에서 새 세션을 열어야 붙는다.

### 지금 쓸 수 있는 것
- `app_state` — reader: 책·문단·자리·목소리·엔진·재생 단추 상태·`reader-state` 글('목소리를 만드는 중입니다'/'차례를 기다리는 중입니다'/'읽는 중'). 시각 없음.
- `audio_now` — 재생 중 소리 요소의 파일·멈춤·현재 시각·길이·빠르기. 시작 시각 없음.
- `ui_wait` / `js_eval` — 화면 상태 반복 조회(최소 간격 300ms).
- `logs`(source:'app') — 앱 로그 `<userData>/logs/audioforge-YYYY-MM-DD.log`(MCP 실행은 `_local/tmp/mcp-<pid>/userdata/logs/`). 줄마다 ms 시각.
- `api_call reader.speak` — 직접 부르면 `{path, cached, timing}`(캐시 적중 여부가 여기서만 보인다).
- `wait_idle`, `audio_inspect`, `errors`.

### 필요한 관측별 현재 가능 여부
- 재생 요청 시각: **부분** — 시작 단추만 `[reader] 시작 — 덩이 i/n · 목소리 …` 로그. 덩이별 요청은 기록 없음.
- 생성 시작: **불가** — 로그 없음(줄 대기 시간도 안 남음).
- 생성 완료: **가능** — `[reader] 만듦 kind= voice= 글자= N.Ns 상주(모델 엶) 생성= 소리=`(reader.ipc ~327행). N.Ns 는 줄 대기를 뺀 시간.
- 실제 재생 시작: **불가** — 기록 없음. `audio_now` 반복 조회로 300ms 해상도 어림만.
- 다음 구절 준비·버퍼 부족: **부분** — 지금 덩이가 '만드는 중' 인지만 화면 글로. 다음 덩이 준비·미리 불러 둠·끊김 ms 는 노출 없음.
- 문단 이동 후 새 구절 재생 시작: **불가** — 이동·재생 시작 기록 없음.
- 캐시 적중: **화면 경로에서는 불가** — 렌더러가 `cached` 를 버리고 로그도 없음.
- 모델 열기·준비(prepare/warm) 시간: **불가** — `(모델 엶)` 표시만, `prime_sec`·prefetch 완료 미기록.

### 측정 시 함정 [코드]
- MCP 는 앱을 `AF_E2E=1`(GPU 끔 검사 모드)로 띄운다. 이때 `reader:prepare`·Qwen `reader:warm` 이 **건너뛰어진다**(reader.ipc ~373·~397행) — 첫 소리 앞당기기 효과가 빠진 수치가 나온다.
  생성 자체(`reader:speak`)는 막지 않아 GPU 를 그대로 쓴다. 실제 앱과 같은 첫 소리를 재려면 `AF_E2E_GPU=1` 환경으로 띄워야 한다.
- MCP 는 다른 프로그램의 GPU 점유를 보고 막지 않는다. 다른 ComfyUI·VLM 이 돌면 Qwen 수치가 반 토막 — 측정 전 GPU 확인 필요.
- 검사·MCP 창은 소리를 끈 채 뜬다(재생 시각·값은 그대로 나온다).

### 최소 추가안 (구현하지 않음 — 승인 대기)
로그 한 줄씩만 더하면 위 '불가' 대부분이 앱 로그로 잡힌다. 구조 변경 없음.
1. `useReadAloud` 덩이 요청을 보낼 때: `요청 덩이 i/n 글자 N`.
2. 본체 `makeChunk` 줄에 들어간 순간과 시작 순간: `생성 시작 덩이 대기 X.Xs`(줄 대기 시간).
3. `reader:speak` 응답이 캐시면: `캐시 적중 덩이 i`(렌더러가 `cached` 를 기록).
4. 소리 요소 `playing` 사건: `재생 시작 덩이 i (요청부터 X.Xs)` · 미리 불러 둔 요소로 넘어갈 때 `이어 틂 덩이 i 간격 Nms`.
5. 재생 중 지금 덩이가 준비 안 됨으로 바뀔 때: `버퍼 부족 덩이 i`.
6. `seekToChar`/`pickParagraph`: `자리 이동 → 덩이 i`(이후 4번과 짝지으면 '이동 후 첫 소리').
7. `reader:prepare`·`reader:warm` 결과와 시간(`prime_sec`, `loaded_now`).
