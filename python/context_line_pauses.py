"""연속 생성 음성의 줄 쉼. 확인된 단어 사이 무음만 늘리고 원본 샘플은 보존한다."""
import math
import numpy as np
from icl_alignment import build_unit_stream
from korean_cer import normalize_text


def units(text):
    return ''.join(c for c in normalize_text(text) if not c.isspace())


def plan_lines(parsed, boundary_kinds, boundary_gaps, max_chars=None):
    """조건 변경·문단·명시 쉼은 합치지 않는다. 토큰 예산은 기존 생성 분할기 소유."""
    if len(parsed) < 2:
        raise ValueError('줄 수가 비교 범위 밖입니다')
    if len({(e, s) for e, t, s in parsed}) != 1:
        raise ValueError('목소리나 연출이 다른 줄은 함께 생성하지 않습니다')
    if not boundary_kinds or len(boundary_kinds) != len(parsed) or any(k != 'line' for k in boundary_kinds[1:]):
        raise ValueError('일반 줄바꿈만 함께 생성할 수 있습니다')
    if not boundary_gaps or len(boundary_gaps) != len(parsed):
        raise ValueError('줄 쉼 정보가 없습니다')
    lines = [t for e, t, s in parsed]
    if any(not units(t) for t in lines) or (max_chars is not None and sum(map(len, lines)) > max_chars):
        raise ValueError('빈 줄 또는 긴 글은 비교 범위 밖입니다')
    pauses = [float(g) for g in boundary_gaps[1:]]
    if any(not math.isfinite(g) or not 0 <= g <= 5 for g in pauses):
        raise ValueError('쉼 시간이 유효하지 않습니다')
    return lines, pauses


def insert_line_pauses(audio, sr, lines, pauses, asr):
    """정렬은 전 문구 일치 + 단어 경계, 음향은 12ms 절대 무음. 불확실하면 그대로."""
    x = np.asarray(audio)
    if x.ndim != 1 or not len(x) or sr <= 0 or not np.all(np.isfinite(x)):
        raise ValueError('유효한 단일 채널 음성이 필요합니다')
    if len(pauses) != len(lines)-1 or any(not math.isfinite(g) or not 0 <= g <= 5 for g in pauses):
        raise ValueError('줄과 쉼 정보가 다릅니다')
    stream = [(u, a, b) for u, a, b in build_unit_stream(asr) if not u.isspace()]
    expected = ''.join(units(t) for t in lines)
    records = []
    valid_times = all(0 <= a <= b <= len(x)/sr for u,a,b in stream) and all(stream[i][1] <= stream[i+1][1] and stream[i][2] <= stream[i+1][2] for i in range(len(stream)-1))
    if not valid_times or ''.join(u for u, a, b in stream) != expected:
        return x.copy(), [{'boundary': i+1, 'status': 'TEXT_MISMATCH', 'added_samples': 0} for i in range(len(pauses))]
    inserts = []
    offset = 0
    minimum = max(1, math.ceil(sr * .012))
    for i, (line, gap) in enumerate(zip(lines, pauses)):
        offset += len(units(line))
        left, right = stream[offset-1], stream[offset]
        rec = {'boundary': i+1, 'status': 'NO_SAFE_SILENCE', 'added_samples': 0}
        # 같은 단어 시각을 공유하면 음절 내부: 절대 나누지 않는다.
        a, b = math.ceil(left[2]*sr), math.floor(right[1]*sr)
        if not 0 <= a < b <= len(x):
            rec['status'] = 'NO_WORD_GAP'
        else:
            quiet = np.abs(x[a:b]) <= .001
            edges = np.diff(np.r_[False, quiet, False].astype(np.int8))
            runs = [(int(s), int(e)) for s,e in zip(np.flatnonzero(edges==1),np.flatnonzero(edges==-1)) if e-s >= minimum]
            if runs:
                s,e = max(runs, key=lambda r:r[1]-r[0])
                pos = a+(s+e)//2
                # 기존 무음을 줄이지 않고 목표에 부족한 분량만 더한다.
                added = max(0, round(gap*sr)-(e-s))
                inserts.append((pos, added))
                rec.update(status='INSERTED' if added else 'ALREADY_SUFFICIENT', input_sample=pos,
                           quiet_samples=e-s, added_samples=added)
        records.append(rec)
    parts, cursor, added_total = [], 0, 0
    for pos, n in inserts:
        parts.extend([x[cursor:pos], np.zeros(n, dtype=x.dtype)])
        cursor = pos
        for r in records:
            if r.get('input_sample') == pos:
                r['output_sample'] = pos+added_total
        added_total += n
    parts.append(x[cursor:])
    return np.concatenate(parts), records


def resolve_line_mode(value):
    if value not in ('separate', 'context'):
        raise ValueError('줄 생성 방식은 separate 또는 context여야 합니다')
    return value


def line_sources(lines):
    out, start = [], 0
    for index, text in enumerate(lines):
        out.append({'source_segment_index': index, 'context_start': start,
                    'context_end': start+len(text)})
        start += len(text)+1
    return out
