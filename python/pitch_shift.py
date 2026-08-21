"""합성 결과 WAV의 음높이(pitch) 후처리 — ffmpeg rubberband 단일 경로.

계약(tts-prosody-integration-contract §6·§7):
- production pitch 경로는 **rubberband 단일**. 저품질 폴백(asetrate+atempo 등)은
  production 경로·pitch_method 값에서 완전히 배제한다.
- rubberband 미지원 ffmpeg에서 pitch!=0을 요청하면 조용히 저품질 대체하지 않고
  식별 가능한 오류(PITCH_UNAVAILABLE)를 던진다. pitch==0은 애초에 호출부에서 스킵된다.
- 이 모듈은 "input wav → output wav(임시)"만 만든다. 최종 synthesized.wav의 원자적
  교체(os.replace)와 무손상 보장은 호출부(tts_worker)가 책임진다. 모듈은 final을 직접
  건드리지 않는다. 실패 시 자신이 만든 부분 출력만 삭제하고 예외를 전파한다.
- 길이·샘플레이트 유지 + formant 보존(rubberband formant=preserved). 실측 근거는 계약 §7.
"""

import os
import subprocess

PITCH_MIN = -2.0
PITCH_MAX = 2.0
PITCH_STEP = 0.5

# 식별 가능한 오류 코드 — 호출부/UI가 "rubberband 미지원"을 구분해 처리하도록.
PITCH_UNAVAILABLE = "PITCH_UNAVAILABLE"

_FFMPEG_TIMEOUT_SEC = 120

# ffmpeg 경로별 rubberband 지원 여부 캐시: path -> (available: bool, method_or_reason: str)
_pitch_support_cache = {}


class PitchError(RuntimeError):
    """pitch 후처리 실패. code로 원인을 식별(예: PITCH_UNAVAILABLE)."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def clamp_quantize(semitones):
    """입력을 유효한 pitch 스텝으로 정규화한다(정규화 권위는 Python, 계약 §1.1).
    None/비수치 → 0.0. [-2.0, +2.0]로 clamp 후 0.5 단위로 반올림. 반환은 항상 유효 스텝값."""
    try:
        v = float(semitones)
    except (TypeError, ValueError):
        return 0.0
    if v != v or v in (float("inf"), float("-inf")):  # NaN/Inf 방어
        return 0.0
    if v < PITCH_MIN:
        v = PITCH_MIN
    elif v > PITCH_MAX:
        v = PITCH_MAX
    # 0.5 단위 반올림 후 부동소수 오차 제거(-0.0 → 0.0 포함)
    q = round(v / PITCH_STEP) * PITCH_STEP
    q = round(q, 1)
    return q + 0.0


def semitones_to_ratio(semitones):
    """반음 → 주파수 배율. ratio = 2 ** (semitones / 12)."""
    return 2.0 ** (float(semitones) / 12.0)


def _resolve_ffmpeg(ffmpeg):
    if ffmpeg:
        return ffmpeg
    from audio_utils import find_ffmpeg
    return find_ffmpeg()


def pitch_available(ffmpeg=None):
    """(available, reason) 반환. rubberband 필터가 있으면 (True, "rubberband"),
    없으면 (False, 사유). ffmpeg 자체가 없으면 (False, "ffmpeg-not-found").
    ffmpeg -filters 출력을 경로별로 캐시(반복 합성 시 재실행 회피)."""
    ff = _resolve_ffmpeg(ffmpeg)
    if not ff:
        return False, "ffmpeg-not-found"
    if ff in _pitch_support_cache:
        return _pitch_support_cache[ff]
    try:
        proc = subprocess.run([ff, "-hide_banner", "-filters"],
                              capture_output=True, timeout=30)
        out = (proc.stdout or b"").decode("utf-8", errors="replace")
        has_rb = any(
            line.split()[1] == "rubberband"
            for line in out.splitlines()
            if len(line.split()) >= 2
        )
        result = (True, "rubberband") if has_rb else (False, "rubberband-unsupported")
    except (OSError, subprocess.SubprocessError):
        # -filters 조회 자체 실패 → 미지원으로 취급(조용한 저품질 폴백 없음)
        result = (False, "ffmpeg-filters-query-failed")
    _pitch_support_cache[ff] = result
    return result


def apply_pitch_shift(input_path, semitones, output_path, *, ffmpeg=None):
    """input_path의 음높이를 semitones 반음만큼 이동해 output_path에 쓴다(rubberband 단일).

    - semitones는 내부에서 clamp_quantize로 재정규화한다. 정규화 결과가 0.0이면 이 함수를
      호출한 것 자체가 논리 오류(호출부가 0을 스킵해야 함) → ValueError.
    - rubberband 미지원 ffmpeg → PitchError(code=PITCH_UNAVAILABLE). 저품질 폴백 없음.
    - ffmpeg 실행 실패/timeout/returncode!=0/0바이트 → 부분 출력 삭제 후 PitchError.
    - 성공 시 output_path 반환. 길이·SR 유지, formant=preserved.
    """
    st = clamp_quantize(semitones)
    if st == 0.0:
        raise ValueError("apply_pitch_shift는 0 반음으로 호출할 수 없습니다 — 호출부가 스킵해야 합니다.")

    ff = _resolve_ffmpeg(ffmpeg)
    if not ff:
        raise PitchError("음높이 보정 실패 — ffmpeg 없음", code=PITCH_UNAVAILABLE)

    available, reason = pitch_available(ff)
    if not available:
        raise PitchError(
            f"음높이 보정 불가 — 이 ffmpeg는 rubberband를 지원하지 않습니다({reason}). "
            f"저품질 대체를 쓰지 않습니다.",
            code=PITCH_UNAVAILABLE,
        )

    ratio = semitones_to_ratio(st)

    def _rm_partial():
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass

    # rubberband: pitch만 이동(tempo=1 기본), formant 보존. 출력은 32-bit float WAV로 통일.
    filt = f"rubberband=pitch={ratio:.6f}:formant=preserved"
    cmd = [ff, "-y", "-i", input_path, "-filter:a", filt, "-acodec", "pcm_f32le", output_path]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=_FFMPEG_TIMEOUT_SEC)
    except (OSError, subprocess.SubprocessError) as e:  # TimeoutExpired 포함
        _rm_partial()
        raise PitchError(f"음높이 보정 중 오류: {e}")
    if proc.returncode != 0 or not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        _rm_partial()
        tail = (proc.stderr or b"")[-200:].decode("utf-8", errors="replace")
        raise PitchError(f"음높이 보정 실패: {tail}")
    return output_path
