# WIP 설계 — 감정별 참조 구간 선택(긴 감정 참조 3~10초) UX

브랜치: `feature/tts-emotion-reference-ux` — origin/develop `0788885`에서 분기. master/develop 병합 금지(별도 승인).
이 문서는 **설계 단계 산출물**이다. 이번 커밋에는 production 소스 변경이 없다(read-only 조사 + 계획).
`python/tts_worker.py`와 pitch 백엔드는 에이전트 A 소유로 설계상 수정 대상에서 제외한다.

## 1. 목적 / 담당 경계

감정별 참조에 **긴 파일(10초 초과)** 을 등록해도, 각 감정마다 3~10초 구간을 골라 확정하고 그 파생
클립을 재사용할 수 있게 한다. 기본 참조에 이미 있는 구간 선택 UX(`ReferenceRegionPanel`)를 감정
참조로 **여러 개 동시에** 안전하게 확장하는 것이 핵심.

담당: 감정별 참조 등록 UI · 파생 클립 수명 · 직렬화 · IPC. 기본 참조의 구간 UI 로직 재사용.
단일 `currentRefClipDir` → 감정별 식별 가능한 구조로 확장. 기본 화면은 단순 유지(고급 패널 안 배치).

## 2. 현황 조사 (read-only 확인 사실)

### 2.1 기본 참조(default) 경로 — 이미 완성된 흐름
- `ReferenceRegionPanel.tsx`: `fileInfo.path` 한 개에 하드코딩. `analyzeReference` → 10초 초과면 파형/추천
  구간 표시 → `trimReference(path,start,dur)` → 파생 클립 경로를 `setTtsRefState({clip,ready,region})`로 store에.
- store(`app.store.ts`): 기본 참조 상태가 **단일 슬롯** — `ttsReferenceClip / ttsRefReady / ttsRefMessage /
  ttsReferenceRegion`. `setTtsRefState`가 이 네 값만 갱신.
- IPC(`audio.ipc.ts`): 모듈 전역 `currentRefClipDir: string | null` **단일**. `trim-reference`가 매번
  `audioforge_refclip_<uid>/reference_clip_24k.wav`를 만들고 `currentRefClipDir`에 그 폴더를 기록.
  `releaseRefClip()`이 그 하나를 지운다. `analyze-reference`는 새 파일 key일 때만 이전 클립 폐기.
- ProcessButton은 `ttsReferenceClip`을 `ttsReferenceOverride`로 전달. 게이팅은 `ttsRefReady` **하나**만 본다.
- Python `separate.py`: `resolve_reference_input(override, input)` — override가 있으나 파일이 없으면
  **원본 폴백 금지·명확히 실패**(만료). `ref-trim` 모드는 `args.output`에 고정 파일명으로 트림(경로는 main이 결정).

### 2.2 감정 참조(emotion) 경로 — 구간 선택이 전혀 없음 ★핵심 격차
- store `ttsEmotionRefs: Record<emotionId, string>` — 값은 **사용자가 고른 원본 파일 경로 그대로**.
- `TTSEditor.tsx`의 "감정별 음성 등록" 패널: 파일 선택 시 `emotionRefs[id] = 원본경로`만 저장. 분석·트림·게이팅 없음.
- 직렬화 `ttsConfig.ts`: `ttsEmotionRefs`는 `Record<string,string>` 그대로 Python에 전달.
- Python `tts_worker.synthesize`: 감정 refs 각각을 `_prepare_ref(emo_path)`만 통과시킨다. `_prepare_ref`는
  **WAV면 무변환 통과, 비WAV면 mono/24k 트랜스코딩만** — 즉 **길이를 자르지 않는다**. 3분짜리 WAV 감정
  참조는 통째로 사용된다. 게다가 `if emo_path and os.path.exists(emo_path)`라 **없으면 조용히 건너뛰고**
  기본 참조로 대체(기본 참조의 만료 정책과 상반된 silent fallback).
- 결론: 긴 감정 참조는 (a) 품질 저하/합성 오류 위험, (b) 만료 시 조용한 대체 — 둘 다 기본 참조에서 이미
  해결한 문제인데 감정 경로에는 미적용.

