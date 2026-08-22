# TTS prosody 통합 — 검증·감사 기록 (feature/tts-prosody-integration)

통합 담당 단독 공용 배선 이후의 검증/감사 결과. master(ca42b0e)·v1.0.0·develop(0788885) 불변, develop 병합은 최종 검토 전까지 금지.

## 1. 배선 커밋 (develop 0788885 이후)
- `6637934` 배선1: ttsConfig 3필드(ttsPitch·ttsEmotionRefSources·ttsEmotionRefRegions)
- `a3d4ac0` 배선2: pitch 슬라이더(TTSEditor)·전송(ProcessButton)·store ttsPitch
- `5ad3e65` 배선3: result metadata 감정 주입(emotion_reference_regions/source_names) + TtsResultInfo pitch·감정 표시(basename)
- `d50bce6` 배선5: Python 2차 방어(tts_worker 만료 4불변식 + separate.py source 수신)
- `0693338`·`7bd2ecf` 배선6: 통합 E2E(prosody-integration) + device/progress 이력 캡처

## 2. GPU 실합성 E2E (device=cuda:0, source=nvidia-smi) — 전부 PASS
GPU 여유(free ~9600) 확보 후:
- **synthesize-complete** (기본, pitch=0): cuda:0, WAV frames·sr·finite·peak, metadata device 정상.
- **resynthesize** (연속 2회, pitch=0): 1회 클릭 진입·완료·"이미 처리 중"/TOO_LONG 0, 잔존 0.
- **prosody-integration** (pitch +1 + [기쁨] 감정 참조): device=cuda:0, **pitch 후처리 실제 도달**("음높이 보정 중 +1.0반음"), medianF0=199.2Hz, peak 0.96(클리핑 0), metadata `pitch_semitones=1/method=rubberband/post=true` + `emotion_reference_source_names.happy=speaker_b.wav` + `emotion_reference_regions.happy.start=20`, session.json에 `ttsPitch=1`·`ttsEmotionRefSources.happy(원본경로)`·`ttsEmotionRefRegions.happy` 저장. Part B(재구성 source 부재→해당 감정만 오류·미준비, 다른 감정 보존) PASS. 잔존 0·resources 불변.
- 직접 백엔드 관통(verify): device=cuda:0, bfloat16, 감정 ICL 전사→합성→이어붙이기→pitch 보정→result, pitch 3필드·WAV 정상.

주의(정직): prosody-integration은 **첫 실행 1회 무응답 실패**했다. 게임/ComfyUI 종료 직후 GPU가 아직 불안정(경합)한 시점이었고, GPU 안정 후 재실행에서 완주했다. 첫 실패의 device는 캡처 보강 전이라 미포착 — "일시적 GPU 경합"으로 판단하되 단정하지 않는다.

## 3. CPU 280초 무응답 원인 감사 (지시 3) — 판정: GPU 포화 시 시스템 경합, 회귀 아님
- **qwen_bridge.py(generate 담당) master(ca42b0e) vs integration diff = 없음.** CPU generate 속도는 master=integration → "integration만 느림(회귀)" 배제.
- **CPU generate 실측**(device 강제 cpu, 무응답 제한만 측정용 3000s로 임시 상향·production 280 미변경, 짧은 문장 1개, pitch=0): 총 **38.1s**, 모델 로딩 13.5s, generate 구간 **24.6s** → **280s 훨씬 이내**.
- 대조: 첫 무응답 실패들은 GPU가 게임/ComfyUI로 극점유(nvidia-smi free ~1200)된 상태였다. GPU 포화가 CPU 추론까지 동반 지연시켜(자원 경합) 24.6s가 280s+로 늘어난 것. GPU를 비우자 CPU(24.6s)·cuda 모두 정상.
- **판정**: CPU 정책·runner/IPC·integration 회귀가 아니다. auto→CPU 폴백은 정상이며 정상 상황에서 빠르다. 280s 초과는 GPU 포화라는 비정상 자원 경합 상황에서만 발생.

## 4. CPU fallback timeout 정책 (지시 4) — 판정: 임의 증가 안 함
- 정상 CPU generate가 24.6s로 280s에 크게 못 미치므로 "정상 생성 중인데 280s 부족" 상황이 아니다 → **production 무응답 제한(280s)을 근거 없이 늘리지 않는다.**
- GPU 포화 시 CPU 동반 지연으로 280s를 넘길 수 있으나, 이는 timeout을 무한정 늘려 풀 문제가 아니라(멈춘 프로세스와 구분 불가) 사용자가 GPU를 비우면 해소된다. 현 동작(무응답 시 프로세스 종료 + 명확한 오류)을 유지한다.
- **알려진 제한으로 문서화**: GPU가 다른 무거운 작업으로 포화된 상태에서 auto→CPU 폴백 합성은 매우 느려져 280s 무응답 오류가 날 수 있다. 이때는 GPU 작업을 정리 후 재시도.

## 5. session 재시작 복원 (지시 5)
- session.json 저장: prosody-integration E2E가 실합성 후 `options.ttsEmotionRefSources/Regions/ttsPitch` 저장을 단언(§2).
- 재시작 재구성: emotion-reference E2E가 실제 앱 재시작(launch 2회) 후 source+region으로 effective 재구성을 검증. **단 source+region을 테스트 캡처값으로 넘겨 "session.json 파일에서 읽어" 재구성하는 경로는 미검증.**
- **조치**: prosody-integration E2E에 Session 2를 추가 — 실합성으로 생성된 session.json을 재시작 후 **파일에서 읽어** source+region 추출 → 재구성 → effective 재생성·전송 대상 확인. (B helper 단위테스트만으로 완료 판정하지 않음.)
- 자동 restoreSession UI(앱이 스스로 session 발견해 감정 상태 복원)는 결과-보기 맥락과 달라 이번 범위 밖 — effective 재구성은 source+region으로 가능함을 E2E로 보장하는 선까지.

## 6. Kokoro espeak 결함 (지시 6) — 기존 결함, integration 범위 밖·수정 금지
- 증상: externals(Qwen venv/모델) 없이 한국어 auto 합성 시 Qwen 미가용 → Kokoro 폴백 → `AttributeError: type object 'EspeakWrapper' has no attribute 'set_data_path'`로 Kokoro 로딩 실패.
- 재현: Qwen 경로(externals) 미연결 상태에서 `synthesize(..., 한국어 대사, preferred_engine=None)` → 엔진 auto가 Kokoro 선택 → espeak 로딩 예외.
- 성격: **integration 브랜치 변경과 무관한 기존 결함**(phonemizer/espeak 버전). integration 범위에 섞어 수정하지 않는다. **별도 브랜치 승인 전 수정 금지.** 재현 절차·오류만 기록.

## 7. externals junction (지시 7) — 개발 편의, 커밋/배포 의존성 아님
- 통합 worktree에는 gitignore된 `externals`(Qwen venv·모델)가 없어, 개발 중 실합성 검증을 위해 메인 저장소 externals로 **디렉토리 junction**을 연결했다(관리자 권한 불필요).
  `New-Item -ItemType Junction -Path <worktree>\externals -Target <메인>\externals`.
- **이 junction은 개발 환경 편의일 뿐 커밋·배포 의존성이 아니다**(.gitignore가 externals 배제, git status에 안 뜸).
- **최종 테스트는 실제 프로젝트 경로**(apps/development/AudioForge, externals 실재)에서도 재실행해 junction 의존이 없음을 확인한다.
