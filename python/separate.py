#!/usr/bin/env python3
"""AudioForge - Audio source separation entry point.

Modes: music, conversation, transcribe, split, track-process, meta-fix
Communication via JSON lines on stdout.
"""

import argparse
import json
import math
import os
import re
import sys
import subprocess

# Ensure sibling modules are importable regardless of cwd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# transformers 5.x requires higher recursion limit on import
sys.setrecursionlimit(10000)

# NOTE: torchaudio patching moved to audio_utils.patch_torchaudio() —
# it imports torch (10-30s) so it must NOT run at module import time.
# split/meta-fix/gptsovits paths never need torch.
import split_markers as _sm   # 분할 마커 검증 단일 권위(순수, stdlib만)
import audio_utils as _audio_utils
# 두 기능이 같은 emit 지점을 각자 필요로 한다 — 어느 쪽도 버리지 않고 함께 쓴다.
#  - _emit_upstream : 아래에서 정의하는 터미널 기록 래퍼가 위임할 '원본' emit(C3 종결 봉투).
#  - error_already_emitted : 이미 구조화 오류가 나갔는지 조회(음악 P0 근본 원인 보존).
# 래퍼가 원본으로 패스스루하므로 원본이 세우는 _error_emitted 플래그는 그대로 유효하다.
from audio_utils import (emit as _emit_upstream, error_already_emitted, load_audio, save_audio,
                         find_ffmpeg, convert_to_wav, trim_silence, fmt_time,
                         fmt_srt_time, get_device, patch_torchaudio)

# ── C3: CLI 성공 판정 ──────────────────────────────────────────────────────────
# 문제: TTS 모드는 error 이벤트를 낸 뒤 return 했다(모델 로딩 실패·상한 도달·config 위반 전부).
# main()에서 return 하면 종료 코드는 0이므로, 종료 코드만 읽는 자동화 호출자는 실패를 성공으로 읽었다.
#
# 종료 코드는 '바꾸지 않는다'. Electron main은 성공을 종료 코드로 판정하지 않고 result 라인 도달로
# 판정하는데(python-runner.ts는 result/error 라인을, audio.ipc.ts는 pendingResult를 본다),
# 종료 코드를 0이 아니게 만들면 python-runner가 stderr 기반 '문자열' error를 한 번 더 emit 하고
# 그것이 구조화 error({message, code})를 덮어써서 code가 사라진다(GENERATION_LIMIT_EXCEEDED /
# INVALID_TTS_CONFIG 분기 UX가 조용히 깨진다). 그 보정은 src/ 소유이므로 여기서 건드리지 않는다.
#
# 대신 실행당 정확히 한 줄, 마지막에 구조화 종결 봉투를 낸다:
#   {"type":"final","ok":bool,"terminal":"result"|"error"|"none","mode":...,"code":...,
#    "output_verified":bool,"outputs":N,"exit_code":N}
# 'final'은 새 type이라 python-runner의 분기(progress/status/result/error)에 걸리지 않는다
# → Electron 영향 0. 자동화 호출자는 종료 코드 대신 이 봉투를 읽는다.
#
# 성공 조건은 단 하나: terminal=="result" 이면서 선언된 산출물이 실제로 존재하고 0바이트가 아닐 것.
# result와 error가 한 실행에 함께 나오면 성공이 아니라 DOUBLE_TERMINAL 이다.
_RUN = {
    "mode": None,
    "result": 0,          # result 터미널 수신 수
    "error": 0,           # error 터미널 수신 수
    "error_code": None,   # 첫 구조화 error code(있으면)
    "outputs": [],        # result가 선언한 산출물 경로
    "mismatch": False,    # 반환 경로가 선언 산출물에 없음(계약 위반)
    "final_emitted": False,
}


def emit(msg_type, **kwargs):
    """audio_utils.emit 패스스루 + 터미널 신호 기록.

    모듈 import 시점에 audio_utils.emit 자체를 이 래퍼로 교체한다. music_worker /
    conversation_worker / tts_worker 는 전부 main() 안에서 '지연 import' 되므로
    (torch import 비용 때문) 그때 `from audio_utils import emit` 이 이 래퍼를 집는다.
    → 한 실행의 모든 터미널 신호가 어느 모듈에서 나왔든 한 곳에 모인다."""
    if msg_type == "result":
        _RUN["result"] += 1
        for t in (kwargs.get("tracks") or []):
            p = t.get("path") if isinstance(t, dict) else None
            if p:
                _RUN["outputs"].append(p)
    elif msg_type == "error":
        _RUN["error"] += 1
        if _RUN["error_code"] is None and kwargs.get("code"):
            _RUN["error_code"] = kwargs["code"]
    return _emit_upstream(msg_type, **kwargs)


_audio_utils.emit = emit   # 이후 지연 import 되는 모듈들도 같은 래퍼를 본다


def _same_path(a, b):
    try:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))
    except OSError:
        return False


def _outputs_verified():
    """선언된 산출물이 전부 실제로 존재하고 0바이트가 아닌가.
    선언이 0개인 조회성 모드(preflight/ref-analyze 등)는 공허참이다 — 검증할 산출물이 없다."""
    for p in _RUN["outputs"]:
        try:
            if not (os.path.exists(p) and os.path.getsize(p) > 0):
                return False
        except OSError:
            return False
    return True


def _emit_final(exit_code=0):
    """실행당 정확히 한 줄. 재진입/중복 방지."""
    if _RUN["final_emitted"]:
        return
    _RUN["final_emitted"] = True
    has_r, has_e = _RUN["result"] > 0, _RUN["error"] > 0
    verified = _outputs_verified()
    if has_r and has_e:
        # 한 실행이 result와 error를 동시에 냈다 — 어느 쪽도 신뢰할 수 없다.
        terminal, ok, code = "error", False, "DOUBLE_TERMINAL"
    elif has_e:
        terminal, ok, code = "error", False, _RUN["error_code"]
    elif has_r:
        terminal = "result"
        if _RUN["mismatch"]:
            ok, code = False, "OUTPUT_PATH_MISMATCH"
        elif not verified:
            ok, code = False, "OUTPUT_MISSING"
        else:
            ok, code = True, None
    else:
        # 외부 kill·조용한 return 등 — 종결 신호 없이 끝났다.
        terminal, ok, code = "none", False, "NO_TERMINAL_SIGNAL"
    _emit_upstream("final", ok=ok, terminal=terminal, mode=_RUN["mode"], code=code,
                   output_verified=bool(ok and verified), outputs=len(_RUN["outputs"]),
                   exit_code=exit_code)


