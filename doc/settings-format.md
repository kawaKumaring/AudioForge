# 설정 파일의 판 번호 (`settings.json` · `meta`)

## 왜

`settings.json` 에는 여러 영역(lastDir·voiceCasts·referenceAssets·workDrafts·playbackVolume·labWorkspace·
transcriptEdits…)이 번호 없이 쌓여 있었다(2026-09-17 실측). 어느 영역의 모양을 바꾸면 옛 파일이 **조용히**
깨지거나 조용히 되살아난다 — 그리고 어느 앱이 그 파일을 마지막에 썼는지 아무 데도 남지 않았다.

## 규칙

- 파일에 `meta` 하나가 있다: `{ formatVersion, lastWrittenBy, lastWrittenAt }`.
  - `formatVersion` — 파일 **모양**의 판. 지금은 1. 번호 이전 파일은 0 으로 읽힌다.
  - `lastWrittenBy` / `lastWrittenAt` — 마지막으로 쓴 앱 판(package.json 권위)과 시각. 모르면 null.
- **읽기**: `migrateSettings()` 가 판 0 → 1 … 을 차례로 올려 메모리에 준다. 판 0 → 1 은 데이터를 바꾸지 않는다
  (번호를 붙이는 것만이 변화). 파일은 읽기만으로 바뀌지 않는다.
- **쓰기**: `setSettingsKey()` 가 현재 파일을 읽어 올린 뒤 키 하나를 바꾸고 `meta` 를 찍는다.
  **모르는 키는 그대로 실려 간다** — 미래 영역·다른 판의 영역을 버리지 않는다.
- **파일 판이 아는 판보다 높으면**(더 새 앱이 썼다) 내리지 않는다. 읽을 때는 그대로 읽고, 쓸 때도 번호를 유지한다.
  기동 기록에 WARN 으로 남는다.
- `meta` 는 저장소만 쓴다. IPC 로 `meta` 키를 직접 쓰려 하면 거절한다(`SETTINGS_META_IS_OWNED_BY_STORE`).
- `settings:get` 은 키를 골라 돌려주므로 `meta` 는 화면에 가지 않는다.

## 대화상자 시작 폴더 — 여섯 칸 (2026-09-25)

파일을 고르거나 저장할 때 **어느 폴더에서 열지**를 용도별로 기억한다.
값은 폴더 경로이고, **main 만 읽고 쓴다** — `settings:get`/`settings:set` 어느 쪽에도 없다.

| 키 | 무엇 |
|---|---|
| `lastDir` | 작업할 음원 (옛 이름 그대로 — 쓰던 값을 버리지 않는다) |
| `lastVoiceDir` | 참조 목소리·인물 목소리 |
| `lastVideoDir` | 더빙할 영상 |
| `lastExportDir` | 내보내기·저장 |
| `lastRestoreDir` | 이전 결과 폴더 열기 |
| `lastPythonDir` | 파이썬 실행 파일 |

규칙은 `src/main/services/dialogFolders.ts` 가 갖는다. 기억한 폴더가 사라졌으면
**살아 있는 가장 가까운 윗폴더**로 내려앉고, 그래도 없으면 용도별 기본값으로 간다 —
비워서 돌아가면 운영체제가 정하고, 그러면 다른 앱이 마지막에 연 폴더가 뜬다.

★진단 묶음에는 **값이 나가지 않는다**(모양만). 실제로 여섯 칸에 표식을 넣어 확인했다.

★**칸을 늘리면 이 표도 늘려야 한다** — `dialogFolders.test.ts` 가 대조한다.

## 모양을 바꾸는 사람이 할 일

1. `SETTINGS_FORMAT_VERSION` 을 1 올린다.
2. `MIGRATIONS[이전 판]` 에 한 단계를 더한다 — 새 객체를 돌려주고, 모르는 키를 보존한다.
3. 단계를 빠뜨리면 `migrateSettings` 가 `SETTINGS_MIGRATION_MISSING:<판>` 예외로 즉시 드러낸다.
4. `settings-meta.test.ts` 에 그 단계의 전후 예를 하나 더한다.

## 어디에 보이나

- 기동 기록: `설정 판 1(아는 판 1) · 마지막 쓴 앱 1.12.0-dev · <시각>`. 번호 이전 파일이면 `(번호 이전)`.
- 진단 묶음 `summary.txt` 의 `설정 판:` 줄.

## 검증

`src/main/services/settings-meta.test.ts`(9): 판 0 읽기·깨진 meta, 0→1 무변경(모르는 키 포함), 쓰기 때 meta·
다른 키 보존, 앱 판 모름 → null, 높은 판 내리지 않음(읽기·쓰기), meta 직접 쓰기 거절·파일 무변경,
stamp 순수성, 연속 쓰기. 기존 `settings-store.test.ts`(9) 전부 그대로 통과.
