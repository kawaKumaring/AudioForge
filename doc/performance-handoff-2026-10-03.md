# 성능 검수 인계 — 낭독 · 합성 카드 (2026-10-03)

> 목적: 관리자가 현재 구조와 기존 측정 근거를 직접 검수하기 위한 인계. **최적화·구조 변경 없음.**
> 기준 코드: develop `d0eda7f`. 행 번호는 그 시점 기준의 대략값(편집하면 어긋난다 — 함수 이름으로 찾을 것).
> 근거 수준 표기: [코드] 코드를 읽어 확인 · [실측] 과거 측정 · [추정] 이론값·계산 · [미확인] 확인하지 않음.

## 0. 검수 중 발견한 결함

> **2026-10-03 후속 — 세 건 모두 재현 후 수정.** 아래 1~3 은 발견 당시의 기록이다. 수정 내용:
> 1. 재현: 실제 앱에서 긴 검사용 말소리 → 구간 잘라 씀 → 창 닫기 → 다시 켜기 → 소리 파일 없음·'찾지 못했습니다'·낭독 시작 막힘(`reader-ref-voice-restart.e2e` 수정 전 4 실패).
>    결정: 원본+구간을 저장해 켤 때마다 다시 준비(원본이 옮겨지면 깨짐·매번 분석·구간이 달라질 수 있음) 대신 **앱이 관리하는 보관본**(`userData/readerVoices/<내용 지문>.wav`, `services/reader-voice-store.ts`) — 고른·최근 목소리가 가리키는 것만 남긴다. 임시 조각 청소는 그대로.
>    원본 그대로 쓰는 짧은 파일은 원본 경로 그대로(복사 안 함). 보관이 실패하면 이번 실행에서만 쓰고 저장하지 않는다(사유 표시). 수정 후 11/11.
> 2. 재현: 실제 낭독 엔진에 응답을 붙들었다가 옛 1번 응답을 먼저 풀기 — 성공이면 옛 글 소리가 새 자리에서 재생, 오류면 새 자리가 실패(`reader-resplit.component` 수정 전 4 실패).
>    수정: 요청마다 이름표(`세대.번호`)를 큐 자리에 붙이고, 같은 목소리 + 바로 그 요청 + 같은 세대 + 같은 글일 때만 받는다(`readerQueue.acceptResult` · `useReadAloud`). 수정 후 12/12.
> 3. 재현: 받는 목소리(Qwen+1.7B)에서 요청에는 감정이 실리는데 '미적용' 표시(`synthesisCardJob.test` 새 검사 실패).
>    수정: 보내는 판정 하나(`emotionSent`)를 요청(`cardScriptWithEmotion`)·표시·생성본 기록(`cardApplied(설정, 목소리)`)이 함께 쓴다. 감정 품질을 뜻하는 표시는 만들지 않았다(보내지 않을 때만 '미적용').

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

### 관측 기록 `reader_trace` (2026-10-03 추가 — 관리자 승인 '최소 관측')
재기만 한다 — 합성·큐·재생 동작은 이 기록을 읽지 않는다. 위치: 화면 `src/renderer/lib/readerTrace.ts`(기록 통) · `src/renderer/hooks/useReadAloud.ts`(사건 지점) ·
본체 `src/main/ipc/reader.ipc.ts` `reader:speak`(단계 길이를 응답에 싣는다) · MCP `reader_trace`.
- 시계: 화면 `performance.now()`(ms, 단조). 본체 단계 길이는 본체 단조 시계로 잰 **길이**로만 받는다(두 프로세스 시계를 섞지 않는다).
- 보관: 최근 500개(넘으면 오래된 것부터), 파일에 쓰지 않는다. 본문·경로·전사 없음(글은 글자 수, 목소리는 종류·엔진).
- `mode` — `app` · `test(prep-off)` · `test-normal-prep`. ★`test(prep-off)` 수치는 보통 실행 성능으로 보고하지 않는다.

