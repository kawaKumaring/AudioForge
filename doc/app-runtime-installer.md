# 앱 전용 환경 설치·연결 (run.bat 한 번으로 재구축)

> 다른 PC에 저장소만 복사해도 `run.bat` 한 번으로 앱이 뜨는 상태를 만드는 것이 목표다.
> ComfyUI가 없어도, 시스템에 파이썬이 없어도 된다.

## 1. 한 줄 요약

`run.bat` → 환경 점검 → 없으면 설치(동의 필요) → **실제로 돌려서** 검증 → 연결 → 앱 실행.
검증을 통과하지 못하면 앱을 띄우지 않고 원인과 재개 방법을 보여 준다.

## 2. 왜 이걸 만들었나

2026-08-29에 작업 트리를 정리하다 재귀 삭제가 junction을 따라가면서 공용
`externals/gptsovits_venv`의 `site-packages` 중 `a`~`mo` 구간이 사라졌다.
디렉터리도 `python.exe`도 멀쩡히 남아 있었기 때문에, **"폴더가 있으니 정상"** 이라는
기존 판정은 이 상태를 정상으로 봤다.

그래서 이 시스템의 판정 규칙은 두 가지다.

1. **연결은 파일 모양이 아니라 기록이다.** `runtime.json`이 가리키지 않는 환경은
   존재하더라도 앱에게는 없는 것이다.
2. **기록에는 지문이 붙는다.** 지문은 venv 안 `*.dist-info` 목록에서 계산하므로
   패키지가 통째로 사라지면 즉시 어긋난다. 위 사고는 지문 불일치로 잡힌다.

### 지문이 못 하는 일 (섞어 말하지 않기)

지문은 **빠른 재실행 점검**이지 무결성 증명이 아니다. 잡는 것과 못 잡는 것이 갈린다.

- 잡는다: dist-info 가 사라지거나 늘어난 것, 인터프리터 파일이 바뀐 것.
- **못 잡는다**: dist-info 는 남고 패키지 **본문**(`.py`/`.pyd`/`.dll`)만 손상·삭제된 것,
  파일 내용이 바뀌었지만 이름 목록은 그대로인 것, 같은 버전의 다른 빌드로 바꿔치기된 것.

site-packages 전체를 해싱하지 않기 때문이다. 수 GiB 를 앱 실행 때마다 읽는 것은
점검이 아니라 부하다. 본문까지 확인하는 일은 `app_env_verify.py` 의 **실제 import·
모델 로딩**이 하며, 그것은 수십 초가 걸리므로 설치 직후와 `verify` 명령에서만 돈다.

따라서 `--check` 가 통과했다는 것은 "지난번 통과한 그 설치가 그대로 있어 보인다"는
뜻이지 "지금 import 가 된다"는 뜻이 **아니다**. 의심스러우면 `verify` 를 돌린다.

## 2-1. 설치 위치 — 앱 소유 vs 외부 참조

런타임은 **본체 저장소** 밑에 산다. 작업 트리 안이 아니다.

```
<본체 저장소>/externals/            <- assets_root()  : 외부 참조. 읽기만 한다.
  GPT-SoVITS/                       코드 + 사전학습 모델 (이미 내려받아 둔 것)
  gptsovits_venv/                   손상된 예전 venv. 보존만 한다.
  qwen3_tts_venv/, qwen3_tts_hf/, separator_models/, env.json
  runtime/                          <- runtime_root() : 앱 소유. 여기만 만들고 고친다.
    app-python/cpython-3.12.14-.../ 앱 전용 파이썬
    gptsovits_venv_app/             앱 전용 venv (3.58 GiB, 114 패키지)
    runtime.json                    연결 기록
    runtime-lock.json               설치 실측 명세
    .cache/downloads/               받은 설치 파일 보관(재다운로드 방지)
```

**왜 본체 저장소인가.** 처음에는 `<이 체크아웃>/externals` 였다. 그래서 작업 트리에서
설치기를 돌리면 3.6 GiB 짜리 venv 가 그 작업 트리 안에 생겼다. 작업 트리는 지우라고
만드는 것이므로 수명이 처음부터 어긋나 있었다. 이제 어느 작업 트리에서 실행하든
같은 곳을 가리킨다 — 본체는 `.git` 하나로 판별한다(디렉터리면 여기가 본체,
`gitdir: .../.git/worktrees/<이름>` 파일이면 그 앞부분이 본체의 `.git`).

**두 위치의 권한이 다르다.** `runtime_root()` 는 설치기가 만들고 고치고 지울 수 있는
유일한 영역이다. `assets_root()` 는 읽기 전용이며, 연결 기록에도
`external.repo.managed = false` 로 그 사실을 박아 둔다.

## 3. 구성 파일

