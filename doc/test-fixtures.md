# 테스트 fixture

저장소가 직접 가진 테스트용 자산의 출처와 계약. **테스트 전용이며 production 실행에서 쓰지 않는다.**

## 왜 저장소에 두는가

`synthesize` · `reset-cleanup` E2E는 참조 처리 경로를 지난다. 그 경로는 파형에서 무음
경계를 찾고, 자른 클립을 전사하며, 전사가 비면 `BLOCK_TRANSCRIBE_FAILED`로 막는다.
정상 동작이므로 **실제 말이 든 오디오**가 필요하다 — 합성 사인파로는 지날 수 없고 무음
구간을 넣어도 같다.

한때 이 자산을 저장소 밖(본체 저장소의 미추적 `resources/`)에서 찾게 두었는데, detached
clean worktree에서 상대 경로가 그 밖으로 뻗어 **재현되지 않는 검증이 초록으로 보였다.**
그래서 최소 구간만 저장소 안으로 들여왔다.

## 왜 음성 fixture 가 두 개인가

참조 처리는 원본 길이로 갈린다(`ReferenceRegionPanel`).

- **3~10초 + 품질 통과 → `valid_whole`**: 원본을 그대로 참조로 쓴다.
  `{ ready: true, clip: '' }` 로 끝나고 **파생 클립을 만들지 않는다.**
- **10초 초과 → `needs_region`**: 무음 경계로 구간을 잘라 파생 클립을 만든다.
  그 클립이 `os.tmpdir()/audioforge_refclip_*` 아래에 생기고, `reset()` 이 지운다.

두 경로는 서로 다른 계약이라 파일 하나로는 둘 중 하나를 검증할 수 없다. 그래서 fixture 도
둘이다. 7.5초 하나만 두었을 때 `reset-cleanup` 이 `valid_whole` 로 빠져 파생 클립이 아예
생기지 않았고, 그때 `reset 후 삭제됨` 단언이 빈 경로에 대해 통과해 **아무것도 검증하지 않는
초록**이 나왔다.

## audio/ko-speech-7s.wav

- **분류**: 사용자 승인 프로젝트 자산
  (확인되지 않은 CC0·공개 라이선스를 붙이지 않는다. 관리자가 이 폴더의 파일을 fixture
  제작·저장소 추적 용도로 사용하도록 승인했다.)
- **원본**: `resources/reference-audio/bucket-list/vocals.wav` (본체 저장소, 미추적)
  - 원본 SHA-256: `b0927d4abd55fd2dee0e607f3e80b3bd321d9044cb7508e807f55e41a59d7f9a`
  - 원본 형식: WAV PCM 16-bit · 44,100 Hz · 2ch · 37.514초
  - 원본은 읽기만 했다. 수정·이동·삭제하지 않았다.
- **추출 좌표**: 원본 기준 **25.75초 ~ 33.25초** (7.50초), **채널 0**만
  - 두 끝을 원본의 무음 구간 안쪽에서 끊었다(25.69~26.07, 32.73~33.37). 발화 시작·마지막
    음절이 잘리지 않는다.
- **변환**: 44,100 Hz → 24,000 Hz 폴리페이즈 리샘플(80/147) 후 PCM 16-bit로 기록.
  - normalization·denoise·gain·내용 변형 **없음**. peak 0.7551 → 0.7585 (리샘플 링잉만).
- **fixture SHA-256**: `72897e10c27c4b846b2f204e595da2a1805a47cce4a1b35d4709937f10a0eb8b`
- **형식**: WAV PCM 16-bit · 24,000 Hz · mono · 7.500초 · 360,044 bytes
- **경계 확인**(앱 자신의 판정기로 측정)
  - `detect_silences`: 0.00~0.32 / 4.47~4.72 / 6.98~7.49 — 머리·꼬리·중간 모두 존재
  - `boundary_truncation`: `head_truncated=false`, `tail_truncated=false`
  - `snap_region_to_silence`: 3~10초 제약 안에서 계획이 나온다
- **쓰는 곳**: `test/e2e/synthesize.e2e.mjs` **하나뿐** — `valid_whole` 경로 담당.
- **금지**: production·demo 실행·참조 목소리·모델 학습·배포물 포함에 쓰지 않는다.
- **대사 전문**: 추적하지 않는다. 테스트가 필요로 하지 않는다.

## audio/ko-speech-region-18s.wav