필요한 관측 → 사건
- 요청 ID·낭독 세대: `gen-request`/`gen-done` 의 `req`(=`세대.번호`)·`gen`. 세대는 덩이를 다시 나누거나 목소리를 바꿀 때 오른다(`resplit`·`voice-change`).
- 생성 요청·실제 생성 시작·완료: `gen-request`(화면이 보낸 때) · `gen-start`(본체가 줄에서 실제로 시작한 때 = 응답 시각 − `makeMs`, `derived:true`) · `gen-done`(`waitMs` 본체 줄 대기, `makeMs` 생성 길이, `accepted` 받아들였나).
  ★`gen-start` 는 응답이 돌아오는 IPC 시간(보통 수 ms)만큼 늦게 찍힐 수 있다.
- 실제 재생 시작: `play-start` = 소리 요소의 **playing 사건**(생성 완료·play() 호출 아님). `sinceRequestMs` = 시작/이동 누름부터, `gapMs` = 앞 덩이가 끝난 때부터, `via` = 미리 불러 둔 요소로 이어 틀었나.
  ★스피커까지의 장치 지연은 들어 있지 않다. 소리를 끈 검사 창에서도 사건은 같게 난다.
- 버퍼 부족: `buffer-low-start`(재생 중 지금 덩이가 준비 안 됨, `initial:true` 면 시작·이동 직후의 첫 소리 대기) → `buffer-low-end`(`lowMs`, 다음 실제 재생 시작에서 닫힘).
- 문단 이동: `seek-request` → 다음 `play-start`(`after:'seek'`, `sinceRequestMs` = 이동 후 첫 소리).
- 캐시 적중·모델 최초 로딩: `gen-done` 의 `cached`(본체 디스크 캐시) · `shared`(같은 요청이 이미 가 있어 함께 받음) · `modelOpened`(이번 덩이에서 모델을 열었나) · `engine`.
  `play-request` 의 `readyAtRequest` — 누르기 전에 큐가 이미 만들어 둔 자리(요청도 캐시 조회도 없다).
- 기록하지 않는 것(남은 제한): 목록을 열 때·고를 때의 미리 준비(`reader:prepare`·`reader:warm`)의 결과와 걸린 시간·`prime_sec` · 파이썬 안 단계(불러오기·모델 올리기) 분해.

정확성 확인(관측 자체) — 알고 있는 지연을 넣고 기록을 대 봄
- `test/e2e/reader-trace.component.mjs` 17/17: 응답 300ms 지연 → 요청→완료 300ms · 생성 시작 = 완료 − 200ms · play() 뒤 250ms 늦춘 실제 재생을 playing 으로 잡음(play() 호출 아님) ·
  재생 도중 버퍼 부족 시작/끝·길이 · 캐시 적중에는 생성 시작 없음 · 미리 불러 둔 이어 틂 · 이동 후 첫 소리 · 옛 세대 응답은 `accepted:false` · 본문·경로 없음.
- `test/e2e/reader-trace-app.e2e.mjs` 9/9(실제 앱·기본 목소리 CPU): 본체 단계 길이·엔진·모델 처음 엶이 화면 기록까지 옴 · 이동 후 첫 소리 · 디스크 캐시 적중(목소리 A→B→A) · `readyAtRequest` · 실행 방식 표시.
- `test/e2e/reader-trace-mcp.cjs` 4/4: MCP 도구 목록 · 기본 실행 표시 · `reader_trace` 읽기·비우기.
- `src/renderer/lib/readerTrace.test.ts`: 500개 상한·오래된 것부터 버림·시각 단조.

