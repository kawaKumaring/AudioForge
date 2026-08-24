# 개발 환경 복구와 독립 설치 작업 사후 기록

## 목적

이 문서는 현재 개발 PC에서 AudioForge를 다시 실행하는 작업과, 다른 PC에서도 동작하는 독립 설치 기능을 만드는 작업이 혼재해 범위가 과도하게 확장된 경위를 기록한다.

## 실제로 분리됐어야 했던 두 문제

1. **현재 개발 환경 복구**
   - 각 worktree의 Node/Electron 의존성은 `npm ci`로 복구한다.
   - 기존 `AudioForge/externals`의 Python venv·모델은 현재 PC에서만 borrowed/read-only 의존성으로 재사용한다.
   - 기존 환경에는 패키지를 설치하거나 버전을 변경하지 않는다.

2. **배포용 독립 설치**
   - 런타임이 없는 PC에서만 사용자가 명시적으로 관리형 설치를 선택한다.
   - manifest, checksum, staging, rollback, 설치 위치 보호는 이 설치 경로에만 적용한다.
   - 독립 설치 기능의 미완성이나 실패가 기존 borrowed 실행 경로를 막아서는 안 된다.

## 과도하게 진행된 원인

- `develop-run`의 Electron 바이너리 누락이라는 단순 개발 의존성 문제를 독립 런타임 문제와 함께 다뤘다.
- 기존 ComfyUI Python에서 발생한 경고 표시 문제와 Qwen 전용 venv 연결 문제를 하나의 설치 문제로 취급했다.
- 기본 실행 복구보다 배포용 provisioner의 공급망·경로·원자성 계약을 먼저 완성하려 했다.
- resolver, capability, path injection, manifest, provisioner를 여러 worktree로 분리한 뒤 중간 worktree를 오래 유지했다.
- 테스트의 전체 로그와 반복 교차검토를 대화 컨텍스트에 과도하게 포함했다.

## 2026-08-25 현재 개발 PC 연결 상태

- 실행 기준: `develop @ bb5b703`
- 실행 경로: `AudioForge_af_worktrees/develop-run`
- Electron: `npm ci`로 복구 완료. `node_modules/electron/path.txt`와 `dist/electron.exe` 확인.
- 외부 의존성 연결: `develop-run/externals` junction이 기존 `AudioForge/externals`를 가리킨다.
- 연결 대상에는 `qwen3_tts_venv`, `qwen3_tts_hf`, `gptsovits_venv`, `GPT-SoVITS`, `separator_models`가 존재한다.
- 연결은 현재 PC 전용이며 Git에 커밋하지 않는다. 기존 의존성은 borrowed/read-only로 취급한다.
- 부모 Python은 기존 설정에 따라 ComfyUI embedded Python을 사용한다. 이를 자동 수정하지 않는다.

## 확인된 별도 문제

- ComfyUI Python은 `pynvml` deprecation 및 `requests` dependency mismatch 경고를 출력한다.
- 사전검사가 exit 0이면 이 경고를 사용자 오류로 취급해서는 안 된다.
- 전용 Qwen venv의 Python 3.12.10과 Torch 2.13.0+cu130 import는 성공했다.
- 전체 `qwen_tts` import는 외부 SoX 실행 파일 탐색에서 대기했다. SoX 경로/필요성은 별도 호환성 항목으로 다룬다.
- ComfyUI 또는 기존 venv에 임의 `pip install`을 실행해 문제를 덮지 않는다.

## 브랜치 운영 원칙

- `master`: 현재 안정 릴리스.
- `develop`: 기존 기능이 계속 실행되는 통합 기준.
- `expression-integration`: TTS 감정·운율 기능 검증용.
- `provisioner-p0-integration`: 독립 설치 안전성 개발용이며 기존 실행을 대체하지 않는다.
- 기능별 중간 runtime worktree는 상위 커밋 포함·clean·프로세스 0 확인 후 worktree만 제거하고 브랜치는 보존한다.

## 이후 우선순위

1. borrowed 경로에서 기존 음악·대화·ASR·TTS가 계속 동작하도록 유지한다.
2. stderr 경고와 실제 실패(exit code/구조화 error)를 분리한다.
3. Qwen 전용 venv의 SoX 요구와 실제 합성 경로를 짧은 smoke로 확인한다.
4. 독립 설치 기능은 별도 브랜치에서만 완성한다.
5. borrowed와 managed 두 실행 행렬이 모두 통과하기 전 develop에 provisioner를 병합하지 않는다.
6. 테스트 출력은 성공 수치와 최초 실패 traceback만 수집하고 동일 실패를 반복 실행하지 않는다.

## 완료 기준

- 현재 PC: 기존 의존성 연결로 앱과 주요 기능이 동작한다.
- 신규 PC: 사용자가 선택한 위치에 관리형 환경을 설치하고 기존 외부 환경을 수정하지 않는다.
- 어느 한 경로의 실패가 다른 경로를 비활성화하지 않는다.
