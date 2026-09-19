# 목소리 준비 상태의 소유자를 하나로 (설계 2026-09-17 · 1단계 2026-09-19)

툴 수준 개선 5/5. **1단계 완료(2026-09-19).** 아래 단계 표의 ①이 끝났고 ②~④는 아직이다.

## 1단계 — 한 일 (동작 무변경 추출)

판정 규칙을 `src/shared/voicePreparation.ts` 로 옮겼다. 화면 부품은 그 함수를 **부르고 결과를 반영**한다.

- `decideAfterAnalysis` — 분석 결과 하나를 보고 무엇을 보고할지(패치들), 슬라이더에 무엇을 심을지 정한다.
- `decideAfterTrim` — 구간 확정 응답을 판정한다(승인/이전 것 유지/실패). 승인 권위는 파이썬이고 화면은 해석하지 않는다.
- `decideAutoConfirm` + `autoConfirmKey` — 자동 확정을 할지, 끝났다고 알릴지, 더 기다릴지.
- 패널 1,011줄 → **892줄**. 규칙은 단위 검사 23건으로 고정됐다(예전에는 앱을 띄우는 검사로만 지켜졌다).
- 계약 검사 3종은 **새 소유자를 보도록** 고쳤고, "조건이 두 곳에 있으면 안 된다" 는 단정을 더했다 —
  규칙이 화면으로 되돌아오면 검사가 막는다.

★이 단계에서 **동작은 바꾸지 않았다.** 조건·순서·문구를 그대로 옮겼고, 기존 검사가 그대로 통과하는 것이 조건이었다.

설계와 달라진 것 하나: 자리를 `renderer/lib` 가 아니라 **`src/shared`** 로 잡았다. 화면을 띄우지 않고 시험할 수
있고, 나중에 일반(lab)·main 쪽에서도 같은 규칙을 부를 수 있기 때문이다.

## 남은 단계는 아래 그대로다


## 지금 구조 (실측)

목소리 준비(분석 → 구간 추천 → 확정 → 파생 클립 → 준비 상태 보고)의 **유일한 판정자는 화면 부품**
`ReferenceRegionPanel`(1,011줄)이다. 파일 머리에 그렇게 적혀 있다 — "이 패널이 유일한 판정자다. 상위는 읽기만 한다."

그래서 준비가 돌려면 **패널이 화면에 마운트돼 있어야** 한다. 준비만 필요하고 도구는 필요 없는 자리는
패널을 **숨겨서** 마운트한다:

- 합성(일반) `LabWorkspace` — `display:none` 안에 패널(`clipKey='lab'`, `open={false} autoConfirm`).
- 고급 여러 명 `TTSEditor` — `data-testid="default-voice-driver"` 숨은 패널(첫 인물이 기본 목소리를 이어받게).
- 고급 인물 `useSpeakerVoicePrep` — 보이지 않는 자리에서 **한 명씩** 준비를 돌리는 드라이버 패널
  (`autoPrep`, 끝나는 시점은 패널의 `onAutoConfirmSettled` 신호).
- 보이는 자리 셋 — 기본 참조 패널(단 1회 마운트), 인물 카드의 패널, 감정 패널.

준비 상태의 **저장소**는 store 슬롯 셋이다: 기본(`ttsRefPhase/ttsRefReady/ttsReferenceClip/ttsReferenceRegion/ttsRefReqId`),
인물(`ttsSpeakerRefState[id]`), 감정(`ttsEmotionRefState[id]`), 그리고 일반은 `labStore.ref`. 패널은 `onState(RefStatePatch)`
로 보고하고, 각 리듀서가 `reqId` 로 낡은 보고를 버린다.

## 이 구조가 만든 결함 (이번 주, 전부 실측)

1. 일반의 숨은 패널이 고급과 같은 `clipKey='default'` 를 써서 **고급의 클립 폴더를 지웠다** — 화면에 붙은 패널이
   자리(clipKey)를 고르는 구조라 화면이 하나 늘 때마다 자리 규칙이 어긋날 수 있다.
2. 자동 확정 키가 파일 단위여서 **다시 분석된 뒤 '준비 중' 에서 영영 멈췄다** — 패널 인스턴스의 ref 가 상태를 들고 있다.
3. 드라이버 패널이 자기 진행 보고로 **자기 자신을 언마운트**했다(2026-09-08) — 준비의 수명이 화면 부품의 수명이다.
4. 카드 패널과 드라이버 패널이 **둘 다 마운트되면 서로의 결론을 덮었다** — 판정자가 인스턴스 수만큼 생긴다.
5. `disabled` 가 분석 effect 의 의존값이어서 잠갔다 풀면 **27초 재분석** — 화면 속성이 파이프라인을 재시작한다.
6. 고급 화면이 일반 탭을 다녀오면 **다시 마운트**돼 되살리기가 또 돌았다 — 같은 뿌리(상태가 화면 인스턴스에 있음).
7. 클립 파일이 사라져도 **"준비됨"** 으로 남는다 — 준비 상태와 파일의 존재를 아무도 다시 맞추지 않는다
   (`useClipRecovery` 가 합성 직전에 회복하는 것이 유일한 보정).