### 보통 실행과 같은 조건으로 재는 법
- 검사 모드(`AF_E2E=1`, MCP 기본)가 보통 실행과 다른 점:
  1. 낭독 미리 준비 꺼짐 — 목록을 열 때 Qwen 실행기 띄우기·모델 파일 미리 읽기(`reader:prepare`), 고를 때 모델 열기·첫 생성 준비(`reader:warm`, Qwen).
  2. 켤 때 합성 라이브러리 미리 읽기 꺼짐(`bridge-warmup` — 참조 목소리·카드 첫 생성에 영향).
  3. 사용자 데이터가 새 임시 폴더 — 낭독 캐시가 비어 있다(처음 실행 상태).
  4. 창 소리 끔(시각·사건은 같다) · 화면 밖 창(그리기 멈춤 해제 스위치 켬).
- 1·2 를 보통 실행과 같게: MCP `app_start { prep: "normal" }`(= 환경 변수 `AF_E2E_NORMAL_PREP=1`). 규칙은 `reader-run.ts` `testSkipsPrep` 한 곳. `reader_trace` 의 `mode` 가 `test-normal-prep` 로 찍힌다.
  ★GPU 를 쓴다 — 다른 ComfyUI·VLM 이 GPU 를 쓰는 중이면 Qwen 수치가 반 토막(측정 전 확인, 사건 기록에는 GPU 점유가 없다).
- 세 상태를 나눠 재기(같은 실행 안에서):
  - **캐시 없는 최초 실행** — `app_start`(새 데이터) 직후 첫 재생. 첫 덩이 `gen-done.modelOpened=true`.
    (OS 파일 캐시는 비울 수 없다 — 그 PC 의 이 세션에서 모델 파일을 처음 읽는 경우와 같지 않을 수 있다.)
  - **모델이 열린 실행** — 같은 실행에서 다른 문단·다른 글로 다시 재생. `modelOpened=false`, `cached=false`.
  - **캐시 적중** — 같은 글·같은 목소리를 다시(큐가 비워진 뒤 — 목소리 A→B→A 나 다른 책 다녀오기). `cached=true`, `gen-start` 없음.
    같은 자리를 멈췄다 다시 누르는 것은 큐가 들고 있어 요청 자체가 없다(`readyAtRequest:true`).
- 순서 예: `app_start {prep:"normal"}` → `app_mode reader` → `test_input`(글) + `dialog_queue` → `ui_click testid:reader-add-text` → 목소리 고르기 → `reader_trace {clear:true}` →
  `ui_click testid:reader-play` → `ui_wait`(필요한 사건) → `reader_trace`.

### 측정 시 함정 [코드]
- MCP 는 다른 프로그램의 GPU 점유를 보고 막지 않는다. 다른 ComfyUI·VLM 이 돌면 Qwen 수치가 반 토막 — 측정 전 GPU 확인 필요.
- 검사·MCP 창은 소리를 끈 채 뜬다(재생 시각·값은 그대로 나온다).
- 앱 로그의 `[reader] 만듦 … N.Ns` 는 그대로 있다(줄 대기를 뺀 생성 시간) — `reader_trace` 의 `makeMs` 와 같은 구간.

## 7. 개선 결과 (2026-10-03 — 관리자 실측 기준 후속)

근거 자료: `_local/perf-ref/`(측정 스크립트·결과 JSON) · 청취 자료 `_local/artifacts/performance-2026-10-03/reference-listen/`(참조 낭독 전후 4쌍, 사람 청취 판정 전).
GPU 상태는 결과마다 함께 적었다. 다른 프로그램이 GPU 를 쓰던 측정은 비교에 쓰지 않고 따로 표시한다.

### 7-1. 참조 목소리 연속 낭독 (모델·엔진 그대로: Qwen3-TTS 0.6B Base, 참조 특징만 쓰는 안전 방식)
- 병목 분해(같은 참조·같은 글, `scripts/bench-reader-reference.mts`): 덩이마다 새 프로세스 기동·장치 조회 1.8초 + 모델 열기 9~10초(매번) + 생성(실시간 0.6~0.9배).
  생성이 느린 까닭 = `qwen_fast` 본 모델 묶어 실행이 브리지 계수기 때문에 꺼져 있었다. 참조 전사(Whisper)는 낭독 경로에서 돌지 않는다.
