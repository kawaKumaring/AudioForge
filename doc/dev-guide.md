# AudioForge 개발 가이드 (종합 회고 + 현재 상태)

## 1. 개발 타임라인

전체 프로젝트가 **2026-04-11~12 이틀** 동안 22개 커밋으로 생성됨.
빠른 기능 추가 → 연쇄 버그 발생 → 대규모 수정 패턴이 반복됨.

| 커밋 | 내용 | 발생한 문제 |
|------|------|------------|
| `615cd12` | 초기: 4모드, Demucs, ECAPA-TDNN, Whisper, NLLB | Tailwind 레이아웃 깨짐, 한글 경로, 드래그앤드롭 |
| `c95ae07` | MP4/MKV 영상 지원 | (정상) |
| `971ede5` | 트랙 분할 분리, 탭 모드, 접이식 옵션 | (정상) |
| `a2079d6` | SplitEditor + wavesurfer 마커 | 392줄 거대 컴포넌트 |
| `24aaeeb` | 파일명에 곡 제목 | (정상) |
| `4aae7c2` | JSON 메타 + 오디오 태그 + meta-fix | (정상) |
| `d87568f` | 이전 결과 폴더 복원 | (정상) |
| `1504bfb` | **대규모 리팩토링**: 5파일 분리, GPU 번역, 모델 선택 | sys.path 누락, ImportError 보호 제거 |
| `6416d19` | 코드 품질 수정 | try/except 실수로 제거 |
| `920656b` ~ `5d9d789` | 트랙 번호, 첫 트랙 제목 등 | (정상) |
| `3446879` | sys.path.insert 추가 | 커밋 8 문제 수정 |
| `d2c2738` ~ `d7b1cbc` | ffmpeg 최적화, ffprobe 경로 수정 | (정상) |
| `3c3d8ca` | 임시 파일명 input→source | ffmpeg 동일 파일 충돌 수정 |
| `9a73248` | 문서화 | (정상) |
| `eee6047` | **14건 버그 수정** (코드 리뷰) | watchdog, progress, Hooks, 리스너 등 |
| `0e1d881` | 한글 경로 ASCII temp 복사 | spawn 인코딩 근본 해결 |
| `2b4852b` | 경과 시간 타이머 | (정상) |
| `344450e` | 준비 단계 상세 메시지 | (정상) |
| `42173b2` | torch import 전 progress emit | (정상) |

## 2. 반복 발생한 문제 (5대 문제)

### 2.1 한글 경로 인코딩 (3회 발생)
- 1차: Python에서 한글 경로 인식 안 됨 → `-X utf8` + `PYTHONUTF8=1` 추가
- 2차: ffmpeg subprocess에서 한글 경로 깨짐 → `shutil.copy2`로 ASCII 경로에 복사 후 처리
- 3차: Electron `spawn()`에서 명령줄 인자의 한글이 CP949로 변환되어 깨짐 → IPC에서 ASCII temp 경로 생성
- **최종 해결**: `createSafePaths()` — 한글이면 temp 복사, Python 완료 후 결과 이동
- **규칙**: 한글 경로가 포함된 문자열은 절대 spawn 인자로 직접 전달하지 않는다

### 2.2 Tailwind v4 + Electron 레이아웃
- `mx-auto` → `margin-inline: auto`가 flex 컨텍스트에서 무시됨
- `@layer` 우선순위 충돌
- **최종 해결**: 레이아웃(중앙정렬, flex, 크기)은 모두 inline style. Tailwind는 색상/장식만.
- **규칙**: 모든 Electron 프로젝트에 적용

### 2.3 ffmpeg/ffprobe 경로
- `replace('ffmpeg', 'ffprobe')`가 폴더명의 ffmpeg도 치환
- **최종 해결**: `os.path.join(os.path.dirname(ffmpeg), "ffprobe" + ext)`
- **규칙**: 문자열 replace로 경로 조작 금지

### 2.4 임시 파일명 충돌
- `input.wav` → 원본이 wav면 ffmpeg "same as Input" 에러
- **최종 해결**: `source.ext` + `converted.wav`
- **규칙**: 임시 파일은 `source`/`converted` 접두어 사용

### 2.5 Python 모듈 분리 실패
- 5파일 동시 분리 → sys.path 누락, ImportError 보호 제거
- split_worker.py 분리 시도 → 테스트 없이 진행하여 기능 고장 → 롤백
- **규칙**: 한 파일씩 분리 → 테스트 → 커밋. 한번에 여러 파일 금지

## 3. 현재 잔존 버그 (6건)

### BUG-1 [Critical] auto-detect split에서 datetime import 누락
- **위치**: `separate.py` 라인 326-399
- **증상**: 자동 감지 분할 → `NameError: name 'datetime' is not defined`로 100% 크래시
- **수정**: auto-detect 경로에 `from datetime import datetime` 추가

### BUG-2 [Critical] conversation_worker ImportError 보호 없음
- **위치**: `conversation_worker.py` 라인 7-8, 80
- **증상**: speechbrain 미설치/로딩 실패 시 에러 메시지 없이 프로세스 종료
- **수정**: try/except ImportError로 감싸고 emit("error") 호출

### BUG-3 [Medium] auto-detect split 임시 파일명 `input` 잔류
- **위치**: `separate.py` 라인 329
- **증상**: 원본이 wav일 때 ffmpeg 충돌 가능
- **수정**: `input{ext}` → `source{ext}`