| 파일 | 역할 |
|---|---|
| `run.bat` | 진입점. ASCII + CRLF 전용. 한글 안내는 출력하지 않는다. |
| `scripts/af-launch.mjs` | 앱 전용 파이썬 확보(**여기서만** 내려받는다) → 나머지는 파이썬에 위임 → 앱 실행 |
| `python/runtime_spec.json` | 설치 명세(선언). 인터프리터 태그·sha256·패키지·라이선스·제외 사유 |
| `python/app_runtime.py` | 경로 해석·연결 기록·지문·빠른 점검. **표준 라이브러리만** 씀 |
| `python/app_env_installer.py` | 계획 → 동의 → venv → 패키지 → shim → 검증 → 연결 |
| `python/app_env_verify.py` | 설치된 venv 안에서 실제 import + 모델 로딩 + 한국어 프론트엔드 통과 |

### 규칙의 소유자는 하나다

"무엇이 정상인가"를 JS와 파이썬 양쪽에 쓰면 반드시 어긋난다. 그래서
`af-launch.mjs`는 판정을 직접 하지 않고 `python/app_runtime.py --json`에 물어본다.
JS가 스스로 판단하는 것은 **앱 전용 파이썬이 있는가** 하나뿐이다(닭과 달걀이라 어쩔 수 없다).

## 4. run.bat 흐름

```
run.bat
  cd /d "%~dp0"            자기 위치 기준 (기존 동작 유지)
  chcp 65001               node의 한글 출력이 깨지지 않게
  node 있나?               없으면 ASCII 안내 후 종료(2)
  node_modules 있나?       없으면 npm install
  node scripts/af-launch.mjs
        |
        +- 앱 전용 파이썬 없음 -> 내려받기(sha256 대조) -> 압축 해제 -> 검사 후 배치
        +- app_runtime.py --json 으로 점검
        |     ok    -> npm run dev
        |     미비  -> app_env_installer.py install (계획 출력 + 동의)
        |               성공 -> 재점검 -> npm run dev
        |               실패 -> 원인 + 재개 방법 출력, 앱 실행 안 함(비 0 종료)
```

종료 코드: `0` 정상 · `1` 설치/검증 실패 · `2` 전제 조건 미비 · `3` 사용자가 취소.

## 5. 안전 경계 (설치기가 하지 않는 것)

- 시스템 파이썬 / ComfyUI 임베디드 파이썬 / 기존 venv에 패키지를 설치하지 않는다.
- 손상된 `gptsovits_venv`를 수리하지도 삭제하지도 않는다. 옆에 `gptsovits_venv_app`을 새로 만든다.
- 정상인 Qwen 환경을 다시 설치하지 않는다. 그 연결 기록은 읽지도 쓰지도 않는다.
- PATH·레지스트리·환경 변수를 영구 변경하지 않는다. 되돌리기는 설치 폴더 삭제로 끝난다.
- 재귀 삭제를 하지 않는다. 유일한 예외는 **자기가 방금 만든** `.staging` 폴더다.
- `assets_root()` 안의 것은 무엇도 만들거나 고치거나 지우지 않는다. 읽기만 한다.
- 경로를 기록할 때 `realpath`로 junction을 푼다. 작업 트리의 `externals`가 공용
  `externals`를 가리키는 junction인 경우, 기록에는 실체 경로가 들어간다.
  (junction 경유 경로를 기록하는 것이 2026-08-29 사고의 씨앗이었다.)
- **"먼저 발견한 것"으로 경로를 정하지 않는다.** 예전 `_find_repo`는 형제 디렉터리를
  훑다가 공용 `externals`를 가리키는 junction을 먼저 만나 그 경유 경로를 기록했다.
  지금은 명시된 네 곳(환경변수 → 기록 → `assets_root()` → `runtime_root()`)만 본다.

## 6. 검증이 확인하는 것

`app_env_verify.py`는 **파일이 있는지 보지 않는다.** 실제로 돌린다.

1. 명세의 모듈을 하나씩 `__import__` (DLL 로드 실패까지 잡으려고 `BaseException`을 받는다)
2. `torch.cuda.is_available()` + 디바이스 이름 + compute capability
3. `TTS_Config` 로드 → `TTS(cfg)` 생성 → t2s / vits / bert / hubert 네 가중치가
   실제로 올라갔는지 확인
4. `clean_text("...", "ko", version)` — mecab 사전·g2pk2 자원 누락은 import만으로는
   안 잡히므로 한국어 프론트엔드를 실제로 통과시킨다

이 넷을 다 통과해야 `runtime.json`에 연결이 기록된다.

## 7. 멱등성

두 번째 `run.bat`부터는 `app_runtime.probe_gptsovits()`가 지문까지 확인하고
`ok`를 돌려주므로 **아무것도 내려받지 않고** 곧장 앱이 뜬다.
지문이 어긋나면(패키지 삭제·변경) 그때만 다시 설치 경로로 들어간다.

작업 트리를 새로 만들어도 마찬가지다. 런타임 위치가 본체 저장소 기준이라 새
작업 트리에서 `run.bat`을 돌려도 같은 설치를 찾아 쓴다.

재설치가 필요할 때도 같은 것을 두 번 내려받지 않는다. 파이썬 설치 파일은
sha256 확인 후 `<runtime_root>/.cache/downloads/`에 보관하고, 다음 설치에서
sha256이 맞을 때만 재사용한다(어긋나면 버리고 새로 받는다). pip 패키지는 pip
자신의 캐시(`%LOCALAPPDATA%\pip\Cache`)를 그대로 쓴다.