- 고친 것: 빠른 길이 '세기만 하는' 계수기를 받음 · 띄워 둔 실행기가 같은 `qwen_bridge.run_loaded` 를 불러 둔 모델로(참조 특징은 소리 지문·전사·방식·모델 기준 캐시) ·
  실행기에 맡길 때는 덩이마다 torch 를 부르던 장치 조회·환경 기록 생략.
- 덩이별(같은 조건, GPU 비었을 때): 예전 63.4/38.0/46.1/83.9초 → 지금 첫 덩이 12.1초(모델 열기 포함), 그다음 4.5~5.9초(소리 13.8~19.7초, 실시간 3.1~3.4배).
- 실제 앱 6덩이(GPU 비었을 때): 첫 소리 19.9 → 12.9초, 덩이 사이 대기 23,956ms → 0~1ms, 버퍼 부족 0.
- 실제 앱 7덩이(책 끝까지, **다른 프로그램이 GPU 48~49%·7.3GB 쓰는 중**): 덩이 생성 9.4~11.9초(소리 15~20초 — 실시간 약 1.6배), 덩이 사이 틈 0~1ms ×5,
  첫째→둘째만 3.37초 버퍼 부족(첫 덩이는 첫 소리를 위해 짧게(5.9초) 나누는데 경합 중엔 둘째 덩이 생성이 그보다 길다). 첫 소리 19.7초(미리 열기 줄 대기 12.6초 — 경합 중 모델 열기). GPU 가 비었을 때의 같은 측정(6덩이)은 틈 0.
- 받아 적기 글자 오류율(검사용 글, 실행 1회): 예전 평균 4.8% · 빠른 길만 3.7% · 지금 2.2%. 끝 조용함 0.15~0.53초로 비슷. 음질·화자 유사도·이음 자연스러움은 **사람 청취 전**.

### 7-2. 문단 이동·목소리 변경·멈춤
- 요청 세대(`reader:supersede`): 옛 세대는 시작 전 폐기, 돌고 있는 Qwen 은 정지 파일로 16걸음 안에 멈춤(그 요청에만), 멈춘 소리는 쌓지 않음.
- 실제 앱(소희, GPU 비었을 때): 문단 이동 4.74 → 2.51초(돌던 생성 0.32초 만에 멈춤) · 생성 중 멈춤 → 0.23초 만에 실제 정지, 남은 작업 0 · 생성 중 목소리 변경 → 0.30초 만에 멈춤, 새 목소리 첫 소리 1.76초.
- 멈출 수 없는 단계: 기본 목소리(CPU) 한 덩이(1~3초) — 자리 이동·멈춤 때는 끝까지 간다(목소리를 바꿨을 때만 그 실행기를 내린다). 모델 열기 중인 미리 열기는 끝까지 간다.

### 7-3. 최초 준비
- 기록: 목록 열기·목소리 확정·모델 미리 열기(줄 대기·실제 준비·모델 처음 엶·준비 생성)를 따로.
- 실제 앱(경우마다 새로 켬, GPU 비었을 때 — 기본 목소리 비키기 전 코드): 소희 곧바로 22.09 → 14.8초(모델 준비 9.5초 = 모델 열기 자체, 2.66초 = 고르지 않은 기본 목소리 덩이 뒤 대기) ·
  소희 8초 뒤 재생 → 누른 뒤 5.8초 · 참조 목소리 곧바로 → 누른 뒤 6.6초.
- 그 뒤 '목소리를 바꾸면 기본 목소리 실행기 내림' 을 넣어 미리 열기의 줄 대기가 2,663ms → 7ms 로 줄었다(기록의 waitMs). 이때 GPU 는 다른 프로그램이 48~56% 쓰던 중이라 전체 시간은 비교에 쓰지 않는다.
- 남은 대기: 소희 모델 열기 약 9.5초(라이브러리·가중치·첫 생성 준비)는 모델을 올리는 시간 자체다 — 목록을 둘러보는 시간이 길면 그만큼 사용자 대기에서 빠진다(8초 둘러보면 5.8초).