8. 준비 표시("준비 완료")와 실제 시작 가능이 갈라졌다 — 표시 규칙과 판정 규칙이 다른 파일에 있었다.

## 목표

**준비 파이프라인의 소유자를 화면 밖 모듈 하나로 옮긴다.** 화면 부품은 그 상태를 **보여 주고**, 사용자의 구간 편집을
**요청**할 뿐이다. 숨은 마운트는 없어진다.

```
voicePreparation (renderer/lib, 화면 밖)
  prepare(slot: {clipKey, path, engine, targetSec, reqId})   → 분석 → 추천 → 자동 확정 → 보고
  confirmRegion(slot, region)                                 → 트림 → 보고
  cancel(slot)                                                → 진행 중 요청 무효화
  verifyClipsExist(slots)                                     → 사라진 클립을 '준비됨' 에서 내린다(합성 직전 아님, 주기·포커스)
  보고: store 리듀서(기본·인물·감정·lab) 로 — 지금의 RefStatePatch·reqId 규칙 그대로
ReferenceRegionPanel (화면)
  파형·슬라이더·확정 단추 — 상태는 store 에서 읽고, 동작은 voicePreparation 을 부른다
  분석을 스스로 시작하지 않는다. 마운트/언마운트가 준비에 영향을 주지 않는다
```

## 단계 (각 단계가 게이트를 통과하는 커밋 하나)

1. **추출** — `ReferenceRegionPanel` 의 분석·자동 확정·트림 호출과 그 경쟁 방어(reqId, committed 재해석,
   자동 확정 1회 규칙)를 `lib/voicePreparation.ts` 로 옮기고 패널은 그것을 **부르기만** 한다. 화면 동작 무변경.
   검사: 기존 계약 5종(`ReferenceLifecycle`·`ReferencePolicyUI`·`SpeakerAutoPrepare`·`app.store`·`speakerRefRequest`)과
   e2e(`reference-ready-consistency`·`synthesis-voice-isolation`·`tts-convenience-dev`) **그대로 통과**.
2. **드라이버 제거** — 일반의 `display:none` 패널, 고급의 `default-voice-driver`, `useSpeakerVoicePrep` 의 autoPrep 패널을
   `voicePreparation.prepare()` 직접 호출로 바꾼다. "한 명씩" 은 모듈 안의 줄(serial lane)이 맡는다.
   검사: `data-testid="default-voice-driver"` 를 보는 e2e 를 **의도(첫 인물 이어받기)** 기준으로 고친다(요소가 아니라 결과).
3. **존재 확인** — `verifyClipsExist` 를 파일 열기·탭 복귀·합성 직전에 돌려 사라진 클립을 `needs_region` 으로 내린다.
   `useClipRecovery` 의 재생성은 그대로 두되 "준비됨인데 파일 없음" 이 화면에 남지 않게 한다.
4. **표시 = 판정** — 카드의 '준비 완료' 배지·라벨·시작 가능 판정을 `readinessFromSlots` 한 곳에서만 읽게 한다
   (2026-09-16 에 절반 했다. 남은 자리를 찾아 마감).

## 하지 않을 것

- 파이썬 쪽 분석·정책·트림은 그대로. 모듈은 renderer 안에서만 소유자를 바꾼다.
- 감정 패널은 제품에 연결하지 않기로 했으므로(9/11) 1단계에서 함께 옮기되 새 기능은 넣지 않는다.
- 저장 형식(`referenceAssets`·`voiceCasts`·`workDrafts`) 은 바꾸지 않는다.

## 위험

- 1,011줄 안의 경쟁 방어는 전부 실측 결함의 흔적이다. 옮기다 하나를 빠뜨리면 그 결함이 돌아온다 — 그래서 1단계는
  **동작 무변경 추출**만 하고 검사를 그대로 통과시켜야 한다.
- e2e 여러 개가 `default-voice-driver` 같은 **구조 요소**를 본다. 2단계에서 그 검사들을 의도 기준으로 고쳐야 하며,
  지워서 통과시키지 않는다.

## 승인이 필요한 결정

- ~~1단계(추출)만 먼저 할지, 1~2단계를 한 번에 할지~~ → **1단계만** 하기로 하고 2026-09-19 에 마쳤다.
- 다음은 2단계(드라이버 제거) 착수 여부. 2단계는 **화면이 바뀐다**(숨은 마운트가 사라진다) — 1단계와 달리
  동작 무변경이 아니므로 사용자 확인이 필요하다.
