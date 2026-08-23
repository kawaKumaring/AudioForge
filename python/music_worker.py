"""Demucs music source separation + RoFormer 고품질 보컬 분리."""

import os
from audio_utils import emit, load_audio, save_audio, convert_to_wav, get_device

# audio-separator RoFormer 보컬 모델 (SDR 12.97, ComfyUI 환경에 이미 설치됨)
_ROFORMER_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
# 앙상블 2번째 모델: Mel-Band(Kim FT2 bleedless, unwa) — 잔음/bleed 억제 특화.
# BS(full 계열)와 아키텍처·오차 특성이 달라 평균 시 아티팩트가 줄어든다.
_MELBAND_ENSEMBLE_MODEL = "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt"

# ---------------------------------------------------------------------------
# music_quality_p1 shadow 진단 게이트 (개발용)
# ---------------------------------------------------------------------------
# AF_MUSIC_P1_ENSEMBLE 은 이번 단계에서 off|shadow 만 지원한다(기본 off).
#   off  : 기존 0.5/0.5 앙상블 그대로 — P1 미호출, 진단 emit 없음.
#   shadow: 기존 0.5/0.5 결과를 그대로 저장하되, P1 후보(align_pair→weighted_ensemble)를
#           비저장 계산해 고정 화이트리스트 수치만 emit(진단). 출력·plan·원자 교체 불변.
# "on"(및 미지원/오타 값): 아직 미보정 → 조용히 shadow 로 강등하지 않고 명시적
#   MUSIC_P1_NOT_CALIBRATED 상태를 emit 하고 기존 출력을 그대로 둔다.
# env 는 개발용 shadow gate 일 뿐 제품 설정 권위가 아니다(IPC/config 계약 전 UI 노출 금지).
_P1_ENV = "AF_MUSIC_P1_ENSEMBLE"
# 진단 비용 한정: 전체 길이 상호상관은 O(n^2) 라 full-track 은 금지. 중앙 분석창만.
_P1_SHADOW_ANALYSIS_CAP = 1 << 13   # 8192 샘플
_P1_SHADOW_MAX_LAG = 256            # offset 탐색 상한(샘플)
# shadow emit 페이로드 화이트리스트(경로·샘플·파형·모델 로컬명 금지 — 수치·상태만).
_P1_SHADOW_KEYS = frozenset({
    "status", "offsetFrames", "polarity", "gain",
    "baselineError", "candidateError", "improvement",
    "candidateEligible", "elapsedMs",
})


def _resolve_p1_mode():
    """AF_MUSIC_P1_ENSEMBLE 을 off|shadow|not_calibrated 로 해석."""
    raw = os.environ.get(_P1_ENV, "").strip().lower()
    if raw in ("", "off"):
        return "off"
    if raw == "shadow":
        return "shadow"
    return "not_calibrated"   # "on" 포함 미보정/미지원 값 → 명시적 상태


def _emit_p1_shadow(**payload):
    """화이트리스트 밖 키를 방어적으로 제거하고 진단 이벤트를 emit."""
    safe = {k: v for k, v in payload.items() if k in _P1_SHADOW_KEYS}
    emit("music_p1_shadow", **safe)


def _p1_center_window(a, b, cap):
    """두 (C,N) 배열을 겹치는 중앙 구간 최대 cap 샘플로 잘라 등길이 반환(진단용)."""
    n = min(a.shape[-1], b.shape[-1])
    if n <= cap:
        return a[:, :n], b[:, :n]
    start = (n - cap) // 2
    return a[:, start:start + cap], b[:, start:start + cap]


