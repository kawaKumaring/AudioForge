# -*- coding: utf-8 -*-
"""받아쓴 것을 **자막**으로 만든다 — 줄 나누기와 노출 시간.

왜 필요한가: 알아듣기가 내놓는 것은 '받아쓰기' 지 '자막' 이 아니다.
유튜브 자동 자막이 정확도 90%인데도 읽기 힘든 원인은 정확도가 아니라 여기다 —
문장 한가운데서 끊기고, 읽을 시간이 모자라고, 한 줄이 너무 길다.

업계에서 자막 도구 사이의 품질 차이는 대부분 알아듣기가 아니라 **이 손질**에서 난다.

지키는 규칙 (방송 자막의 통상값)
  · 초당 글자 수(CPS) 상한 — 이보다 빠르면 못 읽는다
  · 한 줄 글자 수 상한 · 최대 두 줄
  · 최소 노출 시간 — 너무 짧게 스쳐 지나가지 않게
  · 큐 사이 최소 간격 — 자막이 붙어 깜빡이지 않게
  · **문법 경계에서 끊기** — 조사·어미 뒤에서 끊고 낱말 가운데를 자르지 않는다

이 파일은 **계산만** 한다. 모델도 파일도 쓰지 않는다.
"""

# 한국어 자막의 통상값. 방송 기준(라틴 문자 42자/줄)을 글자 폭에 맞춰 잡았다.
MAX_CPS = 14.0          # 초당 글자 수. 한글은 라틴보다 정보 밀도가 높아 21보다 낮게 잡는다.
MAX_LINE_CHARS = 20     # 한 줄
MAX_LINES = 2
MIN_DURATION_SEC = 1.0
MAX_DURATION_SEC = 7.0
MIN_GAP_SEC = 0.08

# ── 라틴 문자 글의 상한 ────────────────────────────────────────────────────
# ★2026-09-22: 텍스트 추출의 자막도 이 손질을 태우면서 드러난 것 —
#   이 파일의 기본값은 **한글 기준**이다. 영어 자막에 20자/줄을 그대로 쓰면
#   멀쩡한 문장이 두 동강 난다. 글의 문자 종류를 보고 상한을 고른다.
LATIN_MAX_CPS = 21.0        # 방송 통상값
LATIN_MAX_LINE_CHARS = 42   # 방송 통상값

# 글자당 정보가 빽빽한 문자 — 한글·가나·한자. 이들이 섞여 있으면 좁은 상한을 쓴다.
_DENSE_RANGES = (
    (0xAC00, 0xD7A3),   # 한글 음절
    (0x1100, 0x11FF),   # 한글 자모
    (0x3040, 0x30FF),   # 히라가나·가타카나
    (0x4E00, 0x9FFF),   # 한자
    (0x3400, 0x4DBF),   # 한자 확장
)
# 이 비율 넘게 빽빽한 문자가 있으면 좁은 상한. 일본어는 라틴 낱말이 섞여도
# 대개 이 위로 올라오고, 영어에 고유명사로 한자가 하나 끼는 정도는 아래로 남는다.
DENSE_RATIO = 0.15


def is_dense_script(text):
    """글이 한글·가나·한자 위주인가. 빈 글은 아니라고 본다(라틴 상한이 더 너그럽다)."""
    t = (text or '')
    letters = [c for c in t if c.strip() and not c.isdigit()]
    if not letters:
        return False
    dense = sum(1 for c in letters
                if any(lo <= ord(c) <= hi for lo, hi in _DENSE_RANGES))
    return dense >= len(letters) * DENSE_RATIO


def pick_limits(text):
    """글에 맞는 상한. 돌려주는 것: {'max_cps':.., 'max_chars':..}

    ★한 곳에서만 고르게 해 둔다 — 자막 만드는 자리가 둘(더빙·텍스트 추출)이라
      각자 다른 숫자를 쓰기 시작하면 결과가 갈린다.
    """
    if is_dense_script(text):
        return {'max_cps': MAX_CPS, 'max_chars': MAX_LINE_CHARS}
    return {'max_cps': LATIN_MAX_CPS, 'max_chars': LATIN_MAX_LINE_CHARS}


# 여기 뒤에서 끊으면 자연스럽다(조사·어미·문장부호).
BREAK_AFTER = ('。', '．', '.', '!', '?', '！', '？', ',', '，', '、',
               '은', '는', '이', '가', '을', '를', '에', '의', '도', '와', '과',
               '고', '며', '서', '만', '요', '다', '죠', '까')


class SubtitleCueError(ValueError):
    """자막으로 만들 수 없는 입력. 사유를 문구로 담는다."""