### BUG-4 [Medium] 크로스 드라이브 renameSync 실패
- **위치**: `audio.ipc.ts` 라인 43 (createSafePaths cleanup)
- **증상**: E: 드라이브 오디오 + C: 드라이브 temp → 결과 이동 실패
- **수정**: `renameSync` → `copyFileSync` + `unlinkSync`

### BUG-5 [Medium] trackRunner에 done/cancel 미구현
- **위치**: `audio.ipc.ts` 라인 246-263
- **증상**: 트랙별 가사/번역 처리 취소 불가, 메모리 누수

### BUG-6 [Low] 프로세스 즉시 크래시 시 listener leak
- **위치**: `ProcessButton.tsx`
- **증상**: Python이 아무 output 없이 죽으면 cleanup 미호출

## 4. "대화 분리 무한 대기" 완전 추적

### 실행 경로
```
ProcessButton.handleProcess()
  → setProcessing() -- UI: "파일 준비 중..."
  → window.api.audio.process()
    → IPC 'audio:process'
      → createSafePaths() -- 한글이면 temp 복사
      → PythonRunner.spawn()
        → IPC setTimeout(2초) -- "Python 프로세스 실행 중..."
      → separate.py main()
        → emit("화자 분리 엔진 로딩 중...") ← 커밋 22 추가
        → from conversation_worker import ... ← [torch 로딩 10-30초]
        → emit("엔진 로딩 완료")
        → run_conversation_separation()
          → emit("오디오 변환 중...") ← 여기부터 정상 진행
          → Silero VAD 로딩 [첫 실행 시 다운로드]
          → ECAPA-TDNN 로딩 [첫 실행 시 다운로드]
          → 임베딩 추출 → 클러스터링 → 재구성
          → emit("result")
```

### 멈출 수 있는 7개 지점
| # | 위치 | 원인 | 대응 상태 |
|---|------|------|----------|
| 1 | spawn 인자 | 한글 깨짐 | ✅ ASCII temp 복사 |
| 2 | torch import | 10-30초 | ✅ import 전 progress emit |
| 3 | Silero VAD 다운로드 | 첫 실행 수분 | ⚠️ progress 있으나 진행률 없음 |
| 4 | ECAPA-TDNN 다운로드 | 첫 실행 수분 | ⚠️ progress 있으나 진행률 없음 |
| 5 | speechbrain import 실패 | ImportError | ❌ BUG-2 (보호 없음) |
| 6 | watchdog 타임아웃 | 5분 무응답 | ✅ 수정됨 |
| 7 | IPC 에러 처리 | return null | ✅ throw로 변경 |

## 5. 개발 규칙 (교훈 기반)

### 필수 규칙
1. **모듈 분리**: 한 파일씩 → 테스트 → 커밋. 절대 한번에 여러 파일 동시 분리 금지
2. **한글 경로**: spawn 인자에 직접 넣지 않음. ASCII temp 경로로 복사 후 전달
3. **레이아웃**: inline style만 사용. Tailwind 유틸리티로 레이아웃 잡지 않음
4. **Python 경로**: sys.path.insert(0, dirname(__file__)) 필수
5. **ffprobe**: dirname+join. replace 금지
6. **임시 파일**: source/converted 접두어. input 금지
7. **AI 모델 로딩**: import/로딩 전에 반드시 progress emit
8. **에러 처리**: return null 대신 throw. UI에서 catch로 처리

### 권장 규칙
9. **3-4개 기능 추가마다** 코드 리뷰 실시 (14건 버그 축적 방지)
10. **Windows 특수 사항** 항상 고려: symlink 제한, 크로스 드라이브, CP949 인코딩
11. **watchdog 패턴**: clearTimeout만 하지 말고 반드시 새 타이머 생성
12. **React Hooks**: early return은 모든 hooks 뒤에 배치

## 6. 수정 우선순위

| 순위 | 버그 | 소요 | 이유 |
|:----:|------|:----:|------|
| 1 | BUG-1: datetime import 누락 | 1분 | 자동 감지 분할 100% 크래시 |
| 2 | BUG-2: ImportError 보호 | 5분 | speechbrain 실패 시 무한 대기 |
| 3 | BUG-3: 임시 파일명 통일 | 1분 | 잠재적 충돌 |
| 4 | BUG-4: 크로스 드라이브 rename | 5분 | E: 드라이브 사용 시 결과 손실 |
| 5 | BUG-5: trackRunner 정리 | 10분 | 취소 불가 + 누수 |
| 6 | BUG-6: listener leak | 5분 | 마이너 |

## 7. 코드 현황 (3296줄)

### Python (1227줄)
```
separate.py            486줄  CLI 라우팅 + split/meta-fix/track-process (분리 예정)
audio_utils.py         155줄  I/O, ffmpeg, 유틸 (안정)
conversation_worker.py 377줄  화자 분리 (ImportError 보호 필요)
music_worker.py         70줄  Demucs (안정)
transcribe_worker.py   139줄  Whisper + NLLB (안정)
```

### Frontend (2069줄)
```
audio.ipc.ts           297줄  IPC 핸들러 7개 (분리 예정)
SplitEditor.tsx        392줄  트랙 분할 에디터 (Hooks 수정됨)
TrackList.tsx          289줄  결과 + 재생/가사/번역
DropZone.tsx           229줄  파일 입력
App.tsx                156줄  메인 레이아웃
Options.tsx            142줄  옵션 패널
python-runner.ts       122줄  Python 프로세스 관리
ProcessButton.tsx       91줄  시작/취소 (리스너 수정됨)
app.store.ts            86줄  전역 상태
기타                   265줄  Waveform, ModeSelector, ProgressBar, preload, types
```