def _p1_shadow_probe(wa, wb):
    """shadow 진단: P1 후보(align_pair→weighted_ensemble)를 비저장 계산해 고정
    화이트리스트 수치만 emit 한다. 기존 결과·plan 을 절대 바꾸지 않으며, 계산 실패는
    안전 진단 상태(P1_SHADOW_ERROR)로 격리한다 — 예외를 전파하지 않는다(음악 출력 보호).
    baselineError/candidateError 는 정렬 전/후 상관을 1-corr 로 환산한 정합 오차이며
    (원 mixture 없이 산출), 개선이 게이트를 통과할 때만 candidateEligible=True."""
    import time
    t0 = time.perf_counter()

    def _ms():
        return round((time.perf_counter() - t0) * 1000.0, 3)

    try:
        import numpy as _np
        import music_quality_p1 as _q
        a = _np.asarray(wa)
        b = _np.asarray(wb)
        # (C,N) 계약 확인 — 진단이므로 위반 시 예외 대신 안전 상태로 격리.
        if a.ndim != 2 or b.ndim != 2 or a.shape[0] != b.shape[0]:
            _emit_p1_shadow(status="P1_SHADOW_SKIPPED",
                            candidateEligible=False, elapsedMs=_ms())
            return
        seg_a, seg_b = _p1_center_window(a, b, _P1_SHADOW_ANALYSIS_CAP)
        a2, b2, dec = _q.align_pair(seg_a, seg_b, max_lag=_P1_SHADOW_MAX_LAG)
        _q.weighted_ensemble([a2, b2])   # 등가중 후보(미저장) — 결합 경로 검증만
        _emit_p1_shadow(
            status="OK",
            offsetFrames=int(dec.offset),
            polarity=int(dec.polarity),
            gain=round(float(dec.gain_ratio), 6),
            baselineError=round(1.0 - float(dec.corr_raw), 9),
            candidateError=round(1.0 - float(dec.corr_aligned), 9),
            improvement=round(float(dec.corr_aligned) - float(dec.corr_raw), 9),
            candidateEligible=bool(dec.applied),
            elapsedMs=_ms(),
        )
    except Exception:
        try:
            _emit_p1_shadow(status="P1_SHADOW_ERROR",
                            candidateEligible=False, elapsedMs=_ms())
        except Exception:
            pass


