# -*- coding: utf-8 -*-
"""더빙 앞단 - 소리 꺼내기 → 보컬 갈라내기 → 알아듣기 → 번역을 하나로 잇는다.

네 단계가 전부 이미 있는 것을 부른다. 이 파일이 새로 하는 일은 셋뿐이다.

  1. **순서와 이어 하기** - 끝난 단계의 산출물이 있으면 다시 하지 않는다.
     전사까지 됐으면 다음에 번역부터 이어서 한다.
  2. **멈춘 자리를 이름으로 말한다** - 조용히 다음으로 넘어가지 않는다.
     실패해도 그때까지의 산출물은 지우지 않는다.
  3. **밖으로 나가는 번역을 막는다** - 아래 '왜 여기서 막는가' 를 보라.

무거운 일(GPU·모델)은 전부 `steps` 로 받는다. 그래서 이 파일의 판단은 GPU 없이 검사된다.

기획: doc/work-in-progress/video-dubbing.md
"""
import json
import os

STATE_FILE = 'state.json'
STATE_VERSION = 1


class DubPipelineError(RuntimeError):
    """앞단을 진행할 수 없다. 사유를 문구로 담는다."""


# ── 밖으로 나가는 번역 막기 ───────────────────────────────────────────────
#
# 왜 여기서 막는가: 화면에서 선택지를 숨기는 것만으로는 부족하다. 화면을 거치지 않고
# 이 함수를 부를 수 있고, 그러면 아무도 모르게 대사 전체가 인터넷으로 나간다.
# 자막 한 줄을 번역하는 것과 영상 한 편의 대사 전부를 보내는 것은 규모가 다르다.
# 그래서 **실행 경로 안쪽에서** 막고, 막혔다는 사실을 소리 내어 말한다.
BLOCKED_TRANSLATE_BACKENDS = ('google',)
DEFAULT_TRANSLATE_BACKEND = 'llm'


def check_translate_backend(backend):
    """더빙에 쓸 수 있는 번역 백엔드인지 본다. 아니면 사유와 함께 막는다."""
    v = (backend or DEFAULT_TRANSLATE_BACKEND).strip().lower()
    if v in BLOCKED_TRANSLATE_BACKENDS:
        raise DubPipelineError(
            "더빙에서는 '%s' 번역을 쓸 수 없습니다 - 영상의 대사 전체가 인터넷으로 나갑니다. "
            "로컬 번역('%s')을 쓰세요." % (v, DEFAULT_TRANSLATE_BACKEND))
    return v


# ── 단계와 산출물 ─────────────────────────────────────────────────────────
#
# 단계마다 '이것이 있으면 끝난 것' 인 파일을 못으로 박는다. 상태 파일이 없어져도
# 파일만 보고 어디까지 됐는지 알 수 있게 하기 위해서다.
STAGES = (
    ('audio', '소리 꺼내기', ('source.wav',)),
    ('separate', '보컬 갈라내기', ('vocals.wav', 'background.wav')),
    ('transcribe', '알아듣기', ('transcript.json',)),
    ('translate', '번역', ('lines.json',)),
)
STAGE_NAMES = tuple(s[0] for s in STAGES)
STAGE_LABELS = dict((s[0], s[1]) for s in STAGES)
STAGE_OUTPUTS = dict((s[0], s[2]) for s in STAGES)


def stage_paths(out_dir, stage):
    """그 단계가 남기는 파일들의 전체 경로."""
    if stage not in STAGE_OUTPUTS:
        raise DubPipelineError('모르는 단계입니다: %r' % (stage,))
    return [os.path.join(out_dir, name) for name in STAGE_OUTPUTS[stage]]


def source_signature(video_path, *, stat=os.stat):
    """이 영상이 그 영상인지 가리는 표. 바뀌었으면 지난 산출물은 못 쓴다.

    내용을 읽지 않는다 - 크기와 시각만 본다. 영상 파일을 열 이유가 없다."""
    try:
        st = stat(video_path)
    except OSError as e:
        raise DubPipelineError('영상 파일을 볼 수 없습니다: %s' % e)
    return {'name': os.path.basename(video_path),
            'size': int(st.st_size),
            'mtime': int(st.st_mtime)}


def read_state(out_dir, *, opener=None):
    """지난 진행 상태. 없거나 깨졌으면 빈 상태다 - 그것 때문에 멈추지 않는다."""
    path = os.path.join(out_dir, STATE_FILE)
    try:
        if opener is not None:
            raw = opener(path)
        else:
            with open(path, encoding='utf-8') as f:
                raw = f.read()
        data = json.loads(raw)
    except Exception:
        return {'version': STATE_VERSION, 'done': [], 'source': None}
    if not isinstance(data, dict) or data.get('version') != STATE_VERSION:
        return {'version': STATE_VERSION, 'done': [], 'source': None}
    done = data.get('done')
    return {'version': STATE_VERSION,
            'done': [d for d in done if d in STAGE_NAMES] if isinstance(done, list) else [],
            'source': data.get('source')}


