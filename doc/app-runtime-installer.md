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
- 경로를 기록할 때 `realpath`로 junction을 푼다. 작업 트리의 `externals`가 공용
  `externals`를 가리키는 junction인 경우, 기록에는 실체 경로가 들어간다.
  (junction 경유 경로를 기록하는 것이 2026-08-29 사고의 씨앗이었다.)

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

## 8. 다른 PC에서

```
git clone ... && cd AudioForge
run.bat
```

- 앱 전용 파이썬은 자동으로 내려받는다(레지스트리·PATH 무변경).
- GPT-SoVITS 코드/모델은 **자동으로 내려받지 않는다.** 이미 있는 위치를 찾거나,
  없으면 계획의 `[!]` 항목으로 막고 안내한다. 지정하려면:
  `set AUDIOFORGE_GPTSOVITS_REPO=D:\somewhere\GPT-SoVITS`
- 동의 절차는 생략되지 않는다. 비대화식 자동화에서만 `--yes`.

환경 변수:

| 변수 | 뜻 |
|---|---|
| `AUDIOFORGE_RUNTIME_ROOT` | 런타임 자산이 사는 곳(기본 `<repo>/externals`) |
| `AUDIOFORGE_GPTSOVITS_REPO` | GPT-SoVITS 코드/모델 위치를 못 찾을 때 직접 지정 |

## 9. 손으로 다룰 때

```
node scripts/af-launch.mjs --plan       설치 계획만
node scripts/af-launch.mjs --check      점검만 (0=정상, 1=미비)
node scripts/af-launch.mjs --install    설치까지만 (앱 실행 안 함)

<app-python> python/app_env_installer.py status  [--json]
<app-python> python/app_env_installer.py verify  [--json]
<app-python> python/app_env_installer.py install --reinstall
<app-python> python/app_env_installer.py unlink   # 기록만 지움, 파일은 남김
```

## 10. 기존 자산과의 관계

| 기존 | 이번 |
|---|---|
| `python/env_check.py` | 그대로. **메인** 환경(분리·전사·번역)의 점검 담당 |
| `python/setup_env.py` | 그대로. 메인 환경 attach/venv 담당 |
| `python/setup_gptsovits.py` | **실행하지 않는다.** 기존 repo·기존 venv를 전제로 pip 설치와 shim 덮어쓰기를 하기 때문. 모델 목록과 shim 로직은 지식으로만 가져왔다 |
| `externals/env.json` | 그대로. 메인 환경 경로 기록 |
| `externals/runtime.json` | **새로 추가.** 앱 전용 환경의 연결 기록 |

`runtime.json`이 없으면 `app_runtime.resolve_gptsovits()`는 예전 관례 경로
(`externals/gptsovits_venv`)로 폴백하므로, 기존 설치는 이 변경만으로 깨지지 않는다.
다만 폴백 상태는 `probe`에서 `NOT_LINKED`로 잡혀 설치를 권한다.
