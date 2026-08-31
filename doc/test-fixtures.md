# 테스트 fixture

저장소가 직접 가진 테스트용 자산의 출처와 계약. **테스트 전용이며 production 실행에서 쓰지 않는다.**

## 왜 저장소에 두는가

`synthesize` · `reset-cleanup` E2E는 참조 클립 생성 경로를 지난다. 그 경로는 파형에서 무음
경계를 찾아 자른 뒤 잘린 클립을 전사하고, 전사가 비면 `BLOCK_TRANSCRIBE_FAILED`로 막는다.
정상 동작이므로 합성 사인파로는 지날 수 없다 — 무음 구간을 넣어도 같다.

한때 이 자산을 저장소 밖(본체 저장소의 미추적 `resources/`)에서 찾게 두었는데, detached
clean worktree에서 상대 경로가 그 밖으로 뻗어 **재현되지 않는 검증이 초록으로 보였다.**
그래서 최소 구간만 저장소 안으로 들여왔다.

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
- **쓰는 곳**: `test/e2e/synthesize.e2e.mjs`, `test/e2e/reset-cleanup.e2e.mjs` **둘뿐**
  - 다른 E2E는 `makeSyntheticWav`가 만드는 이번 실행 전용 합성 WAV를 쓴다(자산 불필요).
- **금지**: production 실행·참조 목소리·모델 학습·배포물 포함에 쓰지 않는다.
- **대사 전문**: 추적하지 않는다. 테스트가 필요로 하지 않는다.

## 규칙

`src/shared/e2eAssetPaths.test.ts`가 아래를 `npm test`에서 고정한다.

- E2E가 이 PC에 실재하는 절대 경로를 담지 않는다
- E2E가 저장소 밖으로 나가는 상대 경로로 자산을 찾지 않는다
- 음성이 필요한 두 E2E는 이 fixture만 쓰고, 없으면 통과하지 않고 전제 미충족으로 멈춘다
- fixture가 실재하고 24kHz·mono·PCM 16-bit·5~8초 계약을 지킨다
- 승인 대본(goback·sample_4)은 경로를 박지 않고 `AF_E2E_GOBACK_SCRIPT` /
  `AF_E2E_SAMPLE4_SCRIPT`로만 받는다