def write_state(out_dir, state):
    with open(os.path.join(out_dir, STATE_FILE), 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def plan_stages(out_dir, signature, *, force=False, state=None, exists=os.path.isfile):
    """무엇을 다시 하고 무엇을 건너뛸지 정한다. 파일만 보고 정한다 - 아무것도 실행하지 않는다.

    건너뛰는 조건은 둘 다 만족할 때뿐이다:
      - 지난 상태가 그 단계를 끝났다고 기록했고,
      - 그 단계의 산출물이 **실제로 있다.**
    기록만 믿지 않는다. 사용자가 폴더를 치웠을 수 있다.

    ★한 단계를 다시 하면 그 뒤 단계도 전부 다시 한다. 갈라낸 소리가 바뀌었는데
      지난 전사를 그대로 쓰면 조용히 어긋난다.
    """
    st = read_state(out_dir) if state is None else state
    stale_source = bool(st.get('source')) and st.get('source') != signature
    done = [] if (force or stale_source) else list(st.get('done') or [])

    skip, run = [], []
    broken = False
    for name in STAGE_NAMES:
        if broken or name not in done:
            broken = True          # 여기서부터는 앞이 바뀌었으니 전부 다시 한다
            run.append(name)
            continue
        if all(exists(p) for p in stage_paths(out_dir, name)):
            skip.append(name)
        else:
            broken = True
            run.append(name)
    return {
        'skip': skip,
        'run': run,
        'reset_reason': ('영상이 바뀌었습니다' if stale_source
                         else ('처음부터 다시 하기' if force else '')),
    }


# ── 실행 ──────────────────────────────────────────────────────────────────

def run_front(video_path, out_dir, *, steps, translate_backend=DEFAULT_TRANSLATE_BACKEND,
              force=False, on_event=None, extra=None,
              exists=os.path.isfile, makedirs=os.makedirs):
    """앞단 네 단계를 순서대로 돌린다.

    steps - 단계 이름마다 함수. `steps['audio'](ctx)` 처럼 부른다.
            ctx 에는 video_path, out_dir, paths(지금까지의 산출물), backend 가 들어 있다.
            무거운 일을 전부 밖에 두어서 이 함수의 판단만 따로 검사할 수 있다.
    extra - 단계가 쓸 설정(whisper 모델, 언어 등)을 ctx 에 얹는다.
            여기서 정하는 이름(video_path, out_dir, backend, paths)은 덮어쓸 수 없다 -
            설정 하나가 실행 경로를 조용히 바꾸는 일이 없어야 한다.

    어긋나면 **멈춘 단계의 이름과 사유**를 담아 DubPipelineError 를 던진다.
    그때까지 끝난 단계는 상태에 남아 다음에 이어서 할 수 있다.
    """
    backend = check_translate_backend(translate_backend)   # 가장 먼저 막는다

    missing = [n for n in STAGE_NAMES if n not in steps]
    if missing:
        raise DubPipelineError('실행할 함수가 없는 단계: %s' % ', '.join(missing))

    signature = source_signature(video_path)
    makedirs(out_dir, exist_ok=True)
    plan = plan_stages(out_dir, signature, force=force, exists=exists)

    say = on_event or (lambda *a, **k: None)
    if plan['reset_reason']:
        say('reset', reason=plan['reset_reason'])

    state = {'version': STATE_VERSION, 'done': list(plan['skip']), 'source': signature}
    ctx = dict(extra or {})
    ctx.update({'video_path': video_path, 'out_dir': out_dir,
                'backend': backend, 'paths': {}})
    for name in plan['skip']:
        ctx['paths'][name] = stage_paths(out_dir, name)
        say('skip', stage=name, label=STAGE_LABELS[name])

    for name in plan['run']:
        say('start', stage=name, label=STAGE_LABELS[name])
        try:
            steps[name](ctx)
        except DubPipelineError:
            write_state(out_dir, state)
            raise
        except Exception as e:
            write_state(out_dir, state)
            raise DubPipelineError("'%s' 단계에서 멈췄습니다: %s"
                                   % (STAGE_LABELS[name], e))
        produced = stage_paths(out_dir, name)
        absent = [os.path.basename(p) for p in produced if not exists(p)]
        if absent:
            # 오류 없이 끝났는데 결과가 없는 경우. 조용히 다음으로 넘기면 뒤에서 엉뚱하게 터진다.
            write_state(out_dir, state)
            raise DubPipelineError("'%s' 단계가 끝났다는데 결과가 없습니다: %s"
                                   % (STAGE_LABELS[name], ', '.join(absent)))
        ctx['paths'][name] = produced
        state['done'].append(name)
        write_state(out_dir, state)
        say('done', stage=name, label=STAGE_LABELS[name])

    return {'out_dir': out_dir, 'backend': backend,
            'skipped': plan['skip'], 'ran': plan['run'], 'paths': ctx['paths']}