def main():
    parser = argparse.ArgumentParser(description="AudioForge separator")
    parser.add_argument("--config", default="", help="JSON config file (overrides all other args)")
    parser.add_argument("--mode", default="music")
    parser.add_argument("--input", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--trim-silence", action="store_true")
    parser.add_argument("--silence-gap", type=float, default=0.0)
    parser.add_argument("--transcribe", action="store_true")
    parser.add_argument("--output-format", default="wav")
    parser.add_argument("--whisper-model", default="large-v3")
    parser.add_argument("--whisper-lang", default="")
    parser.add_argument("--translate", action="store_true")
    parser.add_argument("--translate-model", default="600m")
    parser.add_argument("--srt", action="store_true")
    parser.add_argument("--split-points", default="")
    parser.add_argument("--split-labels", default="")
    parser.add_argument("--n-speakers", type=int, default=2)
    args = parser.parse_args()
    _RUN["mode"] = args.mode   # 종결 봉투에 실행 모드를 남긴다(파싱 직후 1회)

    # Load config from JSON file if provided (avoids spawn encoding issues)
    if args.config and os.path.exists(args.config):
        with open(args.config, "r", encoding="utf-8") as f:
            config = json.load(f)
        args.mode = config.get("mode", args.mode)
        _RUN["mode"] = args.mode
        args.input = config.get("input", args.input)
        args.output = config.get("output", args.output)
        args.model = config.get("model", args.model)
        args.trim_silence = config.get("trimSilence", args.trim_silence)
        args.silence_gap = config.get("silenceGap", args.silence_gap)
        args.transcribe = config.get("transcribe", args.transcribe)
        args.output_format = config.get("outputFormat", args.output_format)
        args.whisper_model = config.get("whisperModel", args.whisper_model)
        args.whisper_lang = config.get("whisperLang", args.whisper_lang)
        args.translate = config.get("translate", args.translate)
        args.translate_model = config.get("translateModel", "600m")
        args.srt = config.get("srt", args.srt)
        args.split_points = config.get("splitPoints", args.split_points)
        args.split_labels = config.get("splitLabels", args.split_labels)
        args.n_speakers = config.get("nSpeakers", args.n_speakers)
        args.gpu_policy = config.get("gpuPolicy", "auto")  # 대화 분리 GPU 정책(auto/gpu/cpu)
        # 이번 실행 식별자(main 생성). split 임시폴더 이름에 넣어 취소/강제종료 후에도 main이
        # **이 실행이 만든 폴더만** 정확히 지울 수 있게 한다(파이썬 finally는 taskkill에서 안 돈다).
        args.run_token = config.get("runToken", "")
        # TTS fields
        args.tts_text = config.get("ttsText", "")
        args.tts_speed = config.get("ttsSpeed", 1.0)
        args.tts_silence_gap = config.get("ttsSilenceGap", 0.5)
        args.tts_emotion_refs = config.get("ttsEmotionRefs", {})
        # 화자별 참조(v1.4). 없으면 빈 dict — 기존 대본 동작은 그대로다.
        args.tts_speaker_refs = config.get("ttsSpeakerRefs", {})
        args.tts_speaker_ref_sources = config.get("ttsSpeakerRefSources", {})
        args.tts_speaker_emotion_refs = config.get("ttsSpeakerEmotionRefs", {})
        args.tts_speaker_labels = config.get("ttsSpeakerLabels", {})
        args.tts_emotion_ref_sources = config.get("ttsEmotionRefSources", {})  # 등록 원본(만료 판정 기준, §5)
        args.tts_engine = config.get("ttsEngine", "auto")
        # 참조 conditioning 모드(참조혼입 대응 PHASE 2, 단일 권위 계약). 키 부재(legacy 세션)는
        # None 그대로 두고, 해석(부재→safe_xvector)·값 검증·fail-closed 는 tts_worker 가 단일 소유한다.
        # 여기서 기본값을 만들거나 값을 고치지 않는다(원시값 전달 — ttsExpressiveMode 와 같은 원칙).
        args.tts_reference_conditioning_mode = config.get("ttsReferenceConditioningMode", None)
        args.tts_reference_prompts = config.get("ttsReferencePrompts", {})  # 식별자→수동 override
        args.tts_reference_override = config.get("ttsReferenceOverride", "")  # 파생 참조 클립(있으면 기본 참조로 사용)
        args.tts_pitch = config.get("ttsPitch", 0.0)  # 음높이 보정(반음, 후처리). 부재 시 0.0(하위호환·무후처리)
        args.tts_parsed_plan_sha256 = config.get("ttsParsedPlanSha256", "")  # 공용 마감 I1: renderer 파싱 full sha256(parity 대조)
        args.tts_parser_version = config.get("ttsParserVersion", None)
        # 표현형(v3) 파서 게이트 — 명시 플래그만이 파서를 고른다. 키 이름은 계약 단일 정본
        # expressive_timeline.EXPRESSIVE_MODE_FIELD("ttsExpressiveMode")이며 드리프트는
        # test_expressive_v3_wiring 이 이 파일 소스를 읽어 고정한다.
        # 키 부재(None)만 조용한 legacy_v2(레거시 세션 보존). 값이 있는데 계약 밖이면
        # EXPRESSIVE_MODE_INVALID로 크게 실패한다 — 해석은 tts_parity 단일 위임이며
        # 여기서 기본값을 정하거나 값을 정규화하지 않는다(원시값 그대로 넘긴다).
        args.tts_expressive_mode = config.get("ttsExpressiveMode", None)
        # 공용 마감 I3: 말끝 finishing + 감정 전환 경계 config. 부재(레거시 세션/구 config)=off/현행 → 회귀 보존,
        # 자동 마이그레이션 없음(계약 정정8). new 세션은 렌더러가 auto를 명시 전달. 범위 밖은 조용한 clamp 없이
        # INVALID_TTS_CONFIG(tail은 audio_finishing.parse_tail_config, emotion 경계는 아래에서 검증).
        args.tts_tail_mode = config.get("ttsTailMode", "off")
        args.tts_tail_padding_ms = config.get("ttsTailPaddingMs", 120)
        args.tts_tail_fade_ms = config.get("ttsTailFadeMs", 8)
        args.tts_emotion_boundary_mode = config.get("ttsEmotionBoundaryMode", "pause")
        args.tts_emotion_boundary_pause_ms = config.get("ttsEmotionBoundaryPauseMs", 200)
        # ref-analyze / ref-trim 파라미터(참조 구간 선택 UI용)
        args.region_start = config.get("regionStart", 0.0)
        args.region_dur = config.get("regionDur", 0.0)

    # Qwen preflight — 입력/출력 불필요(실행 전 상태 표시용). 예상값이며 실행 결과는 metadata가 최종.
    if args.mode == "qwen-preflight":
        try:
            from tts_worker import _get_qwen_engine, _QWEN_MIN_FREE_MB, _QWEN_SNAPSHOT, _parse_device_source
            eng = _get_qwen_engine()
            avail = bool(eng.available())
            snapshot_ok = os.path.isdir(_QWEN_SNAPSHOT)
            device_expected = None
            device_source = None
            reason = None
            if avail:
                try:
                    from gpu_policy import select_device
                    dev, reason = select_device("auto", min_free_mb=_QWEN_MIN_FREE_MB)
                    device_expected = "gpu" if dev == "cuda" else "cpu"
                    device_source = _parse_device_source(reason)
                except Exception as e:
                    reason = f"장치 예상 실패: {e}"
            emit("result", available=avail, snapshot_ok=snapshot_ok,
                 device_expected=device_expected, device_source=device_source, reason=reason)
        except Exception as e:
            emit("result", available=False, snapshot_ok=False, device_expected=None,
                 device_source=None, reason=f"preflight 오류: {e}")
        return

    if args.mode == "pitch-preflight":
        # pitch 후처리(rubberband) 지원 여부만 조회 — 미디어 입력·오디오 디코딩·Qwen/GPU/모델 로딩 없음.
        # pitch_available()은 ffmpeg -filters 조회만 수행하고 경로/민감정보 없는 사유 코드를 준다.
        try:
            from pitch_shift import pitch_available
            available, reason = pitch_available()
            emit("result", available=bool(available), reason=str(reason))
        except Exception as e:
            # 전체 경로/민감정보 미포함 — 예외 종류만.
            emit("result", available=False, reason=f"pitch-probe-failed: {type(e).__name__}")
        return

    if not args.input or not args.output:
        emit("error", message="입력 파일과 출력 경로가 필요합니다.")
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    try:
        # ── TTS mode ──
        if args.mode == "tts":
            # 공용 마감 I1: 모델 로딩 전에 renderer 파싱 결과와 parity 대조(합성 권위=Python).
            # 파싱 실패(UNKNOWN_TTS_TAG/INVALID_PAUSE_TAG/EMPTY_EMOTION_SEGMENT) 또는 hash 불일치
            # (PARSER_PARITY_MISMATCH)면 여기서 구조화 오류로 차단한다(모델 미로딩·대사 전문 미출력).
            # 파서 선택은 config의 ttsExpressiveMode 명시 플래그만이 한다(키 부재 → legacy_v2 = 오늘과 동일).
            # 값이 있는데 계약 밖이면 verify_parity가 EXPRESSIVE_MODE_INVALID를 돌려 아래 _perr 게이트에서
            # 막힌다(조용한 v2 강등 금지 — 사용자가 v3를 요청했는데 v2 결과를 받는 무신호 상황 차단).
            try:
                import tts_parity as _tp
                _emode_raw = getattr(args, "tts_expressive_mode", None)
                _emode = _tp.parity_mode(_emode_raw)
                _perr = _tp.verify_parity(args.tts_text,
                                          getattr(args, "tts_parsed_plan_sha256", "") or "",
                                          _emode_raw)
            except Exception as e:  # parser 자체 오류도 조용히 통과시키지 않는다
                _perr = [{"code": "PARSER_PARITY_MISMATCH", "reason": "verify_failed:" + type(e).__name__}]
            if _perr:
                _e0 = _perr[0] if isinstance(_perr[0], dict) else {"code": "PARSER_PARITY_MISMATCH"}
                emit("error", message="대사 태그를 처리할 수 없습니다.", **{k: v for k, v in _e0.items()})
                return
            # ── v3 표현형 모드의 '깨끗한 경계' ──
            # 여기까지 왔다면 v3 문법 검증과 parity가 실제로 통과한 것이다(우회 아님). 그러나 합성 경로
            # (tts_worker.synthesize → _boundary_gaps_from_plan)는 v2 plan의 segments/boundary_type만
            # 소비하고 스스로 tts_grammar로 재파싱하므로, v3 타임라인은 번역 레이어 없이는 진입할 수 없다.
            # 파서만 통과시켜 놓고 뒤에서 죽는 것보다 여기서 명확한 코드로 멈추는 편이 낫다(모델 미로딩).
            # ⚠️ _tp/_emode 는 위 try가 성공했을 때만 이 지점에 도달한다(실패 시 _perr로 이미 return).
            #    _perr 게이트를 지났으므로 _emode 는 계약상 유효한 두 값 중 하나임이 보장된다.
            if _emode != _tp.EXPRESSIVE_MODE_LEGACY_V2:
                emit("error", message="표현형(v3) 대사는 아직 합성할 수 없습니다(검증까지만 지원).",
                     code=_tp.EXPRESSIVE_V3_SYNTHESIS_UNSUPPORTED, mode=_emode)
                return
            from tts_worker import synthesize, resolve_reference_conditioning_mode
            # 참조 conditioning 모드(PHASE 2) — 부재(legacy 세션) → safe_xvector(안전 기본),
            # 잘못된 값 → 구조화 오류(INVALID_REFERENCE_CONDITIONING_MODE, 모델 미로딩 차단).
            # production 은 항상 여기서 해석된 '명시 값'을 synthesize 에 전달한다.
            # 'auto'(자동)의 해석 — ICL 1회 시도 → 정렬 실패 시 safe_xvector 로 정확히 1회 전환 —
            # 은 tts_worker.synthesize 가 단일 소유한다. 여기서는 값을 나르기만 한다.
            try:
                _rc_mode = resolve_reference_conditioning_mode(
                    getattr(args, "tts_reference_conditioning_mode", None))
            except RuntimeError as e:
                _payload = getattr(e, "error_payload", None)
                emit("error", message=str(e),
                     **(_payload if isinstance(_payload, dict) else {}))
                return
            def _dict_arg(a, name):
                """config 에서 온 dict 만 통과시킨다. 모양이 다르면 없는 것으로 본다."""
                v = getattr(a, name, None)
                return v if isinstance(v, dict) else {}

            emotion_refs = {}
            if hasattr(args, 'tts_emotion_refs') and args.tts_emotion_refs:
                emotion_refs = args.tts_emotion_refs if isinstance(args.tts_emotion_refs, dict) else {}
            emotion_ref_sources = getattr(args, 'tts_emotion_ref_sources', {})
            emotion_ref_sources = emotion_ref_sources if isinstance(emotion_ref_sources, dict) else {}
            preferred_engine = args.tts_engine if hasattr(args, 'tts_engine') and args.tts_engine != 'auto' else None
            ref_prompts = getattr(args, "tts_reference_prompts", {})
            ref_prompts = ref_prompts if isinstance(ref_prompts, dict) else {}
            # 기본 참조: 파생 클립(ttsReferenceOverride)이 있으면 그것을, 없으면 입력 파일.
            # override가 지정됐는데 파일이 없으면(만료) 원본으로 조용히 폴백하지 않고 명확히 실패한다.
            from tts_worker import resolve_reference_input
            override = getattr(args, "tts_reference_override", "") or ""
            try:
                ref_input = resolve_reference_input(override, args.input)
            except RuntimeError as e:
                emit("error", message=str(e))
                return
            # 감정 참조 만료(§5 불변식 3) 등 synthesize가 던지는 RuntimeError를 명확한 오류로 표면화
            # (silent fallback 금지 — resolve_reference_input과 동일 패턴).
            # 공용 마감 I3 — 감정 전환 경계 config 검증(조용한 clamp 금지, Python 권위). immediate|pause만·0~1000ms.
            _eb_mode = args.tts_emotion_boundary_mode
            _eb_ms = args.tts_emotion_boundary_pause_ms
            if _eb_mode not in ("immediate", "pause"):
                emit("error", message="감정 전환 경계 설정이 올바르지 않습니다.",
                     code="INVALID_TTS_CONFIG")
                return
            if not (isinstance(_eb_ms, (int, float)) and 0 <= _eb_ms <= 1000):
                emit("error", message="감정 전환 간격 값이 허용 범위(0~1000ms)를 벗어났습니다.",
                     code="INVALID_TTS_CONFIG")
                return
            # tail_cfg 검증을 모델 로딩 '전'으로 앞당긴다(emotion 경계와 대칭 fail-fast, 조용한 clamp 금지).
            # _finish_and_place도 나중에 재검증하지만(방어), 범위 위반은 여기서 즉시 INVALID_TTS_CONFIG로 차단.
            _tail_cfg = {"mode": args.tts_tail_mode,
                         "pad_ms": args.tts_tail_padding_ms,
                         "fade_ms": args.tts_tail_fade_ms}
            try:
                import audio_finishing as _af
                _af.parse_tail_config(_tail_cfg)  # 범위 밖이면 AudioFinishingError(code=INVALID_TTS_CONFIG)
            except Exception as _te:
                _code = getattr(_te, "code", None) or "INVALID_TTS_CONFIG"
                emit("error", message="말끝 다듬기 설정이 올바르지 않습니다.", code=_code)
                return
            try:
                _synth_out = synthesize(
                    ref_input, args.tts_text, args.output,
                    speed=args.tts_speed, silence_gap=args.tts_silence_gap,
                    emotion_refs=emotion_refs, emotion_ref_sources=emotion_ref_sources,
                    speaker_refs=_dict_arg(args, "tts_speaker_refs"),
                    speaker_ref_sources=_dict_arg(args, "tts_speaker_ref_sources"),
                    speaker_emotion_refs=_dict_arg(args, "tts_speaker_emotion_refs"),
                    speaker_labels=_dict_arg(args, "tts_speaker_labels"),
                    preferred_engine=preferred_engine,
                    reference_prompts=ref_prompts,
                    pitch=getattr(args, "tts_pitch", 0.0),
                    tail_cfg=_tail_cfg,
                    emotion_boundary_mode=_eb_mode,
                    emotion_boundary_pause_ms=_eb_ms,
                    # metadata 캐리어(계약 §10). 위 게이트를 지났으므로 여기 값은 항상 legacy_v2 다.
                    # 리터럴을 쓰지 않고 실제 해석값을 넘긴다 — 그래야 3중 일치가 '기록'이 아니라 '사실'이 된다.
                    expressive_mode=_emode,
                    # 참조 conditioning 모드 — 위에서 해석된 명시 값. high_quality_icl 은
                    # controlled-prefix 로 생성한 뒤 파형 경계를 찾아 참조 구간을 잘라내고,
                    # 경계를 확정하지 못하면 ICL_BOUNDARY_ALIGNMENT_FAILED 로 실패한다(무음 대체 없음).
                    reference_conditioning_mode=_rc_mode)
                # 성공 조건은 'result 도달 + 실제 산출물'이다. synthesize가 돌려준 최종 경로가
                # result가 선언한 tracks에 실제로 들어있는지까지 대조한다(선언과 산출의 드리프트 차단).
                if _synth_out and not any(_same_path(_synth_out, p) for p in _RUN["outputs"]):
                    _RUN["mismatch"] = True
            except RuntimeError as e:
                # 구조화 payload(code+필드)가 있으면 renderer까지 전달(문자열 prefix 추론 대신 정식 code).
                # payload에는 문장·전사·전체경로가 없다(tts_worker가 index/토큰/감정 ID만 담음).
                # AudioFinishingError(예: tail 범위 위반 INVALID_TTS_CONFIG)는 .code를 payload로 승격.
                payload = getattr(e, "error_payload", None)
                if not isinstance(payload, dict):
                    _code = getattr(e, "code", None)
                    payload = {"code": _code} if _code else None
                if isinstance(payload, dict):
                    emit("error", message=str(e), **payload)
                else:
                    emit("error", message=str(e))
            return

        # ── Reference region: 분석(추천/파형) · 트림(파생 클립) (참조 구간 선택 UI용) ──
        if args.mode == "ref-analyze":
            import reference_region as rr
            from reference_audio import assess_reference_file, GPTSOVITS_POLICY
            assessed = assess_reference_file(args.input, GPTSOVITS_POLICY)
            dur = assessed.analysis.duration_sec
            payload = {
                "duration_sec": dur, "sample_rate": assessed.analysis.sample_rate,
                "channels": assessed.analysis.channels,
                "needs_region": bool(dur > GPTSOVITS_POLICY.max_duration_sec),
                "too_short": bool(assessed.analysis.readable and 0 < dur < GPTSOVITS_POLICY.min_duration_sec),
                "valid_whole": bool(assessed.valid),
                "errors": [e.to_dict() for e in assessed.errors],
                "warnings": [w.to_dict() for w in assessed.warnings],
            }
            if payload["needs_region"]:
                payload["recommend"] = rr.recommend_region(args.input)
                payload["peaks"] = rr.coarse_peaks(args.input, buckets=500)
            emit("result", **payload)
            return

        if args.mode == "ref-trim":
            import reference_region as rr
            os.makedirs(args.output, exist_ok=True)
            out_path = os.path.join(args.output, "reference_clip_24k.wav")
            # 자동 경계 보정 경로(2단계). 요청 구간을 그대로 자르지 않고 파형 VAD 로
            # 안전한 무음 경계에 스냅한 뒤, 최종 클립 자체를 전사해 검증한다.
            # 안전 경계를 못 찾으면 trim_region 으로 물러서지 않고 차단한다.
            built = rr.build_reference_clip(
                args.input, float(args.region_start), float(args.region_dur), out_path)
            if not built["ready"]:
                emit("error", code="REFERENCE_REGION_BLOCKED",
                     blocking=built["blocking"],
                     requested_region=built["requested_region"],
                     effective_region=built["effective_region"],
                     validation=built.get("validation"), snap=built.get("snap"))
                return
            eff = built["effective_region"]
            metrics = rr.analyze_region(out_path, 0.0, eff["dur_sec"])
            # 승인 계약은 1단계 그대로 — blocking/warning_codes/ready 는 한 소스에서 나온다.
            metrics["warning_codes"] = sorted(set(metrics.get("warning_codes", []))
                                              | set(built["warning_codes"]))
            metrics["requested_region"] = built["requested_region"]
            metrics["effective_region"] = eff
            metrics["snap"] = built["snap"]
            metrics["validation"] = built["validation"]
            if metrics.get("blocking"):
                try:
                    os.remove(out_path)
                except OSError:
                    pass
                emit("error", code="REFERENCE_REGION_BLOCKED",
                     blocking=metrics["blocking"], metrics=metrics)
                return
            emit("result", clip_path=out_path, metrics=metrics)
            return

        # ── Reference transcribe (preview for 수동 전사 UI) ──
        if args.mode == "ref-transcribe":
            _run_ref_transcribe(args)
            return

        # ── Meta fix mode ──
        if args.mode == "meta-fix":
            _run_meta_fix(args)
            return

        # ── Track split mode ──
        if args.mode == "split":
            _run_split(args)
            return

        # ── Track process (individual) ──
        if args.mode == "track-process":
            _run_track_process(args)
            return

        # ── Transcribe-only mode ──
        if args.mode == "transcribe":
            _run_transcribe_only(args)
            return

        # ── Separation modes (music / conversation) ──
        tracks = []
        if args.mode == "music":
            if args.model == "roformer":
                emit("progress", percent=1, message="RoFormer 보컬 분리 엔진 로딩 중...")
                from music_worker import run_roformer_separation
                tracks = run_roformer_separation(args.input, args.output) or []
            elif args.model == "roformer_melband":
                emit("progress", percent=1, message="Mel-Band 보컬 분리 엔진 로딩 중... (bleedless)")
                from music_worker import run_roformer_separation, _MELBAND_ENSEMBLE_MODEL
                tracks = run_roformer_separation(args.input, args.output, _MELBAND_ENSEMBLE_MODEL) or []
            elif args.model == "roformer_ensemble":
                emit("progress", percent=1, message="보컬 앙상블 엔진 로딩 중... (BS + Mel-Band)")
                from music_worker import run_roformer_ensemble
                tracks = run_roformer_ensemble(args.input, args.output) or []
            else:
                emit("progress", percent=1, message="Demucs 엔진 로딩 중... (torch + demucs)")
                patch_torchaudio()
                from music_worker import run_music_separation
                tracks = run_music_separation(args.input, args.output, args.model) or []
        elif args.mode == "conversation":
            emit("progress", percent=1, message="화자 분리 엔진 로딩 중... (torch + speechbrain)")
            patch_torchaudio()
            from conversation_worker import run_conversation_separation
            emit("progress", percent=2, message="엔진 로딩 완료, 분리 시작")
            tracks = run_conversation_separation(
                args.input, args.output, args.n_speakers,
                gpu_policy=getattr(args, "gpu_policy", "auto")) or []

        if not tracks:
            # 워커(music_worker/conversation_worker)가 이미 구조화 오류(code·샘플레이트·
            # 채널 등)를 낸 뒤 return [] 한 경우가 있다. 메인 프로세스는 pending error 를
            # 나중 것으로 덮어쓰므로 여기서 code 없는 일반 오류를 또 보내면 근본 원인이
            # 지워지고 사용자는 가장 쓸모없는 마지막 메시지만 보게 된다.
            # → 그 실행의 첫 구조화 오류를 종결 권위로 남기고, 아무 오류도 없었을 때만
            #   일반 오류로 원인 없는 빈 결과를 보고한다.
            if not error_already_emitted():
                emit("error", message="분리 결과가 없습니다.")
            sys.exit(1)

        # Post-processing
        _post_process(args, tracks)

    except Exception as e:
        emit("error", message=str(e))
        sys.exit(1)


def _post_process(args, tracks):
    """Trim silence, transcribe, translate, convert format."""
    # Trim silence
    if args.trim_silence:
        emit("progress", percent=91, message="무음 구간 제거 중...")
        for t in tracks:
            wav, sr = load_audio(t["path"])
            trimmed = trim_silence(wav, sr, silence_gap_sec=args.silence_gap)
            trimmed_path = t["path"].replace(".wav", "_trimmed.wav")
            save_audio(trimmed_path, trimmed, sr)
            t["trimmed_path"] = trimmed_path
            emit("progress", percent=93, message=f"{t['label']} 무음 제거 완료")

    # Whisper transcription
    if args.transcribe:
        from transcribe_worker import transcribe_tracks, set_translate_model
        set_translate_model(getattr(args, "translate_model", "600m"))
        # 음악 모드는 보컬 트랙만 전사(드럼/베이스 등은 무의미 — 환각·시간낭비 방지).
        # 대화 모드 등은 모든 트랙(화자)을 전사. 개별 트랙 전사는 TrackList의 '가사' 버튼으로도 가능.
        targets = [t for t in tracks if t.get("name") == "vocals"] if args.mode == "music" else tracks
        if targets:
            transcribe_tracks(targets, args.output, args.whisper_model, args.translate, args.srt,
                              whisper_lang=getattr(args, "whisper_lang", ""))

    # Convert output format
    if args.output_format != "wav":
        ffmpeg = find_ffmpeg()
        if ffmpeg:
            emit("progress", percent=98, message=f"{args.output_format.upper()} 변환 중...")
            codec = {"mp3": ["-codec:a", "libmp3lame", "-q:a", "2"], "flac": ["-codec:a", "flac"]}
            for t in tracks:
                src = t["path"]
                if not src.endswith(".wav"):
                    continue
                dst = src.replace(".wav", f".{args.output_format}")
                cmd = [ffmpeg, "-y", "-i", src, *codec.get(args.output_format, []), dst]
                proc = subprocess.run(cmd, capture_output=True)
                if proc.returncode != 0 or not os.path.exists(dst):
                    # 변환 실패해도 결과는 살아있으므로 중단하지 않고 WAV 유지
                    emit("progress", percent=98, message=f"{t['label']} {args.output_format.upper()} 변환 실패 — WAV 유지")
                    continue
                t["path"] = dst

    emit("progress", percent=99, message="완료!")
    emit("result", tracks=tracks, outputDir=args.output)


def _run_ref_transcribe(args):
    """참조 음성 1개 자동 전사(수동 전사 UI 미리보기용). Whisper 로딩 포함 — 사용자 클릭 시에만.
    GPT 합성 경로와 동일하게 'small' 모델을 써서 결과가 일치하도록 한다. 구조화 결과를 emit."""
    from reference_transcript import transcribe_reference
    emit("status", message="참조 전사 미리보기", percent=0)
    emit("progress", percent=10, message="참조 음성 전사 중... (Whisper)")
    t = transcribe_reference(args.input, "small")
    emit("result", transcript=t.to_dict())


def _run_transcribe_only(args):
    """Transcribe-only mode."""
    emit("status", message="텍스트 추출 모드", percent=0)
    from transcribe_worker import transcribe_file, translate_to_korean, set_translate_model
    set_translate_model(getattr(args, "translate_model", "600m"))

    emit("progress", percent=5, message="오디오 변환 중...")
    wav_path = convert_to_wav(args.input)
    # 출력 파일은 임시 wav(converted.wav)가 아니라 원본 이름으로 저장
    orig_base = os.path.splitext(os.path.basename(args.input))[0]
    try:
        info = transcribe_file(wav_path, args.output, args.whisper_model, args.translate, args.srt,
                               whisper_lang=getattr(args, "whisper_lang", ""), base_name=orig_base)
    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass

    tracks = [{
        "name": "transcript",
        "label": f"텍스트 ({info['language']})",
        "path": info["txt_path"],
        "text": info["text"],
        "language": info["language"],
        "txt_path": info["txt_path"]
    }]
    if info.get("translated_text"):
        base = os.path.splitext(os.path.basename(args.input))[0]
        tracks.append({
            "name": "translation",
            "label": "한국어 번역",
            "path": os.path.join(args.output, f"{base}_korean.txt"),
            "text": info["translated_text"],
            "language": "ko"
        })

    emit("progress", percent=99, message="완료!")
    emit("result", tracks=tracks, outputDir=args.output)


def _run_track_process(args):
    """Process individual track (transcribe/translate)."""
    emit("status", message="트랙 개별 처리", percent=0)
    import whisper

    device = get_device(timeout_sec=10)
    base = os.path.splitext(os.path.basename(args.input))[0]
    text = None
    language = None

    if args.transcribe:
        emit("progress", percent=10, message="Whisper 모델 로딩 중...")
        w_model = whisper.load_model(args.whisper_model, device=device)
        emit("progress", percent=30, message="텍스트 추출 중...")

        from transcribe_worker import run_transcribe
        result = run_transcribe(w_model, args.input, getattr(args, "whisper_lang", ""))
        text = result["text"].strip()
        language = result.get("language", "unknown")

        txt_path = os.path.join(args.output, f"{base}.txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(text)

        # 타임라인 원문 저장 (재번역·타임라인 번역용)
        ts_path = os.path.join(args.output, f"{base}_timestamps.txt")
        with open(ts_path, "w", encoding="utf-8") as f:
            for seg in result["segments"]:
                f.write(f"[{fmt_time(seg['start'])} → {fmt_time(seg['end'])}] {seg['text'].strip()}\n")

        if args.srt:
            srt_path = os.path.join(args.output, f"{base}.srt")
            with open(srt_path, "w", encoding="utf-8") as f:
                for si, seg in enumerate(result["segments"], 1):
                    f.write(f"{si}\n{fmt_srt_time(seg['start'])} --> {fmt_srt_time(seg['end'])}\n{seg['text'].strip()}\n\n")

        emit("progress", percent=60, message=f"언어 감지: {language}")
    else:
        txt_path = os.path.join(args.output, f"{base}.txt")
        if os.path.exists(txt_path):
            with open(txt_path, "r", encoding="utf-8") as f:
                text = f.read().strip()

    translated = None
    if args.translate and text:
        if not language:
            emit("progress", percent=65, message="언어 감지 중...")
            w_model = whisper.load_model("base", device=device)
            audio = whisper.load_audio(args.input)
            audio = whisper.pad_or_trim(audio)
            mel = whisper.log_mel_spectrogram(audio).to(device)
            _, probs = w_model.detect_language(mel)
            language = max(probs, key=probs.get)

        if language != "ko":
            from transcribe_worker import translate_to_korean, set_translate_model
            set_translate_model(getattr(args, "translate_model", "600m"))
            emit("progress", percent=70, message=f"{language}→한국어 번역 중...")
            translated = translate_to_korean(text, language)
            if translated:
                kr_path = os.path.join(args.output, f"{base}_korean.txt")
                with open(kr_path, "w", encoding="utf-8") as f:
                    f.write(translated)
            # 세그먼트별 타임라인 번역 파일 생성 (timestamps.txt 있으면)
            from transcribe_worker import write_translation_timeline
            write_translation_timeline(args.output, base, language)

    track = {"name": base, "label": base, "path": args.input, "text": text or "", "language": language or "unknown"}
    if translated:
        track["translated_text"] = translated

    emit("progress", percent=99, message="완료!")
    emit("result", tracks=[track], outputDir=args.output)


def _run_split(args):
    """Track split mode. Uses ffmpeg direct extraction when timestamps provided."""
    emit("status", message="트랙 분할 모드", percent=0)

    import shutil  # datetime은 _extract_tracks_ffmpeg 내부에서 사용

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        emit("error", message="ffmpeg을 찾을 수 없습니다.")
        return

    split_seconds = []
    split_labels_list = []

    if args.split_points:
        # 숫자로 못 읽는 토큰은 조용히 버리지 않고 그대로 남겨 검증에서 거부되게 한다.
        split_seconds = _sm.parse_marker_csv(args.split_points)
        if args.split_labels:
            split_labels_list = args.split_labels.split('|')

    # If timestamps provided, use fast ffmpeg direct extraction (no WAV conversion needed)
    if split_seconds:
        emit("progress", percent=5, message=f"타임스탬프 {len(split_seconds)}개 지점으로 분할")

        # Copy input to temp ASCII path for ffmpeg compatibility
        import tempfile
        tmp_dir = tempfile.mkdtemp(prefix=_split_tmp_prefix(args))
        ext = os.path.splitext(args.input)[1]
        tmp_input = os.path.join(tmp_dir, f"source{ext}")
        shutil.copy2(args.input, tmp_input)

        try:
            # 총 길이(초). 실패하면 None → 마지막 트랙을 조용히 빠뜨리는 대신 구조화 오류로 중단.
            total_dur = _probe_total_duration(ffmpeg, tmp_input)
            if total_dur is None:
                # 길이를 모르면 마지막 트랙 경계를 만들 수 없다 → 조용히 빠뜨리지 말고 중단.
                emit("error", code="SPLIT_DURATION_UNKNOWN",
                     message="오디오 길이를 확인할 수 없어 분할을 중단했습니다.")
                return None

            # 마커 검증(단일 권위 split_markers). 조용한 clamp·정렬·중복제거를 하지 않고 거부한다 —
            # 예전에는 범위 밖 마커가 그대로 통과해 ffmpeg가 음수 -t를 받고, 앞쪽 트랙만 남긴 채 죽었다.
            _v = _sm.validate_markers(split_seconds, total_dur)
            if not _v["ok"]:
                emit("error", code="SPLIT_MARKERS_INVALID",
                     message="분할 지점이 올바르지 않아 분할을 중단했습니다.",
                     errors=_v["errors"])
                return None

            # Build time boundaries
            boundaries = [0.0] + split_seconds + [total_dur]

            # 트랙 이름/라벨: 커스텀 라벨 있으면 사용 + 파일명 안전화, 없으면 Track NN
            track_specs = []
            for idx in range(len(boundaries) - 1):
                lbl = split_labels_list[idx].strip() if idx < len(split_labels_list) and split_labels_list[idx].strip() else f"Track {idx + 1:02d}"
                safe_label = "".join(c for c in lbl if c not in r'\/:*?"<>|').strip()
                nm = f"{idx + 1:02d}_{safe_label}" if safe_label else f"track_{idx + 1:02d}"
                track_specs.append((nm, lbl))

            tracks = _extract_tracks_ffmpeg(ffmpeg, tmp_input, boundaries, track_specs, args, 10, 75)
            if tracks is None:
                return

            _save_tracklist(tracks, args.output)
            emit("progress", percent=90, message="분할 완료!")
            emit("result", tracks=tracks, outputDir=args.output)
        finally:
            try:
                os.remove(tmp_input)
                os.rmdir(tmp_dir)
            except OSError:
                pass
        return

    # Auto-detect mode: use ffmpeg silencedetect (no WAV conversion needed)
    emit("progress", percent=5, message="ffmpeg 무음 구간 자동 감지 중...")

    import tempfile, shutil, re
    # 마커가 없어 ffmpeg 무음 자동분할로 진입한다는 사실을 사용자에게 명시(예전엔 조용히 갈라졌다).
    emit("progress", percent=3, message="마커가 없어 자동 무음 분할을 사용합니다.")
    tmp_dir = tempfile.mkdtemp(prefix=_split_tmp_prefix(args))
    ext = os.path.splitext(args.input)[1]
    tmp_input = os.path.join(tmp_dir, f"source{ext}")
    shutil.copy2(args.input, tmp_input)

    try:
        # 총 길이(초). 위와 같은 규칙 — 실패는 조용한 누락이 아니라 명시 오류.
        total_dur = _probe_total_duration(ffmpeg, tmp_input)
        if total_dur is None:
            emit("error", code="SPLIT_DURATION_UNKNOWN",
                 message="오디오 길이를 확인할 수 없어 분할을 중단했습니다.")
            return None

        # Run silencedetect filter
        cmd = [ffmpeg, "-i", tmp_input, "-af", "silencedetect=noise=-35dB:d=1.5", "-f", "null", "-"]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        stderr = result.stderr

        # Parse silence_end timestamps
        # Format: [silencedetect @ ...] silence_end: 184.523 | silence_duration: 2.145
        silence_ends = []
        for match in re.finditer(r'silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)', stderr):
            end_time = float(match.group(1))
            dur = float(match.group(2))
            # Split point = middle of silence
            mid = end_time - dur / 2
            if mid > 1.0:  # Skip if too close to start
                silence_ends.append(mid)

        emit("progress", percent=20, message=f"{len(silence_ends)}개 무음 구간 감지")

        # Filter: minimum 10 seconds between splits
        filtered = []
        for t in silence_ends:
            if not filtered or (t - filtered[-1]) > 10:
                filtered.append(t)

        split_seconds = filtered
        emit("progress", percent=25, message=f"{len(split_seconds)}개 분할 지점 확정")

        # Use same fast ffmpeg extraction as timestamp mode
        boundaries = [0.0] + split_seconds + [total_dur]
        track_specs = [(f"track_{i + 1:02d}", f"Track {i + 1:02d}") for i in range(len(boundaries) - 1)]

        tracks = _extract_tracks_ffmpeg(ffmpeg, tmp_input, boundaries, track_specs, args, 25, 60)
        if tracks is None:
            return

        _save_tracklist(tracks, args.output)
        emit("progress", percent=90, message="분할 완료!")
        emit("result", tracks=tracks, outputDir=args.output)

    finally:
        try:
            os.remove(tmp_input)
            os.rmdir(tmp_dir)
        except OSError:
            pass


def _split_tmp_prefix(args):
    """split 임시폴더 접두사. runToken이 있으면 audioforge_split_<token>_ 형태.
    main의 split-temp-cleanup이 같은 규칙으로 이 실행 폴더만 골라 지운다."""
    token = getattr(args, "run_token", "") or ""
    if token and re.fullmatch(r"[A-Za-z0-9-]{4,64}", token):
        return f"audioforge_split_{token}_"
    return "audioforge_"


def _probe_total_duration(ffmpeg, media_path):
    """ffprobe로 총 길이(초)를 구한다. 실패/비정상값이면 None.

    None을 0으로 뭉개면 boundaries에서 마지막 끝점이 빠져 **마지막 트랙이 조용히 사라지는데도
    성공으로 보고**된다(감사 R5). 호출부는 None을 구조화 오류로 처리해야 한다.
    """
    try:
        ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe" + os.path.splitext(ffmpeg)[1])
        probe = subprocess.run([ffprobe, "-v", "quiet", "-show_entries", "format=duration",
                                "-of", "csv=p=0", media_path], capture_output=True, text=True)
        if probe.returncode != 0:
            return None
        raw = (probe.stdout or "").strip()
        if not raw:
            return None
        dur = float(raw)
    except (OSError, ValueError):
        return None
    if not math.isfinite(dur) or dur <= 0:
        return None
    return dur


def _extract_tracks_ffmpeg(ffmpeg, tmp_input, boundaries, track_specs, args, pct_start, pct_span):
    """boundaries 인접 구간을 ffmpeg 입력 시킹으로 추출 (타임스탬프/자동감지 공통 — L-1).
    track_specs[idx] = (name, label). 성공 시 tracks 리스트, 실패 시 emit('error') 후 None 반환.
    진행률은 pct_start ~ pct_start+pct_span 범위로 표시."""
    from datetime import datetime
    tracks = []
    total_tracks = len(boundaries) - 1
    source_name = os.path.splitext(os.path.basename(args.input))[0]

    for idx in range(total_tracks):
        pct = pct_start + int((idx / max(total_tracks, 1)) * pct_span)
        start_sec = boundaries[idx]
        end_sec = boundaries[idx + 1] if idx + 1 < len(boundaries) else None
        name, label = track_specs[idx]

        emit("progress", percent=pct, message=f"{label} 추출 중...")

        out_path = os.path.join(args.output, f"{name}.wav")
        # 입력 시킹(-ss가 -i 앞): 매 트랙 처음부터 디코딩하지 않고 즉시 점프.
        # 디코딩+재인코딩이므로 샘플 정확도 유지 (-to 대신 -t 구간길이 사용)
        cmd = [ffmpeg, "-y", "-ss", str(start_sec), "-i", tmp_input]
        if end_sec is not None:
            cmd.extend(["-t", str(end_sec - start_sec)])
        cmd.extend(["-acodec", "pcm_s16le", "-metadata", f"title={label}",
                    "-metadata", f"track={idx+1}/{total_tracks}",
                    "-metadata", f"album={source_name}", out_path])
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0 or not os.path.exists(out_path):
            stderr_tail = proc.stderr.decode("utf-8", errors="replace")[-300:]
            emit("error", message=f"'{label}' 추출 실패: {stderr_tail}")
            return None

        dur = (end_sec - start_sec) if end_sec else 0
        meta = {
            "track_number": idx + 1, "title": label,
            "start_time": round(start_sec, 3),
            "end_time": round(end_sec, 3) if end_sec else 0,
            "duration": round(dur, 3),
            "source_file": os.path.basename(args.input),
            "source_path": args.input,
            "split_date": datetime.now().isoformat(),
            "output_file": f"{name}.wav"
        }
        meta_path = os.path.join(args.output, f"{name}.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        tracks.append({"name": name, "label": f"{label} ({fmt_time(dur)})", "path": out_path, "meta_path": meta_path})

    return tracks


def _save_tracklist(tracks, output_dir):
    """Save _tracklist.txt with track numbers and timestamps."""
    ts_path = os.path.join(output_dir, "_tracklist.txt")
    with open(ts_path, "w", encoding="utf-8") as f:
        for t in tracks:
            mp = t.get("meta_path")
            if mp and os.path.exists(mp):
                with open(mp, "r", encoding="utf-8") as mf:
                    m = json.load(mf)
                f.write(f"{m.get('track_number', 0):02d}\t{fmt_time(m.get('start_time', 0))}\t{m.get('title', t['name'])}\n")


def _run_meta_fix(args):
    """Re-apply metadata from edited JSON files."""
    emit("status", message="메타데이터 재적용", percent=0)
    ffmpeg = find_ffmpeg()
    target_dir = args.output

    json_files = sorted([f for f in os.listdir(target_dir) if f.endswith('.json')])
    if not json_files:
        emit("error", message="JSON 메타 파일이 없습니다.")
        sys.exit(1)

    total = len(json_files)
    tracks = []

    for i, jf in enumerate(json_files):
        pct = int((i / total) * 90)
        meta_path = os.path.join(target_dir, jf)
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

        old_file = meta.get("output_file", "")
        old_path = os.path.join(target_dir, old_file)
        title = meta.get("title", f"Track {i+1}")

        safe_label = "".join(c for c in title if c not in r'\/:*?"<>|').strip()
        new_file = f"{meta.get('track_number', i+1):02d}_{safe_label}.wav" if safe_label else old_file
        new_path = os.path.join(target_dir, new_file)

        if old_path != new_path and os.path.exists(old_path):
            os.rename(old_path, new_path)
            meta["output_file"] = new_file
            emit("progress", percent=pct, message=f"이름 변경: {old_file} → {new_file}")

        if ffmpeg and os.path.exists(new_path):
            tmp = new_path + ".tmp.wav"
            cmd = [ffmpeg, "-y", "-i", new_path, "-metadata", f"title={title}", "-metadata", f"track={meta.get('track_number', i+1)}/{total}", "-codec", "copy", tmp]
            proc = subprocess.run(cmd, capture_output=True)
            if proc.returncode == 0 and os.path.exists(tmp):
                os.replace(tmp, new_path)
            else:
                emit("progress", percent=pct, message=f"태그 적용 실패 (파일은 유지): {new_file}")

        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        new_json = os.path.splitext(new_file)[0] + ".json"
        new_json_path = os.path.join(target_dir, new_json)
        if meta_path != new_json_path:
            os.rename(meta_path, new_json_path)

        tracks.append({"name": os.path.splitext(new_file)[0], "label": title, "path": new_path})

    emit("progress", percent=99, message="메타데이터 재적용 완료!")
    emit("result", tracks=tracks, outputDir=target_dir)


if __name__ == "__main__":
    # 봉투는 main()의 try 블록이 아니라 여기서 감싼다 — qwen-preflight / pitch-preflight 는
    # 그 try 이전에 return 하므로 안쪽 finally로는 덮이지 않는다.
    try:
        main()
    except SystemExit as _se:
        _code = _se.code
        _emit_final(_code if isinstance(_code, int) else (0 if _code is None else 1))
        raise
    except BaseException:
        _emit_final(1)
        raise
    else:
        _emit_final(0)