### 2.3 만료·정리 자산 (재사용 가능)
- `refclip-cleanup.ts`: `removeRefClipDir(tmpDir,dir)`(단일 안전 삭제), `sweepRefClipDirs(tmpDir)`(prefix
  `audioforge_refclip_` 직속 폴더 전부 삭제). **이미 다수 폴더를 다룰 수 있다** — 키 확장 시 그대로 재사용.
  앱 시작/종료 sweep, 합성 중(`runner.isRunning`) 삭제 금지 가드도 이미 존재.

## 3. 자료구조 설계 — 단일 → 감정별 식별 구조

식별자 `clipKey = 'default' | <emotionId>`. `emotionId`는 `TTSEditor` EMOTION_GROUPS와
`tts_worker.EMOTION_TAGS` 값이 공유하는 그 id(예: `happy`, `sad`) — 새 키 체계를 만들지 않고 기존 id 재사용.

### 3.1 메인(audio.ipc.ts): `currentRefClipDir: string|null` → `refClipDirs: Map<clipKey,string>`
- `trim-reference(path, start, dur, clipKey)`: 해당 key의 이전 폴더만 `removeRefClipDir` 후 새 폴더 등록.
- `release-reference-clip(clipKey?)`: key 지정 시 그 하나만, 생략 시 **전체** 정리(setFile/reset용).
- `analyze-reference(path, clipKey)`: 새 (key,path) 조합일 때 그 key의 이전 클립만 폐기.
- 앱 시작/종료 `sweepRefClipDirs`는 그대로(prefix 기반이라 키 무관하게 모든 잔존 폴더 회수).
- 합성 중이면 `release-reference-clip`은 `runner.isRunning`으로 전량 거부(기존 규칙 유지).

### 3.2 렌더러 store: 감정별 클립 상태 슬롯
- 기본 참조의 단일 슬롯은 **그대로 유지**(회귀 최소화). 감정용으로 병렬 맵 추가:
  `ttsEmotionClips: Record<emotionId, { rawPath: string; clip: string; region: {start,duration}|null;
  ready: boolean; message: string }>`.
  - `rawPath` = 사용자가 등록한 원본(분석·재생·전사 대상). `clip` = 확정된 3~10초 파생(없으면 '').
  - 3~10초 유효 원본이면 `clip=''`이지만 `ready=true`(원본 그대로 사용 — 기본 참조 `valid_whole`과 동일).
- `ttsEmotionRefs`(직렬화용)의 **의미를 "효과적 참조 경로"로 재정의**: 파생 클립이 있으면 그 경로, 없고
  원본이 유효(≤10초)하면 원본 경로. → Python 계약(`Record<string,string>`) 불변, `_prepare_ref` 입력이
  항상 짧은 파일이 되도록 렌더러가 보장. **Python 수정 0**(tts_worker/separate 불변, A 경계 보호).

### 3.3 만료 처리
- 감정 파생 클립도 기본과 동일하게 **만료 시 원본 폴백 금지**. 단 감정은 Python이 silent-skip하므로,
  만료 방지를 **렌더러 게이팅**에서 처리한다(§4): "사용되는" 감정 클립이 존재하지 않으면 합성 차단 + 재확정 안내.
  즉 만료된 경로를 애초에 `ttsEmotionRefs`로 보내지 않는다 → Python silent-skip 경로에 도달하지 않음.

## 4. 게이팅 개선 — 미사용 감정 참조가 합성을 막지 않게

현재 `ProcessButton`의 `ttsBlockReason`은 `ttsRefReady`(기본) 하나만 본다. 감정 참조는 게이팅에 없음.
감정에 구간 확정을 도입하면 "등록만 하고 대사에 안 쓰는" 감정이 전체 합성을 막는 부작용이 생길 수 있어
아래 원칙으로 설계한다.

- **사용 판정**: `ttsText`를 파싱해 등장하는 `[label]` → emotionId 집합을 구한다(EMOTION_TAGS 매핑 재사용).
  기본 참조는 태그 없는 줄·자기 참조 없는 태그의 폴백이라 **항상 사용**으로 간주.
- **차단 대상**: 대사에 등장하는 emotionId 중, 그 감정에 등록된 참조가 (구간 확정 필요한데) 미확정이거나
  파생 클립이 사라진 경우만. 이때 "[기쁨] 참조 구간을 확정하세요" 식 감정 지목 사유 표시.
