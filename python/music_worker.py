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


COMBINE_AVG = "avg"
COMBINE_MIN_SPEC = "min_spec"
# 기존 동작을 기본으로 둔다. 음악 분리는 잘 쓰이고 있어 말없이 바꾸지 않는다.
COMBINE_DEFAULT = COMBINE_AVG


def combine_two(wa, wb, mode=COMBINE_DEFAULT):
    """두 모델 결과를 합친다. **평균이냐, 주파수별로 고르느냐.**

    ★왜 고르는 길이 필요한가 (2026-09-26, UVR 구현을 읽고)
      평균은 한쪽에만 나타난 것(= 그 모델의 오류)을 **절반으로 줄일 뿐 없애지 못한다.**
      UVR 은 주파수 칸마다 **작은 쪽**을 고른다 — 한쪽에만 크게 나타난 것은
      그 모델의 오류일 가능성이 높으므로 **버려진다.**
      사용자 신고가 '찢어진다'(= artifact) 이므로 기제가 정확히 맞는다.

      대가: 둘 다 제대로 잡은 소리도 작은 쪽으로 눌린다 — 조금 얇아질 수 있다.
      그래서 **고를 수 있게** 두고 기본은 건드리지 않는다. 판정은 청취로 한다.
    """
    if mode != COMBINE_MIN_SPEC:
        return (wa + wb) / 2.0
    import numpy as _np
    from audio_separator.separator.uvr_lib_v5 import spec_utils as su

    # ★앱의 `load_audio` 는 **torch 텐서**를 돌려준다. 스펙트럼 함수는 numpy 를 받는다.
    #   내 첫 검사는 librosa 로 직접 읽어(numpy) **실제 경로를 타지 않아** 통과했다.
    #   검사는 제품이 쓰는 길로 들어가야 한다(2026-09-26).
    def _np_of(x):
        return x.detach().cpu().numpy() if hasattr(x, 'detach') else _np.asarray(x)

    was_tensor = hasattr(wa, 'detach')
    wa_n, wb_n = _np_of(wa), _np_of(wb)
    # ★축을 돌리지 않는다. 이 함수들은 **(채널, 샘플)을 그대로** 받는다.
    #   UVR 안의 다른 자리(`ensemble_for_align`)가 `.T` 를 쓰는 것은
    #   **그쪽 입력이 (샘플, 채널)이라서**다. 맥락을 안 보고 따라 했다가
    #   채널이 0인 빈 결과를 얻었다(2026-09-26).
    specs = [su.wave_to_spectrogram_no_mp(wa_n), su.wave_to_spectrogram_no_mp(wb_n)]
    out = su.spectrogram_to_wave_no_mp(su.ensembling(su.MIN_SPEC, specs))
    # 되돌릴 때 길이가 한두 샘플 어긋난다 — 짧은 쪽에 맞춘다(복원 오차이지 절단이 아니다).
    n = min(out.shape[-1], wa_n.shape[-1])
    out = _np.ascontiguousarray(out[:wa_n.shape[0], :n], dtype='float32')
    if was_tensor:
        # ★받은 그대로 돌려준다. 형식이 바뀌면 부르는 쪽이 조용히 깨진다.
        import torch
        return torch.from_numpy(out)
    return out


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


def run_roformer_ensemble(input_path: str, output_dir: str,
                          combine: str = COMBINE_DEFAULT):
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
    except BaseException:
        # ★예외 갈래에만 정리가 없었다(2026-09-24 2차 감사).
        #   정상 갈래 네 곳에는 전부 있는데 여기만 빠져서, 두 번째 모델이 터지면
        #   첫 모델이 뽑은 보컬·반주가 곡 길이만큼 임시 폴더에 그대로 남았다.
        #   화면에는 "분리 실패" 만 뜨고, 이 접두사를 아는 청소 코드는 어디에도 없다.
        _sh.rmtree(tmp_root, ignore_errors=True)
        raise
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
            mixed = combine_two(wa[:ch, :n], wb[:ch, :n], combine)
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


# 조건을 바꿔 돌릴 때 쓰는 기본 묶음. 0 은 원래 조건이다.
MULTIPASS_SHIFTS = (0, -3)


