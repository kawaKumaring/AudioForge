# -*- coding: utf-8 -*-
"""알아듣기 앞에 소리를 손질한다 — 배경음 걷어내기.

왜(2026-09-21 실측): 같은 소리를 그대로 넣으면 68.5%, 배경음을 걷어내고 넣으면 74.3% 였다.
**+5.8%포인트.** 같은 날 시험한 모델 교체(-9~-17%포인트)와 설정 조정(±2%포인트)을
전부 합친 것보다 크다. 게다가 더 빠르다(32초 → 24초) — 배경음 위에서 지어내던
헛말이 줄어 구간이 42개에서 35개로 줄었다.

★그런데 **늘 켜면 안 된다.**
  배경음이 없는 깨끗한 말소리에서는 분리기가 오히려 목소리를 상하게 한다.
  그래서 '배경음이 실제로 있는가' 를 재서 정한다.

★**너무 갈라내도 안 된다.** 같은 날 실측: 주 보컬까지 갈라내면 74.3% → 73.1% 로 떨어졌다.
  화음에도 가사 정보가 들어 있다. **보컬/반주까지만** 가른다.

이 파일은 판단만 한다. 실제 분리는 music_worker 가 하고, 여기서는 **함수로 받는다** —
그래야 모델 없이 검사할 수 있다.
"""
import os

# 배경음이 이만큼 조용하면 '없는 것' 으로 본다(보컬 대비, dB).
# 20dB 는 열 배 차이다 — 이 정도면 걷어낼 것이 없다고 봐도 된다.
QUIET_BACKGROUND_DB = 20.0

MODE_AUTO = 'auto'        # 재 보고 정한다(권장)
MODE_ALWAYS = 'always'    # 늘 걷어낸다
MODE_NEVER = 'never'      # 걷어내지 않는다(예전 그대로)
MODES = (MODE_AUTO, MODE_ALWAYS, MODE_NEVER)


class AsrPreprocessError(RuntimeError):
    """앞 손질 중 실패. 사유를 문구로 담는다."""


def normalize_mode(value):
    v = (value or MODE_NEVER).strip().lower()
    return v if v in MODES else MODE_NEVER


def background_gap_db(vocals_lufs, background_lufs):
    """보컬이 배경음보다 얼마나 큰가(dB). 잴 수 없으면 None."""
    if vocals_lufs is None or background_lufs is None:
        return None
    return float(vocals_lufs) - float(background_lufs)


def decide_from_gap(gap_db, *, quiet_db=QUIET_BACKGROUND_DB):
    """갈라낸 결과를 보고 **어느 쪽을 쓸지** 정한다.

    돌려주는 것: (보컬을 쓸까, 왜)
    ★못 쟀으면 **원본을 쓴다.** 모르면 건드리지 않는 쪽이 안전하다.
    """
    if gap_db is None:
        return False, '배경음 크기를 재지 못해 원본을 씁니다'
    if gap_db >= quiet_db:
        return False, '배경음이 %.0fdB 나 작아 걷어낼 것이 없습니다' % gap_db
    return True, '배경음이 보컬보다 %.0fdB 작을 뿐이라 걷어냅니다' % gap_db


def prepare(src, work_dir, mode=MODE_NEVER, *, separate_fn=None, loudness_fn=None,
            quiet_db=QUIET_BACKGROUND_DB):
    """전사에 넣을 소리를 고른다.

    separate_fn(src, out_dir) -> [{'name':..., 'path':...}, ...]
    loudness_fn(path) -> LUFS 또는 None

    돌려주는 것: {'path': 넣을 소리, 'separated': 걷어냈는가, 'reason': 왜, 'gap_db': 잰 값}
    ★어떤 경우에도 **path 는 비지 않는다.** 실패하면 원본으로 돌아간다 —
      알아듣기 자체가 막히면 안 된다.
    """
    mode = normalize_mode(mode)
    out = {'path': src, 'separated': False, 'reason': '', 'gap_db': None, 'mode': mode}
    if mode == MODE_NEVER:
        out['reason'] = '걷어내지 않도록 설정돼 있습니다'
        return out
    if separate_fn is None:
        out['reason'] = '분리기를 쓸 수 없어 원본을 씁니다'
        return out

    try:
        tracks = separate_fn(src, work_dir) or []
    except Exception as e:
        out['reason'] = '분리에 실패해 원본을 씁니다: %s' % e
        return out

    by = dict((t.get('name'), t.get('path')) for t in tracks if t.get('name'))
    vocals = by.get('vocals')
    # RoFormer 는 반주를 통째로 준다. Demucs 면 보컬 아닌 것 중 아무거나로 크기를 가늠한다.
    background = by.get('instrumental') or by.get('other') or by.get('drums')
    if not vocals or not os.path.isfile(vocals):
        out['reason'] = '갈라낸 것에 보컬이 없어 원본을 씁니다'
        return out

    if mode == MODE_ALWAYS:
        out.update({'path': vocals, 'separated': True,
                    'reason': '늘 걷어내도록 설정돼 있습니다'})
        return out

    gap = None
    if loudness_fn and background and os.path.isfile(background):
        try:
            gap = background_gap_db(loudness_fn(vocals), loudness_fn(background))
        except Exception:
            gap = None
    use_vocals, why = decide_from_gap(gap, quiet_db=quiet_db)
    out['gap_db'] = gap
    out['reason'] = why
    if use_vocals:
        out.update({'path': vocals, 'separated': True})
    return out