- **비차단**: 대사에 안 쓰이는 감정 참조는 준비 상태와 무관하게 합성을 막지 않는다. 또한 **전송에서도 제외**
  (`ttsEmotionRefs`에 넣지 않음) — 미확정/긴 원본이 Python으로 새지 않게.
- **전송 규칙**: `ready=true`인 감정만 효과 경로로 전송. 사용되지만 미준비면 위에서 이미 차단됨.

## 5. IPC / preload 변경(설계)

- `preload/index.ts`: `trimReference(path,start,dur,clipKey)`, `analyzeReference(path,clipKey)`,
  `releaseReferenceClip(clipKey?)`로 시그니처 확장(clipKey 생략 시 'default'/전체로 하위호환).
- `audio.ipc.ts`: 위 핸들러가 clipKey 수신 → `refClipDirs` 맵 운용. `audio:process`의 result 메타데이터에
  감정 구간 기록은 §7(스키마)로 분리(A와 조정 후).
- `separate.py` **불변**: `ref-trim`은 main이 주는 `output` 폴더에 트림만 하므로 key별 폴더 분리는 main이 결정.

## 6. ReferenceRegionPanel 재사용(파라미터화)

현재 컴포넌트를 props화: `path`, `clipKey`, `value(현재 clip/region/ready)`, `onChange(setter)`, `disabled`.
- 기본 참조는 `clipKey='default'` + store 단일 슬롯 setter를 넘겨 **기존 동작 회귀 유지**.
- 감정 참조는 "감정별 음성 등록" 패널(고급, 기본 접힘) 안에서, 10초 초과로 판정된 등록 감정마다 인스턴스 1개
  렌더 + 그 감정의 store 슬롯 setter 전달. 여러 인스턴스가 서로 다른 clipKey/path라 상호 간섭 없음.
- single-flight는 이미 파일 절대경로 key라 감정별 동시 분석도 안전(경로가 다르면 분리 실행).

## 7. 직렬화 / metadata 스키마 (A와 조정 필요)

- `ttsConfig.ts`: 핵심 흐름은 `ttsEmotionRefs: Record<string,string>` **의미 재정의만**으로 Python 계약을
  건드리지 않는 것이 목표. 감정별 구간을 **재현 메타데이터**로 남기려면 `ttsEmotionRefRegions:
  Record<emotionId,{start,duration}>` 옵션 필드 추가가 필요 — 이는 A(pitch)의 metadata 확장과 **같은 파일**을
  건드리므로 **코딩 전 조정**.
- result metadata(`audio.ipc.ts` result 핸들러 + `_build_tts_metadata`): 감정 구간 기록은 A의 pitch 필드와
  병합 순서 조정 후. `tts_worker._build_tts_metadata`는 A 소유라 B는 렌더러/ipc 레벨 기록만 하거나 A와 합의.

## 8. 정리 규칙 요약 (해당 클립만)

- 새 파일(`setFile`): 전체 감정 클립 + 기본 클립 정리(`releaseReferenceClip()` 전량) + 감정 상태 초기화.
- 감정 재등록/변경: 그 emotionId 클립만 정리 후 재분석.
- 감정 삭제(X): 그 emotionId 클립만 정리 + 슬롯 제거.
- `reset`: 전량 정리 + `ttsEmotionRefs/ttsEmotionClips` 초기화.
- 앱 종료: `sweepRefClipDirs`(전량, prefix 기반) — 기존 그대로.
- 합성 성공/오류/취소 후: **유지**(재합성 위해). 삭제는 위 이벤트에서만.
- 합성 중: 어떤 정리도 금지(`runner.isRunning` 가드).

## 9. 검증 계획

단위/통합:
- refclip-cleanup: 다수 key 폴더 공존 시 특정 key만 remove / 전량 sweep 회귀.
- store: 감정 재등록이 타 감정 슬롯 불변, 삭제가 해당 슬롯만 제거, reset/ setFile 전량 초기화.
- ttsConfig: `ttsEmotionRefs` 값이 (파생 있으면 파생 / 유효 원본이면 원본 / 미준비면 미포함)으로 직렬화.
- 게이팅 selector: 대사 태그 파싱 → 사용 감정만 차단, 미사용은 비차단·미전송.