- **분류**: 사용자 승인 프로젝트 자산 (위와 같은 승인 범위, 같은 원본)
- **원본**: `resources/reference-audio/bucket-list/vocals.wav` (본체 저장소, 미추적)
  - 원본 SHA-256: `b0927d4abd55fd2dee0e607f3e80b3bd321d9044cb7508e807f55e41a59d7f9a`
  - 원본은 읽기만 했다. 수정·이동·삭제하지 않았다.
- **추출 좌표**: 원본 기준 **4.26초 ~ 22.82초** (18.56초), **채널 0**만
  - 머리는 무음 4.03~4.49의 한가운데에서, 꼬리는 무음 22.59~22.82를 끝까지 포함해 끊었다.
    발화 시작·마지막 음절이 잘리지 않는다.
- **변환**: 44,100 Hz → 24,000 Hz 폴리페이즈 리샘플(80/147) 후 PCM 16-bit.
  - normalization·denoise·gain·내용 변형 **없음**. peak 0.7849 → 0.7861 (리샘플 링잉만).
- **fixture SHA-256**: `886a91b29344db8b2f304e56823971f5ea987694b8e68e1af52e808c2eced1c6`
- **형식**: WAV PCM 16-bit · 24,000 Hz · mono · 18.560초 · 890,924 bytes
- **경계 확인**(앱 자신의 판정기로 측정)
  - 10초 초과 → `needs_region` 경로를 탄다
  - `detect_silences`: 0.00~0.23 / 9.56~9.95 / 18.33~18.55 — 머리·중간·꼬리 모두 존재
  - `boundary_truncation`: `head_truncated=false`, `tail_truncated=false`
  - `snap_region_to_silence`(3~10초): 0.115~9.755 계획이 나온다
- **쓰는 곳**: `test/e2e/reset-cleanup.e2e.mjs` **하나뿐** — `needs_region` 경로와 파생
  클립 생성·`reset()` 삭제 계약 담당.
- **금지**: production·demo 실행·참조 목소리·모델 학습·배포물 포함에 쓰지 않는다.
- **대사 전문**: 추적하지 않는다.

## 규칙

`src/shared/e2eAssetPaths.test.ts`가 아래를 `npm test`에서 고정한다.

- E2E가 이 PC에 실재하는 절대 경로를 담지 않는다
- E2E가 저장소 밖으로 나가는 상대 경로로 자산을 찾지 않는다
- 음성이 필요한 두 E2E는 저장소 fixture만 쓰고, 없으면 통과하지 않고 전제 미충족으로 멈춘다
- 두 fixture가 실재하고 각각 24kHz·mono·PCM 16-bit + 5~8초 / 10초 초과 계약을 지킨다
- 두 E2E가 서로 다른 fixture를 쓴다(경로가 뒤바뀌면 한 경로가 검증되지 않는다)
- 승인 대본(goback·sample_4)은 경로를 박지 않고 `AF_E2E_GOBACK_SCRIPT` /
  `AF_E2E_SAMPLE4_SCRIPT`로만 받는다

## userData 격리

두 E2E는 `AF_E2E_USER_DATA`로 이번 실행 전용 임시 userData를 받는다
(`<os.tmpdir()>/audioforge-e2e-userdata-<uuid>`).

주지 않으면 앱이 **사용자의 실제 userData**를 쓴다. 거기에 이전에 고른 참조가 남아 있으면
파일을 새로 넣어도 곧바로 ready가 되어 파생 클립을 만들지 않는다 — 실제로 그 상태에서
`reset-cleanup`이 깨지고 `synthesize`는 4초 만에 '통과'했다.

계약은 다음과 같다.

- 시작 시점에 임시 userData가 비어 있음을 단언한다(남은 선택 참조·클립 0)
- 이 흐름은 보관함 등록을 하지 않으므로 `reference-library`가 **생기지 않아야** 한다
- 실제 `%APPDATA%/audio-forge`는 이름·크기·mtime이 실행 전후 변경 0이어야 한다
- 파생 클립은 `os.tmpdir()/audioforge_refclip_*` 아래에 있고, 실제·임시 userData 내부가 아니다
- 정리는 성공했을 때만 한다. 절대경로·부모가 tmpdir·prefix 일치·reparse point 아님을 모두
  확인한 뒤 그 한 경로만 지운다. 실패한 실행은 진단을 위해 남긴다.