def run_roformer_multipass(input_path: str, output_dir: str,
                           model_name: str = _ROFORMER_MODEL,
                           shifts=MULTIPASS_SHIFTS,
                           combine: str = COMBINE_MIN_SPEC):
    """같은 모델을 **조건만 바꿔 여러 번** 돌리고 합친다.

    ★이것이 UVR 에서 배운 핵심 기법이다 (2026-09-26).
      UVR 의 TTA · denoise · shifts 가 겉보기에 다르지만 **하나의 생각**이다:

          조건을 바꿔 여러 번 돌리면, **조건에 따라 달라지는 것은 모델의 오류**이고
          **조건과 무관하게 같은 것은 진짜 신호**다. 합치면 오류는 흩어지고 신호는 남는다.

      모델을 바꾸는 이야기가 아니다. **모델 하나로 된다.**

    ★왜 우리가 직접 만드나
      그 기능들은 MDX·VR·Demucs 갈래에만 있고 **우리 모델이 타는 roformer 갈래에는 없다**
      (받는 설정이 토막 크기·겹침·음높이·묶음 크기뿐이다). 그래서 기법만 가져와 여기서 한다.

    ★왜 음높이로 조건을 바꾸나
      라이브러리가 갈라내기 전에 음을 내리고 끝난 뒤 되돌려 준다(한 벌이라 결과 음높이는
      그대로다). 그래서 **결과끼리 바로 견줄 수 있다** — 조건만 다르고 축이 같다.

    ★왜 합치기는 작은 쪽인가
      평균은 한 번만 나타난 오류를 절반으로 줄일 뿐이고, 작은 쪽 고르기는 **버린다.**
      앞서 두 모델을 합칠 때는 효과가 없었는데, 그때는 두 모델이 0.9942 로 거의 같아
      **같은 방식으로 틀렸기 때문**이다. 조건을 바꾸면 다르게 틀릴 여지가 생긴다.

    ★대가: 돌린 횟수만큼 느려진다. 실측으로 한 번이 7.5~16초이므로 두 번이면 여유가 있다.
    """
    import shutil as _sh
    import tempfile

    passes = [int(x) for x in (shifts or (0,))]
    if len(passes) < 2:
        return run_roformer_separation(input_path, output_dir, model_name, passes[0] if passes else 0)

    emit("status", message="조건을 바꿔 %d번 갈라내는 중" % len(passes), percent=0)
    tmp_root = tempfile.mkdtemp(prefix="af_mp_")
    got = []
    try:
        for i, sh in enumerate(passes):
            emit("progress", percent=int(80 * i / len(passes)),
                 message="%d/%d번째 (음높이 %+d반음)" % (i + 1, len(passes), sh))
            d = os.path.join(tmp_root, str(i))
            os.makedirs(d, exist_ok=True)
            tracks = run_roformer_separation(input_path, d, model_name, sh)
            if not tracks:
                emit("error", message="%d번째 갈라내기가 비었습니다" % (i + 1))
                return []
            got.append(dict((t["name"], t["path"]) for t in tracks))

        emit("progress", percent=85, message="결과를 합치는 중")
        out = []
        for name, label in (("vocals", "보컬"), ("instrumental", "반주")):
            paths = [g.get(name) for g in got if g.get(name) and os.path.exists(g[name])]
            if not paths:
                continue
            merged, sr = load_audio(paths[0])
            for q in paths[1:]:
                w, _sr = load_audio(q)
                n = min(merged.shape[-1], w.shape[-1])
                ch = min(merged.shape[0], w.shape[0])
                merged = combine_two(merged[:ch, :n], w[:ch, :n], combine)
            dest = os.path.join(output_dir, "%s.wav" % name)
            os.makedirs(output_dir, exist_ok=True)
            save_audio(dest, merged, sr)
            out.append({"name": name, "label": label, "path": dest})
        if not out:
            emit("error", message="합칠 결과가 없습니다")
            return []
        emit("progress", percent=95, message="완료")
        return out
    finally:
        _sh.rmtree(tmp_root, ignore_errors=True)


def run_roformer_separation(input_path: str, output_dir: str, model_name: str = _ROFORMER_MODEL,
                            pitch_shift: int = 0):
    """RoFormer로 보컬/반주 2트랙 분리 (Demucs보다 보컬 SDR 우수).
    model_name으로 BS(기본)/Mel-Band 등 선택. audio-separator(onnxruntime+torch)는
    ComfyUI 환경에 이미 존재 — 별도 설치 불필요.

    pitch_shift — 갈라내기 **전에** 이만큼 음을 내리고, 끝난 뒤 **되돌린다**(반음).

    ★왜 이 손잡이가 있나 (2026-09-26, UVR 구현에서 가져옴)
      모델은 흔한 노래 음역에서 배웠다. 그 범위를 벗어난 소리는 잘 못 가른다.
      그래서 UVR 은 **모델이 일하는 조건 자체를 바꾼다** — 음역 안으로 끌어와
      갈라내고 다시 올린다. 되돌리는 것까지가 한 벌이라 결과의 음높이는 그대로다.

      이 곡의 보컬은 약 519Hz 로 유난히 높다(실측). 시도할 근거가 있다.

    ★합치는 방식(앙상블)으로는 이 곡이 나아지지 않았다.
      두 모델 결과가 0.9942 로 거의 같아 — **같은 방식으로 틀려서** 고를 것이 없었다.
      그래서 합치는 쪽이 아니라 **조건을 바꾸는 쪽**으로 왔다.
    """
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
    kw = {}
    if pitch_shift:
        # 갈라내기 전에 내리고, 라이브러리가 끝에서 되돌린다(pitch_fix). 한 벌이다.
        kw["mdxc_params"] = {"pitch_shift": int(pitch_shift)}
    sep = Separator(model_file_dir=model_dir, output_dir=output_dir, output_format="WAV", **kw)
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
