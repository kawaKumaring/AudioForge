# 옛 작업 → 카드 가져오기 — 무엇이 옮겨지고 무엇이 안 옮겨지는가 (조사, 2026-09-27)

옮기기 전에 **옮겨지지 않는 것부터** 확정한다. 코드에 기록이 없는 값은 지어내지 않는다.
가져오기는 **복사**다 — 옛 기록을 지우거나 덮지 않고, 옛 버전 탭도 그대로 둔다.

옛 기록은 두 곳이다. 둘 다 `window.api.settings.get()` 아래 자기 열쇠에만 산다.
- `labWorkspace` — 테스트개발 작업실(옛 버전 탭 → '기본'). 대본·생성본·채택이 실제로 있다.
- `workDrafts` — 합성 전 자동 저장. 원본·인물·구간은 있고 **생성본은 없다.**

---

## 1. labWorkspace — 대응이 명확하다

`LabDoc { voicePath, voiceLabel, lines[], settings, updatedAt }`

**그대로 옮긴다**
- `lines[]` 순서 → 카드 순서. 한 줄이 카드 한 장이다.
- `line.text` → 카드 대사.
- `line.takes[]` → 카드 생성본. `path`·`text`·`createdAt` 를 그대로 옮긴다.
- `line.adoptedTakeId` → 카드 채택. 기록된 채택만 옮긴다(없으면 안 고른 채로 둔다).
- `voicePath`/`voiceLabel` → 모든 카드의 공통 참조 목소리.
- `settings.speed` → 카드 속도. `settings.pitch` → 카드 음높이.

**옮기지 않는다 — 뜻이 다르다**
- ★`settings.silenceGap` **→ `joins.gap` 아님.** 전자는 한 대사 **안**의 쉼을 엔진에 보내는
  값이고(`ttsSilenceGap`), 후자는 카드 **사이**의 간격이다. 같은 숫자를 옮기면 소리가 달라진다.

**옮길 자리가 없다 — 가져오기 전에 알린다**
- `settings.engine` · `qwenModel` · `referenceConditioningMode` · `refTargetSec` ·
  `tailMode` · `tailPaddingMs` · `tailFadeMs` — 카드 설정(`CardEngineSettings`)에
  `speed·pitch·emotion·reference·start·end` 만 있다. 카드는 제품 기본값으로 시작한다.

**기록이 없다 — 지어내지 않는다**
- 생성본별 설정·적용값: `LabTake` 는 `text`·`voiceKey`·`createdAt`·`tailResidual` 만 남긴다.
  문서 설정은 **지금 값**이라 생성 당시 값이라는 보장이 없다. 옮긴 생성본은
  '당시 설정 기록 없음' 으로 표시하고, '수정 전/지금 것' 판정에 쓰지 않는다.
- 참조 구간: `LabRefState` 는 화면에만 살고 문서에 저장되지 않는다. 카드는 `reference: 'auto'`
  로 두어 준비 단계가 스스로 잡게 한다. 구간을 지어내 `manual` 로 적지 않는다.
- 원본 길이: 기록이 없다. 파일을 열어 재지 않는다(미디어 열람은 별도 승인 사항).

**파일이 사라진 생성본**
`CardTake.missing` 자리가 이미 있다. 없는 파일은 **없음으로 표시**하고 재생·채택을 막는다.
조용히 빼지 않는다 — 무엇이 있었는지는 사용자가 알아야 한다.

---

## 2. workDrafts — 부분 대응

`WorkDraft { sourcePath, ttsText, speakerMode, speakers{}, renames{}, inheritSpeakerId }`

**옮긴다**
- `speakers[id].source` → 카드의 참조 원본.
- `speakers[id].region` → 있으면 `reference: 'manual'` + `start`/`end`. 없으면 `auto`.
- `speakers[id].label` → 카드 이름.
- `ttsText` → 대사.

**옮길 수 없다 — 기록이 그렇게 생겼다**
- ★`ttsText` 는 **한 덩어리**다. 어느 줄이 어느 인물의 것인지 기록이 없다.
  `speakerMode: 'multi'` 여도 줄↔인물 대응을 지어낼 수 없다.
  인물이 여럿이면 **카드는 인물 수만큼 만들되 대사는 첫 카드에만** 넣고 그 사실을 알린다.
- 생성본·채택: 이 기록은 합성 **전**의 것이라 아예 없다. 빈 카드로 들어온다.
- `renames` · `inheritSpeakerId` · `emotionEnabled` · `referenceId` — 카드에 대응이 없다.

---

## 3. 가져오기가 지킬 것

- **복사만 한다.** 옛 기록(`labWorkspace`/`workDrafts`)을 읽기만 하고 쓰지 않는다.
- **덮지 않는다.** 지금 카드 작업을 지우지 않는다 — 뒤에 붙이거나, 사용자가 자리를 고른다.
- **반만 들어가지 않는다.** 옮기는 도중 실패하면 **한 장도 들어가지 않는다**(먼저 전부
  만들어 보고, 다 됐을 때만 한 번에 붙인다).
- **가져오기 전에 알린다.** 위 '옮길 자리가 없다 / 기록이 없다' 를 짧은 목록으로 먼저 보여 준다.
- **옛 버전 탭을 남긴다.** 가져왔다고 옛 화면을 치우지 않는다.