def _run_one_roformer(model_name, wav_input, model_dir, work_dir, pct_lo, pct_hi):
    """단일 RoFormer 모델로 분리 → {'vocals': path, 'instrumental': path} 반환.
    출력은 work_dir(전용 임시 폴더)에 남긴다(앙상블에서 두 모델 결과를 섞기 위함)."""
    from audio_separator.separator import Separator
    os.makedirs(work_dir, exist_ok=True)
    short = model_name.split(".")[0][:28]
    emit("progress", percent=pct_lo, message=f"모델 로딩: {short}… (첫 실행 시 다운로드)")
    sep = Separator(model_file_dir=model_dir, output_dir=work_dir, output_format="WAV")
    sep.load_model(model_name)
    emit("progress", percent=(pct_lo + pct_hi) // 2, message="보컬/반주 분리 중... (GPU)")
    outputs = sep.separate(wav_input)
    # 스템 명명이 모델마다 다르다: BS는 '(Vocals)'/'(Instrumental)', Mel-Band는
    # '(vocals)'/'(other)'. 대소문자 무시 + 반주 명칭 변형(other/no vocals 등) 인식.
    import re
    res = {}
    for fn in outputs:
        low = fn.lower()
        full = os.path.join(work_dir, fn)
        if re.search(r'instrumental|other|no[_ ]?vocal|accompan', low):
            res["instrumental"] = full
        elif "vocal" in low:
            res["vocals"] = full
    emit("progress", percent=pct_hi, message="분리 완료")
    return res


def run_roformer_ensemble(input_path: str, output_dir: str):
    """BS-RoFormer + Mel-Band(Kim FT2 bleedless) 2모델 앙상블.
    두 모델의 보컬/반주를 파형 평균(avg_wave)해 잔음·bleed를 줄인다.
    SDR을 크게 올리는 게 아니라 아티팩트를 줄이는 게 목적 — 단일 모델보다 2배 느림."""
    emit("status", message="보컬 앙상블 (BS + Mel-Band)", percent=0)
    try:
        import audio_separator  # noqa: F401
    except ImportError as e:
        emit("error", message=f"audio-separator가 설치되지 않았습니다: {e}")
        return []

    import tempfile
    import shutil as _sh
    import music_separation_integrity as msi

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model_dir = os.path.join(base_dir, "externals", "separator_models")
    os.makedirs(model_dir, exist_ok=True)

    emit("progress", percent=8, message="입력 오디오 변환 중...")
    wav_input = convert_to_wav(input_path)

    tmp_root = tempfile.mkdtemp(prefix="af_ens_")
    try:
        a = _run_one_roformer(_ROFORMER_MODEL, wav_input, model_dir,
                              os.path.join(tmp_root, "a"), 12, 48)
        b = _run_one_roformer(_MELBAND_ENSEMBLE_MODEL, wav_input, model_dir,
                              os.path.join(tmp_root, "b"), 50, 86)
    finally:
        try:
            os.remove(wav_input)
            os.rmdir(os.path.dirname(wav_input))
        except OSError:
            pass

    if "vocals" not in a or "vocals" not in b:
        _sh.rmtree(tmp_root, ignore_errors=True)
        emit("error", message="앙상블 분리 결과가 불완전합니다.")
        return []

    emit("progress", percent=90, message="두 모델 결과 앙상블(파형 평균) 중...")
    # P1 shadow gate 해석(개발용). shadow 는 아래 결합에서 스템별 진단만 emit 하고
    # 기존 0.5/0.5 저장을 바꾸지 않는다. "on"/미지원 값은 미보정 상태를 1회 알린다.
    p1_mode = _resolve_p1_mode()
    if p1_mode == "not_calibrated":
        _emit_p1_shadow(status="MUSIC_P1_NOT_CALIBRATED", candidateEligible=False)
    # 1단계: 모든 스템을 무결성 검증·결합해 메모리에 '기록 계획'만 만든다. 아직 디스크에
    # 쓰지 않는다 — 어느 한 스템이라도 무결성에 실패하면 부분 출력 없이 원자적으로 중단하고
    # 기존 산출물을 보존하기 위함. 조용한 min-length/min-channel 절단은 하지 않는다:
    # 스펙 불일치·비유한값은 구조화 오류로 승격 후 return [] (single-model fallback·재시도 없음).
    plan = []  # (out_path, kind, payload)  kind: "write" -> (mixed, sr) | "move" -> src
    for name, label in (("vocals", "보컬"), ("instrumental", "반주")):
        pa, pb = a.get(name), b.get(name)
        out_path = os.path.join(output_dir, f"{name}.wav")
        if pa and pb and os.path.exists(pa) and os.path.exists(pb):
            wa, sr = load_audio(pa)
            wb, sr_b = load_audio(pb)
            spec_a = msi.describe_audio(wa, sr)
            spec_b = msi.describe_audio(wb, sr_b)
            match = msi.check_spec_match(
                [spec_a, spec_b], labels=[f"{name}:BS", f"{name}:MelBand"])
            if match.failed:
                _sh.rmtree(tmp_root, ignore_errors=True)
                emit("error", code="MUSIC_ENSEMBLE_SHAPE_MISMATCH",
                     message="음악 분리 모델의 출력 형식이 일치하지 않아 앙상블을 중단했습니다.",
                     reason=f"{label} 앙상블 출력 스펙 불일치 — 조용한 절단 금지",
                     sampleRateA=spec_a.sample_rate, sampleRateB=spec_b.sample_rate,
                     channelsA=spec_a.channels, channelsB=spec_b.channels,
                     framesA=spec_a.length, framesB=spec_b.length)
                return []
            fa = msi.check_finite(wa, name=f"{name}:BS")
            fb = msi.check_finite(wb, name=f"{name}:MelBand")
            if fa.failed or fb.failed:
                _sh.rmtree(tmp_root, ignore_errors=True)
                emit("error", code="MUSIC_ENSEMBLE_NON_FINITE",
                     message="음악 분리 모델 출력에 유효하지 않은 값이 있어 앙상블을 중단했습니다.",
                     reason=f"{label} 앙상블 입력에 NaN/Inf 감지 — 저장 금지",
                     finiteA=fa.ok, finiteB=fb.ok)
                return []
            # 스펙 정합 확인됨 → min slice 는 실질 no-op. 기존 0.5/0.5 평균과 동일.
            n = min(wa.shape[-1], wb.shape[-1])
            ch = min(wa.shape[0], wb.shape[0])
            mixed = (wa[:ch, :n] + wb[:ch, :n]) / 2.0
            # shadow: P1 후보를 비저장 계산해 진단 수치만 emit. mixed/plan 불변,
            # 예외는 _p1_shadow_probe 내부에서 격리(음악 출력 보호).
            if p1_mode == "shadow":
                _p1_shadow_probe(wa[:ch, :n], wb[:ch, :n])
            plan.append((out_path, "write", (mixed, sr, name, label)))
        elif pa and os.path.exists(pa):
            plan.append((out_path, "move", (pa, name, label)))
        else:
            continue

    # 2단계: 전 스템이 검증을 통과한 뒤에만 디스크에 기록한다 (부분 출력 방지).
    tracks = []
    for out_path, kind, payload in plan:
        if kind == "write":
            mixed, sr, name, label = payload
            save_audio(out_path, mixed, sr)
        else:
            src, name, label = payload
            os.replace(src, out_path)
        tracks.append({"name": name, "label": label, "path": out_path})

    _sh.rmtree(tmp_root, ignore_errors=True)
    if not tracks:
        emit("error", message="앙상블 결과가 없습니다.")
        return []
    emit("progress", percent=95, message="앙상블 완료")
    return tracks


def run_roformer_separation(input_path: str, output_dir: str, model_name: str = _ROFORMER_MODEL):
    """RoFormer로 보컬/반주 2트랙 분리 (Demucs보다 보컬 SDR 우수).
    model_name으로 BS(기본)/Mel-Band 등 선택. audio-separator(onnxruntime+torch)는
    ComfyUI 환경에 이미 존재 — 별도 설치 불필요."""
    import re
    emit("status", message="RoFormer 보컬 분리", percent=0)

    try:
        from audio_separator.separator import Separator
    except ImportError as e:
        emit("error", message=f"audio-separator가 설치되지 않았습니다: {e}")
        return []

    # 모델은 프로젝트 externals에 캐싱 (gitignore, 재다운로드 방지)
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    model_dir = os.path.join(base_dir, "externals", "separator_models")
    os.makedirs(model_dir, exist_ok=True)

    emit("progress", percent=10, message="RoFormer 모델 로딩 중... (첫 실행 시 다운로드)")
    sep = Separator(model_file_dir=model_dir, output_dir=output_dir, output_format="WAV")
    sep.load_model(model_name)

    # 입력을 ffmpeg로 wav 정규화 — audio-separator 자체 로더(soundfile/librosa)가 못 읽는
    # 포맷(mo3 등 트래커 모듈 포함)도 ffmpeg가 지원하면 처리되도록. Demucs 경로와 동일 전처리.
    emit("progress", percent=30, message="입력 오디오 변환 중...")
    wav_input = convert_to_wav(input_path)

    emit("progress", percent=40, message="보컬/반주 분리 중... (GPU)")
    try:
        outputs = sep.separate(wav_input)  # output_dir에 파일 저장, 파일명 리스트 반환
    finally:
        try:
            os.remove(wav_input)
            os.rmdir(os.path.dirname(wav_input))
        except OSError:
            pass

    # 스템 명명이 모델마다 다르다(BS '(Vocals)/(Instrumental)', Mel-Band '(vocals)/(other)').
    # 대소문자 무시 + 반주 명칭 변형(other/no vocals/accompan) 인식.
    tracks = []
    for fn in outputs:
        low = fn.lower()
        full = os.path.join(output_dir, fn)
        if re.search(r'instrumental|other|no[_ ]?vocal|accompan', low):
            name, label = "instrumental", "반주"
        elif "vocal" in low:
            name, label = "vocals", "보컬"
        else:
            name, label = os.path.splitext(fn)[0], fn
        clean = os.path.join(output_dir, f"{name}.wav")
        if os.path.exists(full) and os.path.abspath(full) != os.path.abspath(clean):
            os.replace(full, clean)
        tracks.append({"name": name, "label": label, "path": clean})

    if not tracks:
        emit("error", message="RoFormer 분리 결과가 없습니다.")
        return []

    emit("progress", percent=90, message="분리 완료")
    return tracks


def run_music_separation(input_path: str, output_dir: str, model: str = "htdemucs"):
    """Separate music into stems using Demucs."""
    emit("status", message="Demucs 모델 로딩 중...", percent=0)

    try:
        import torch
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError as e:
        emit("error", message=f"필요한 패키지가 설치되지 않았습니다: {e}")
        return []

    emit("progress", percent=3, message="GPU 확인 중...")
    device = get_device(timeout_sec=10)
    emit("status", message=f"디바이스: {device.upper()}, 모델: {model}", percent=5)

    separator = get_model(model)
    separator.to(device)
    emit("progress", percent=15, message="모델 로딩 완료")

    emit("progress", percent=18, message="오디오 변환 중...")
    wav_path = convert_to_wav(input_path)

    try:
        emit("progress", percent=20, message="오디오 파일 로딩 중...")
        wav, sr = load_audio(wav_path)

        if sr != separator.samplerate:
            emit("progress", percent=22, message="리샘플링 중...")
            import torchaudio
            wav = torchaudio.transforms.Resample(sr, separator.samplerate)(wav)
            sr = separator.samplerate

        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)

        wav = wav.unsqueeze(0).to(device)
        emit("progress", percent=30, message="분리 처리 중... (시간이 걸릴 수 있습니다)")

        with torch.no_grad():
            sources = apply_model(separator, wav, progress=False, device=device)

        sources = sources.squeeze(0).cpu()
        source_names = separator.sources

        labels = {"vocals": "보컬", "drums": "드럼", "bass": "베이스", "other": "기타 악기"}

        tracks = []
        for i, name in enumerate(source_names):
            percent = 70 + int((i / len(source_names)) * 25)
            emit("progress", percent=percent, message=f"{labels.get(name, name)} 저장 중...")
            out_path = os.path.join(output_dir, f"{name}.wav")
            save_audio(out_path, sources[i], sr)
            tracks.append({"name": name, "label": labels.get(name, name), "path": out_path})

        emit("progress", percent=90, message="분리 완료")
        return tracks

    finally:
        try:
            os.remove(wav_path)
            os.rmdir(os.path.dirname(wav_path))
        except OSError:
            pass