### 7-4. 카드
- Qwen 지정 목소리 카드: 바꾸지 않음(이미 실행기 재사용).
- 참조 목소리 카드: 띄워 둔 실행기로(모델 재사용), 멈춤은 작업 폴더 정지 파일로 실행기 작업까지. '다시 생성' 은 새 씨앗으로 새로 만든다(이전 파일 반환 없음).
  실제 앱(GPU 경합 중): 같은 대사 두 번 25.1·16.1초, 서로 다른 생성본 · 생성 중 멈춤 → 카드 0.65초, 실행기 2.17초에 빔, 멈춘 생성본 추가 없음.
  카드 참조 합성은 매번 참조 전사(Whisper small)와 정렬을 합성 프로세스에서 다시 한다 — 다음 개선 후보(이번 범위 밖).

### 7-5. 메모리·유휴 해제
- 참조 목소리 미리 열기 +2.5GB, 읽는 동안 +3.2GB(그래픽카드) · 실행기 RAM 약 2.4GB. 유휴 시간(검사 20초, 보통 3분)이 지나면 실행기가 내려가고 그래픽카드가 시작 수준으로 돌아온다(실측).
- 실행기는 모델을 둘까지 든다(소희·참조 Base 를 번갈아 쓰면 둘 다 올라 있을 수 있다).

## 8. 마무리 (2026-10-03 후속) — 재검수 안내

### 첫 소리 분해 (실제 앱 · 보통 준비 · 경우마다 새로 켬 · 측정 시작 GPU 0~23%·0.7~1GB, 다른 프로그램 가벼운 사용)
- 소희 곧바로 재생: 누른 뒤 14.4초 = 모델 준비 9.8초(라이브러리·가중치 — 목록을 거의 안 보고 곧바로 고른 최악 조건) + 첫 구절 생성 4.5초 + 재생 준비 0.1초.
  고르지 않은 기본 목소리 대기 0(예전 2.66초), 준비 생성은 재생이 기다려 생략(예전 2.2~2.4초 후 첫 구절).
- 소희 8초 뒤 재생: 누른 뒤 4.6초(모델 준비가 9초라 1초 남은 것 + 첫 구절 3.5초).
- 참조 곧바로 재생: 누른 뒤 6.8초 = 모델 준비 남은 2.7초 + 첫 구절 4.1초.
- 비교: 관리자 22.09초(소희) · 19.9초(참조) → 이 문서 7-3 의 14.8·6.6초 → 지금 14.4·6.8초(같은 조건 범위 안의 차이 — 남은 대기는 모델 올리기 자체).
- 참조 카드 같은 대사 두 번째 생성: 참조 전사 20~31초 → 0.03초. 전체 시간(7.3초)은 GPU 경합 중 측정이라 비교 기준이 아니다.

### 재현 절차 (저장소 루트, `npm run build` 뒤)
- 카드 취소 세 경로: `node _local/perf-ref/app-card-cancel-all.cjs <결과.json> [sohee|reference|loading]`
- 첫 소리: `node _local/perf-ref/app-first-prep.cjs <결과.json>` · 참조 연속 낭독: `node _local/perf-ref/app-reference-reading.cjs <결과.json> 7`
- 참조 덩이 분해: `npx esbuild scripts/bench-reader-reference.mts --bundle --platform=node --format=esm --outfile=_local/perf-ref/bench.mjs && node _local/perf-ref/bench.mjs --ref _local/perf-ref/ref-clip.wav --out <폴더> --mode resident`
- 회귀 검사: `node test/e2e/reader-remount-epoch-mcp.cjs` · `node test/e2e/tts-cancel-lifecycle.e2e.mjs` · `python -X utf8 python/test_ref_transcript_cache.py`
- 측정 자료: `_local/perf-ref/*.json` · 청취 자료와 조건·해시 `_local/artifacts/performance-2026-10-03/reference-listen/manifest.json`