def wrap_text(text, *, max_chars=MAX_LINE_CHARS, max_lines=MAX_LINES):
    """한 큐의 글을 줄로 나눈다. **문법 경계를 먼저 찾고**, 없으면 공백에서 끊는다.

    낱말 가운데를 자르지 않는다 — 읽는 사람이 걸린다.
    줄 수를 넘기면 넘긴 것을 그대로 돌려준다(자르지 않는다 — 글자를 잃지 않게).
    """
    t = ' '.join((text or '').split())
    if not t:
        return []
    if len(t) <= max_chars:
        return [t]

    lines = []
    rest = t
    while rest and len(lines) < max_lines:
        if len(rest) <= max_chars:
            lines.append(rest)
            rest = ''
            break
        cut = _find_cut(rest, max_chars)
        lines.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        # 두 줄을 넘겼다. 글자를 버리지 않고 마지막 줄에 붙인다 —
        # 읽기는 불편해도 **내용이 사라지는 것보다 낫다.**
        lines[-1] = (lines[-1] + ' ' + rest).strip()
    return lines


def _find_cut(text, max_chars):
    """max_chars 안에서 끊기 좋은 자리. 문법 경계 > 공백 > 그냥 자르기."""
    window = text[:max_chars + 1]
    for i in range(len(window) - 1, max_chars // 2, -1):
        if window[i - 1] in BREAK_AFTER:
            return i
    sp = window.rfind(' ')
    if sp > max_chars // 2:
        return sp
    return max_chars


def reading_speed(text, duration_sec):
    """초당 글자 수. 길이가 0이면 잴 수 없다."""
    n = len(' '.join((text or '').split()))
    if duration_sec <= 0:
        return None
    return n / float(duration_sec)


def build_cues(lines, *, max_cps=MAX_CPS, max_chars=MAX_LINE_CHARS, max_lines=MAX_LINES,
               min_sec=MIN_DURATION_SEC, max_sec=MAX_DURATION_SEC, min_gap=MIN_GAP_SEC):
    """줄 목록을 자막 큐로 만든다.

    lines - [{'start':초, 'end':초, 'text':글}, ...] 시작 시각 순서.

    고치는 것
      · 너무 짧은 큐를 늘린다(다음 큐를 침범하지 않는 선까지)
      · 너무 긴 큐를 줄인다
      · 큐 사이에 최소 틈을 둔다
    고치지 못한 것은 **경고로 남긴다** — 조용히 넘기지 않는다.
    """
    out = []
    for i, ln in enumerate(lines or []):
        try:
            start = float(ln['start'])
            end = float(ln['end'])
        except (KeyError, TypeError, ValueError) as e:
            raise SubtitleCueError('%d번째 줄의 시각을 읽지 못했습니다: %s' % (i + 1, e))
        text = ' '.join((ln.get('text') or '').split())
        if not text:
            continue
        out.append({'start': start, 'end': max(end, start), 'text': text,
                    'lines': wrap_text(text, max_chars=max_chars, max_lines=max_lines),
                    'warnings': []})

    for i, cue in enumerate(out):
        nxt = out[i + 1]['start'] if i + 1 < len(out) else None
        dur = cue['end'] - cue['start']

        if dur < min_sec:
            room = (nxt - min_gap - cue['start']) if nxt is not None else None
            want = cue['start'] + min_sec
            cue['end'] = want if room is None else min(want, max(cue['start'], room))
            if cue['end'] - cue['start'] < min_sec - 1e-6:
                cue['warnings'].append('다음 자막이 바짝 붙어 %.1f초밖에 못 띄웁니다'
                                       % (cue['end'] - cue['start']))
        elif dur > max_sec:
            cue['end'] = cue['start'] + max_sec

        if nxt is not None and cue['end'] > nxt - min_gap:
            cue['end'] = max(cue['start'], nxt - min_gap)

        cps = reading_speed(cue['text'], cue['end'] - cue['start'])
        cue['cps'] = cps
        if cps is not None and cps > max_cps:
            cue['warnings'].append('초당 %.1f자로 빠릅니다(상한 %.0f) — 글을 줄이면 읽기 좋아집니다'
                                   % (cps, max_cps))
        if len(cue['lines']) > max_lines:
            cue['warnings'].append('%d줄이라 화면을 많이 가립니다' % len(cue['lines']))
    return out


def summarize(cues):
    """한눈에. 몇 개가 규칙을 못 지켰는지 말한다."""
    bad = [c for c in cues if c['warnings']]
    speeds = [c['cps'] for c in cues if c.get('cps')]
    return {
        'cues': len(cues),
        'with_warnings': len(bad),
        'median_cps': sorted(speeds)[len(speeds) // 2] if speeds else 0.0,
        'max_cps': max(speeds) if speeds else 0.0,
        'two_line_cues': sum(1 for c in cues if len(c['lines']) > 1),
    }


def to_srt(cues, stamp):
    """자막 파일 글. 시각 표기 함수는 **받아서 쓴다** — 같은 계산을 두 곳에 두지 않는다."""
    out = []
    for n, cue in enumerate(cues, 1):
        out.append(str(n))
        out.append('%s --> %s' % (stamp(cue['start']), stamp(cue['end'])))
        out.extend(cue['lines'])
        out.append('')
    return '\n'.join(out)