## 8. 지금 자동으로 되는 것과 안 되는 것

**된다**
- 앱 전용 파이썬 내려받기·설치(sha256 대조, 레지스트리·PATH 무변경)
- GPT-SoVITS 전용 venv 생성 + 114개 패키지 설치 + shim
- 실제 import·모델 로딩 검증 → 통과 시에만 연결
- 이미 있는 GPT-SoVITS 코드·모델 재사용

**아직 안 된다 (후속 과제)**
- **Node.js 부재** — `run.bat`이 안내만 하고 멈춘다. 직접 설치해야 한다(20+).
  런처 자체가 Node로 돌기 때문에 여기서 자동화할 방법이 없다.
- **GPT-SoVITS 코드·모델 부재** — 자동으로 내려받지 않는다. 계획의 `[!]` 항목으로
  막고 안내한다. 이미 있으면 `AUDIOFORGE_GPTSOVITS_REPO`로 지정하거나
  `<본체>/externals/GPT-SoVITS`에 두면 된다.
- **새 PC 전체 설치 / 외부 자산 자동 탐색** — 범위 밖. 위 두 전제가 갖춰진 뒤에만
  `run.bat` 한 번으로 끝난다.

## 9. 다른 PC에서

```
git clone ... && cd AudioForge
run.bat
```

- 동의 절차는 생략되지 않는다. 비대화식 자동화에서만 `--yes`.
- `runtime.json`이 **다른 PC에서 만든 기록**이면(경로가 이 PC에 없으면) 조용히
  예전 경로로 미끄러지지 않는다. `RECORDED_ON_OTHER_HOST`로 판정하고, 기록된
  호스트 이름과 함께 "이 PC에 설치하라"고 알린다. 기록은 덮어쓰지 않는다.
- 위 8절의 "아직 안 되는 것" 두 가지는 손으로 갖춰야 한다.

환경 변수:

| 변수 | 뜻 |
|---|---|
| `AUDIOFORGE_RUNTIME_ROOT` | **앱 소유** 런타임 위치(기본 `<본체 저장소>/externals/runtime`). 명시하면 최우선 |
| `AUDIOFORGE_ASSETS_ROOT` | **외부 참조** 자산 위치(기본 `<본체 저장소>/externals`). 읽기 전용 |
| `AUDIOFORGE_GPTSOVITS_REPO` | GPT-SoVITS 코드/모델 위치를 못 찾을 때 직접 지정 |

## 10. 손으로 다룰 때

```
node scripts/af-launch.mjs --plan       설치 계획만
node scripts/af-launch.mjs --check      점검만 (0=정상, 1=미비) — 기록·지문 대조
node scripts/af-launch.mjs --where      설치 위치만 JSON 출력 (내려받지 않음)
node scripts/af-launch.mjs --install    설치까지만 (앱 실행 안 함)

<app-python> python/app_env_installer.py status  [--json]
<app-python> python/app_env_installer.py verify  [--json]
<app-python> python/app_env_installer.py install --reinstall
<app-python> python/app_env_installer.py unlink   # 기록만 지움, 파일은 남김
```

## 11. 기존 자산과의 관계

| 기존 | 이번 |
|---|---|
| `python/env_check.py` | 그대로. **메인** 환경(분리·전사·번역)의 점검 담당 |
| `python/setup_env.py` | 그대로. 메인 환경 attach/venv 담당 |
| `python/setup_gptsovits.py` | **실행하지 않는다.** 기존 repo·기존 venv를 전제로 pip 설치와 shim 덮어쓰기를 하기 때문. 모델 목록과 shim 로직은 지식으로만 가져왔다 |
| `externals/env.json` | 그대로. 메인 환경 경로 기록 |
| `externals/gptsovits_venv` | 손상된 예전 venv. **보존만 한다** — 수리도 삭제도 하지 않는다 |
| `externals/runtime/runtime.json` | **새로 추가.** 앱 전용 환경의 연결 기록 |

`runtime.json`이 없으면 `app_runtime.resolve_gptsovits()`는 예전 관례 경로
(`assets_root()/gptsovits_venv`)로 폴백하므로, 기존 설치는 이 변경만으로 깨지지 않는다.
다만 폴백 상태는 `probe`에서 `NOT_LINKED`로 잡혀 설치를 권한다.

## 12. 실측 (2026-08-29, kumaring / RTX 5070 Ti)

- 설치: 272초. 파이썬 44 MiB 내려받기 + pip 캐시(21 GiB 기존분) 재사용.
- venv: 3.58 GiB, 114 패키지. 지문 `9d0d26bc…67cc62` —
  작업 트리에 잘못 설치했던 직전 환경과 **같은 값**(같은 명세 → 같은 결과).
- 검증: import 32/32, CUDA 사용 가능, 모델 로딩 성공 4.0초(t2s·vits·bert·hubert).
- 합성: production 브리지로 한국어 1회 27.6초 → 3.94초 / 32 kHz / mono.
- 재실행: `--check` 통과, 내려받기·재설치 0.