Electron E2E(실 앱 구동, 기존 하네스 확장):
- 기본+기쁨+슬픔 **세 파생 클립 동시 유지**(각 폴더 존재, 서로 다른 경로).
- 한 감정 재확정 시 타 감정 클립 파일 불변(경로/해시 대조).
- 대사 `[기쁨]/[슬픔]` → 각 태그가 **올바른 감정 클립 경로**로 전달됨(config JSON 검사).
- 연속 합성(같은 감정 클립 2회) — 재합성 race 없음.
- reset·앱 종료 후 refclip 폴더 0.
- 긴 감정 참조(예: 111초)가 **모델 로딩 전** 처리(구간 확정 강제) — 긴 원본이 Python으로 안 감.
- 미사용 감정 참조(등록했으나 대사에 태그 없음)가 합성을 **막지 않음** + config에 미포함.

## 10. 소유 파일(구현 시 수정 예정)

- `src/renderer/components/ReferenceRegionPanel.tsx` — props 파라미터화.
- `src/renderer/components/TTSEditor.tsx` — 감정 등록 UI에 구간 패널 배치, 사용 태그 계산, 효과 경로 반영.
- `src/renderer/stores/app.store.ts` — `ttsEmotionClips` 슬롯, keyed release 호출, 정리 규칙.
- `src/renderer/components/ProcessButton.tsx` — 게이팅 확장(사용 감정만), 전송 필터.
- `src/main/ipc/audio.ipc.ts` — `refClipDirs` 맵, clipKey IPC.
- `src/preload/index.ts` — trim/analyze/release clipKey 시그니처.
- `src/main/services/refclip-cleanup.ts` — 대체로 불변(다수 폴더 이미 지원); 필요 시 key 헬퍼만.
- 테스트: `src/shared/ttsConfig.test.ts`, refclip-cleanup 테스트, store 테스트, E2E 스펙.
- (조정 후) `src/shared/ttsConfig.ts` — 감정 region 메타 필드(옵션).

## 11. 첫 작업 계획(구현 착수 순서)

1. 메인 트래커 단일→keyed(`refClipDirs` Map) + IPC/preload clipKey 파라미터 + release 전체/단일. 회귀 테스트로 고정.
2. store `ttsEmotionClips` 슬롯 + keyed release 배선(재등록/삭제/setFile/reset).
3. `ReferenceRegionPanel` props화 — default 경로 회귀 유지 확인.
4. `TTSEditor` 감정 등록 UI에 구간 패널(고급 패널 내) + `ttsEmotionRefs` 효과 경로 반영.
5. `ProcessButton` 게이팅 — 사용 감정만 준비 요구, 미사용 비차단·미전송.
6. 정리 규칙 E2E(세 클립 공존/재확정 불변/올바른 전달/연속 합성/reset·종료 정리/긴 참조 로딩 전 처리).
7. (A와 조정 후) metadata 감정 region 기록 + `TtsResultInfo` 표시.

## 12. 에이전트 A(pitch)와 충돌 가능 공용 파일 — **코딩 전 조정 필요**

- `src/shared/ttsConfig.ts` — A: pitch 필드(TtsInputOptions/TtsConfig/buildTtsConfig). B: 감정 region 옵션
  필드(선택). **같은 리터럴/인터페이스 확장 → 조정 필요.**
- metadata 스키마(`_build_tts_metadata` in tts_worker[A 소유] + `audio.ipc.ts` result 핸들러) — 둘 다 확장.
  **조정 필요**: 스키마 확장은 한쪽이 먼저 develop 반영 후 다른 쪽 rebase 권장.
- `src/renderer/components/TtsResultInfo.tsx` — A: pitch 표시. B: 감정 구간 표시. **같은 결과 카드 → 조정 필요.**
- `src/main/ipc/audio.ipc.ts` — A: result 메타 pitch 병합. B: refClipDirs·clipKey·감정 region 메타.
  파일은 공용이나 편집 영역이 다름(A=result 핸들러 metadata, B=참조 클립 수명/IPC). **result 핸들러 블록만 겹침 → 조정 필요.**
- 겹치지 않는 것: `python/tts_worker.py`·pitch 백엔드(A 전용, B 불변) / `ReferenceRegionPanel`·`refclip-cleanup`
  ·store 감정 슬롯·`separate.py`(B 측 불변) — B 설계는 Python 변경 0을 목표로 해 A 경계와 격리.
