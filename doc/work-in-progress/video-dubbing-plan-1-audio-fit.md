# 영상 더빙 1단계: 보정 엔진 — 구현 계획

> **작업자에게:** 이 계획은 과제 단위로 따라가며 구현한다. 각 단계는 체크박스(`- [ ]`)다.
> 기획서를 먼저 읽는다: `doc/work-in-progress/video-dubbing.md`

**목표:** 더빙에 쓸 소리 보정 부품 셋(시간 조절·음량 맞추기·덕킹)을 만들고,
"시간을 얼마나 줄여도 자연스러운가"의 한계선을 **실제로 들어 보고** 정한다.

**접근:** 전부 이 장비의 ffmpeg 8.1-full 필터로 한다(`rubberband`·`volume`·`sidechaincompress`).
새 모델·새 설치 없음. 파이썬 모듈 하나(`python/audio_fit.py`)에 부품을 모으고,
`python -m unittest` 로 **실제 소리를 만들어** 숫자로 확인한다.

**쓰는 것:** Python 3.12(앱 파이썬) · ffmpeg 8.1-full · soundfile · pyloudnorm · numpy · librosa

**★한계선은 측정으로 정하지 않는다.** 길이가 정확한지·음높이가 유지되는지는 숫자로 재지만,
"자연스러운가"는 사람이 듣고 판단한다. 마지막 과제가 견본을 만들어 사용자에게 건넨다.

---

## 파일 구조

- **생성** `python/audio_fit.py` — 보정 부품 셋. ffmpeg 을 부르고 숫자를 돌려준다. 화면·IPC 없음.
- **생성** `python/test_audio_fit.py` — 단위 검사. 게이트가 `python/test_*.py` 를 자동으로 전부 돌린다.
- **생성** `python/make_stretch_samples.py` — 배율별 견본을 만들고 길이·음높이를 재는 **측정 스크립트**.
  제품 코드가 아니다. 사용자가 듣고 한계선을 정하는 데 쓴다.
- **수정** `doc/work-in-progress/video-dubbing.md` — 마지막에 정해진 한계선 값을 적는다.

`audio_fit.py` 는 **부품만** 담는다. "언제 늘이고 언제 포기하는가" 하는 판단은 2단계(자리 맞추기)의 몫이다.
이 파일에 판단을 넣지 않는다.

---

## 과제 1: 뼈대와 길이 재기

**파일:**
- 생성: `python/audio_fit.py`
- 생성: `python/test_audio_fit.py`

- [ ] **1단계: 실패하는 검사를 쓴다**

`python/test_audio_fit.py` 를 만든다:

```python
# -*- coding: utf-8 -*-
"""audio_fit.py 단위 검사 — 저장소 fixture 음성만 쓴다(사용자 미디어 미사용).

실행: python -m unittest python/test_audio_fit.py

의존이 없으면(soundfile·numpy·ffmpeg) 해당 검사를 **건너뛰고 그 사실을 남긴다.**
건너뛴 것을 통과로 주장하지 않는다.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')

try:
    import soundfile as sf
    import numpy as np
    HAVE_SF = True
except Exception:
    HAVE_SF = False

try:
    import librosa            # 음높이 확인에만 쓴다
    HAVE_LIBROSA = True
except Exception:
    HAVE_LIBROSA = False

import audio_fit


@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestProbeDuration(unittest.TestCase):
    def test_길이를_초로_돌려준다(self):
        sec = audio_fit.probe_duration(FIXTURE)
        self.assertGreater(sec, 1.0)
        self.assertLess(sec, 60.0)

    def test_없는_파일은_사유와_함께_실패한다(self):
        with self.assertRaises(audio_fit.AudioFitError):
            audio_fit.probe_duration(os.path.join(REPO, 'no-such-file.wav'))


if __name__ == '__main__':
    unittest.main()
```

- [ ] **2단계: 실패를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: `ModuleNotFoundError: No module named 'audio_fit'`

- [ ] **3단계: 최소 구현**

`python/audio_fit.py` 를 만든다:

```python
# -*- coding: utf-8 -*-
"""더빙 보정 부품 — 시간 조절·음량 맞추기·덕킹.

전부 이 장비의 ffmpeg 필터로 한다(8.1-full 에 rubberband·volume·sidechaincompress 가 있다).
새 모델·새 설치가 필요 없다.

이 파일은 **부품만** 담는다. '언제 늘이고 언제 포기하는가' 하는 판단은 자리 맞추기(2단계)의 몫이다.
여기에 판단을 넣으면 같은 규칙이 두 곳에 생긴다.

실패는 숨기지 않는다 — ffmpeg 이 실패하면 사유를 담아 AudioFitError 를 던진다.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audio_utils import find_ffmpeg


class AudioFitError(RuntimeError):
    """보정 중 실패. 사유를 문구로 담는다."""


def _run_ffmpeg(args, *, ffmpeg=None):
    exe = ffmpeg or find_ffmpeg()
    cmd = [exe, '-hide_banner', '-loglevel', 'error', '-y'] + list(args)
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        tail = (r.stderr or b'').decode('utf-8', 'replace').strip()[-400:]
        raise AudioFitError('ffmpeg 실패(%d): %s' % (r.returncode, tail))
    return r


def probe_duration(path: str) -> float:
    """음원 길이(초). 파일이 없거나 읽히지 않으면 사유와 함께 실패한다."""
    if not os.path.isfile(path):
        raise AudioFitError('파일이 없습니다: %s' % os.path.basename(path))
    try:
        import soundfile as sf
        info = sf.info(path)
        return float(info.frames) / float(info.samplerate)
    except AudioFitError:
        raise
    except Exception as e:
        raise AudioFitError('길이를 읽지 못했습니다: %s' % e)
```

- [ ] **4단계: 통과를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: 검사 2건 OK (soundfile 이 없으면 skip 사유가 찍힌다)

- [ ] **5단계: 커밋**

```bash
git add python/audio_fit.py python/test_audio_fit.py
git commit -m "feat(dubbing): 보정 부품 뼈대와 길이 재기"
```

---

## 과제 2: 시간 조절 (음높이를 지킨다)

**파일:**
- 수정: `python/audio_fit.py`
- 수정: `python/test_audio_fit.py`

- [ ] **1단계: 실패하는 검사를 쓴다**

`python/test_audio_fit.py` 의 `if __name__` 앞에 붙인다:

```python
@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestStretchTo(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='af-fit-')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_원하는_길이로_맞춘다(self):
        src_sec = audio_fit.probe_duration(FIXTURE)
        target = src_sec * 0.8                      # 20% 짧게
        dest = os.path.join(self.dir, 'out.wav')
        r = audio_fit.stretch_to(FIXTURE, dest, target)
        self.assertTrue(os.path.isfile(dest))
        # 오차 50ms 안. rubberband 는 프레임 단위로 끊으므로 정확히 같지는 않다.
        self.assertLess(abs(r['out_sec'] - target), 0.05,
                        '실제 %.3f초 vs 목표 %.3f초' % (r['out_sec'], target))
        self.assertAlmostEqual(r['ratio'], src_sec / target, places=3)

    def test_늘이는_쪽도_된다(self):
        src_sec = audio_fit.probe_duration(FIXTURE)
        target = src_sec * 1.25                     # 25% 길게
        dest = os.path.join(self.dir, 'long.wav')
        r = audio_fit.stretch_to(FIXTURE, dest, target)
        self.assertLess(abs(r['out_sec'] - target), 0.05)
        self.assertLess(r['ratio'], 1.0)

    def test_배율_한계를_넘으면_한계까지만_하고_그_사실을_알린다(self):
        src_sec = audio_fit.probe_duration(FIXTURE)
        dest = os.path.join(self.dir, 'clamped.wav')
        r = audio_fit.stretch_to(FIXTURE, dest, src_sec / 10.0)   # 10배는 불가능
        self.assertEqual(r['ratio'], audio_fit.STRETCH_MAX_RATIO)
        self.assertTrue(r['clamped'], '한계에 걸렸으면 그 사실을 돌려준다')

    def test_목표가_0_이하면_사유와_함께_실패한다(self):
        dest = os.path.join(self.dir, 'bad.wav')
        with self.assertRaises(audio_fit.AudioFitError):
            audio_fit.stretch_to(FIXTURE, dest, 0.0)

    @unittest.skipUnless(HAVE_LIBROSA, 'librosa 없음 — 음높이 확인 건너뜀')
    def test_음높이가_유지된다(self):
        """★이것이 rubberband 를 쓰는 이유다. 단순 배속은 음높이가 올라가 다른 사람이 된다."""
        dest = os.path.join(self.dir, 'p.wav')
        src_sec = audio_fit.probe_duration(FIXTURE)
        audio_fit.stretch_to(FIXTURE, dest, src_sec * 0.8)

        def median_f0(path):
            y, sr = librosa.load(path, sr=16000, mono=True)
            f0 = librosa.yin(y, fmin=70, fmax=400, sr=sr)
            return float(np.median(f0))

        before, after = median_f0(FIXTURE), median_f0(dest)
        cents = 1200.0 * np.log2(after / before)
        self.assertLess(abs(cents), 50.0,
                        '음높이가 %.1f센트 움직였다(50센트=반음의 절반)' % cents)
```

- [ ] **2단계: 실패를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: `AttributeError: module 'audio_fit' has no attribute 'stretch_to'`

- [ ] **3단계: 구현**

`python/audio_fit.py` 의 `probe_duration` 아래에 붙인다:

```python
# rubberband 가 감당하는 범위. 이 밖은 소리가 무너진다.
# ★이 값은 '자연스러움의 한계'가 아니다 — 그것은 사람이 듣고 정하며 2단계가 쓴다.
STRETCH_MIN_RATIO = 0.5
STRETCH_MAX_RATIO = 2.0


def stretch_to(src: str, dest: str, target_sec: float, *, ffmpeg=None) -> dict:
    """음높이를 지키며 길이를 target_sec 에 맞춘다.

    ratio > 1 이면 빠르게(짧게), < 1 이면 느리게(길게).
    한계를 넘는 요구는 **한계까지만** 하고 `clamped=True` 로 알린다 — 조용히 포기하지 않는다.
    """
    if not target_sec or target_sec <= 0:
        raise AudioFitError('목표 길이는 0보다 커야 합니다: %r' % (target_sec,))
    src_sec = probe_duration(src)
    want = src_sec / target_sec
    ratio = max(STRETCH_MIN_RATIO, min(STRETCH_MAX_RATIO, want))
    clamped = abs(ratio - want) > 1e-9
    _run_ffmpeg(['-i', src, '-filter:a', 'rubberband=tempo=%.6f' % ratio, dest], ffmpeg=ffmpeg)
    return {
        'ratio': ratio,
        'requested_ratio': want,
        'clamped': clamped,
        'src_sec': src_sec,
        'target_sec': target_sec,
        'out_sec': probe_duration(dest),
    }
```

- [ ] **4단계: 통과를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: 검사 7건 OK. 음높이 검사의 이동량이 50센트 미만.

- [ ] **5단계: 커밋**

```bash
git add python/audio_fit.py python/test_audio_fit.py
git commit -m "feat(dubbing): 음높이를 지키며 시간을 조절한다(rubberband)"
```

---

## 과제 3: 음량 재기와 맞추기

**파일:**
- 수정: `python/audio_fit.py`
- 수정: `python/test_audio_fit.py`

- [ ] **1단계: 실패하는 검사를 쓴다**

```python
@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestLoudness(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='af-loud-')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_음량을_숫자로_돌려준다(self):
        lufs = audio_fit.measure_loudness(FIXTURE)
        self.assertIsNotNone(lufs)
        self.assertLess(lufs, 0.0, '정상 음원은 0 LUFS 보다 작다')
        self.assertGreater(lufs, -60.0)

    def test_너무_짧으면_잴_수_없다고_말한다(self):
        """★없는 값을 지어내지 않는다. 0.4초 미만은 이 방식으로 잴 수 없다."""
        short = os.path.join(self.dir, 'short.wav')
        y, sr = sf.read(FIXTURE)
        sf.write(short, y[: int(sr * 0.2)], sr)
        self.assertIsNone(audio_fit.measure_loudness(short))

    def test_목표_음량에_맞춘다(self):
        dest = os.path.join(self.dir, 'matched.wav')
        target = -23.0
        r = audio_fit.match_loudness(FIXTURE, dest, target)
        self.assertLess(abs(r['after_lufs'] - target), 1.0,
                        '맞춘 뒤 %.1f LUFS (목표 %.1f)' % (r['after_lufs'], target))

    def test_지나친_증폭은_한계까지만_하고_알린다(self):
        dest = os.path.join(self.dir, 'loudclamp.wav')
        r = audio_fit.match_loudness(FIXTURE, dest, 0.0, max_gain_db=6.0)
        self.assertEqual(r['gain_db'], 6.0)
        self.assertTrue(r['clamped'])

    def test_잴_수_없는_음원은_사유와_함께_실패한다(self):
        short = os.path.join(self.dir, 's2.wav')
        y, sr = sf.read(FIXTURE)
        sf.write(short, y[: int(sr * 0.2)], sr)
        with self.assertRaises(audio_fit.AudioFitError):
            audio_fit.match_loudness(short, os.path.join(self.dir, 'o.wav'), -23.0)
```

- [ ] **2단계: 실패를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: `AttributeError: module 'audio_fit' has no attribute 'measure_loudness'`

- [ ] **3단계: 구현**

`python/audio_fit.py` 에 붙인다:

```python
# 방송에서 쓰는 통합 음량 기준. 0.4초보다 짧은 소리는 이 방식으로 잴 수 없다.
LOUDNESS_MIN_SEC = 0.4
LOUDNESS_MAX_GAIN_DB = 12.0


def measure_loudness(path: str):
    """통합 음량(LUFS). **잴 수 없으면 None** — 없는 값을 지어내지 않는다."""
    if probe_duration(path) < LOUDNESS_MIN_SEC:
        return None
    try:
        import numpy as np
        import pyloudnorm as pyln
        import soundfile as sf
    except Exception as e:
        raise AudioFitError('음량을 재는 데 필요한 것이 없습니다: %s' % e)
    data, rate = sf.read(path)
    meter = pyln.Meter(rate)
    value = float(meter.integrated_loudness(data))
    if not np.isfinite(value):
        return None
    return value


def match_loudness(src: str, dest: str, target_lufs: float, *,
                   max_gain_db: float = LOUDNESS_MAX_GAIN_DB, ffmpeg=None) -> dict:
    """src 의 음량을 target_lufs 에 맞춰 dest 로 쓴다.

    한계를 넘는 증폭·감쇠는 **한계까지만** 하고 `clamped=True` 로 알린다.
    잴 수 없는 소리(너무 짧음)는 사유와 함께 실패한다 — 손대지 않고 넘기면 조용히 어긋난다.
    """
    before = measure_loudness(src)
    if before is None:
        raise AudioFitError('음량을 잴 수 없습니다(%.2f초 — %.1f초 이상 필요)'
                            % (probe_duration(src), LOUDNESS_MIN_SEC))
    want = target_lufs - before
    gain = max(-max_gain_db, min(max_gain_db, want))
    clamped = abs(gain - want) > 1e-9
    _run_ffmpeg(['-i', src, '-filter:a', 'volume=%.3fdB' % gain, dest], ffmpeg=ffmpeg)
    return {
        'before_lufs': before,
        'after_lufs': measure_loudness(dest),
        'gain_db': gain,
        'requested_gain_db': want,
        'clamped': clamped,
    }
```

- [ ] **4단계: 통과를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: 검사 12건 OK

- [ ] **5단계: 커밋**

```bash
git add python/audio_fit.py python/test_audio_fit.py
git commit -m "feat(dubbing): 음량을 재고 목표에 맞춘다"
```

---

## 과제 4: 덕킹 (말할 때 배경음이 물러난다)

**파일:**
- 수정: `python/audio_fit.py`
- 수정: `python/test_audio_fit.py`

- [ ] **1단계: 실패하는 검사를 쓴다**

```python
@unittest.skipUnless(HAVE_SF, 'soundfile 없음 — 공용 venv 필요')
class TestDuck(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp(prefix='af-duck-')
        self.sr = 24000
        # 배경음: 6초 내내 같은 크기의 낮은 음. (합성 신호 — 사용자 음원 아님)
        t = np.arange(self.sr * 6) / float(self.sr)
        self.bg = os.path.join(self.dir, 'bg.wav')
        sf.write(self.bg, (0.3 * np.sin(2 * np.pi * 220.0 * t)).astype('float32'), self.sr)
        # 목소리: 2~4초 구간에만 소리가 있다.
        v = np.zeros_like(t, dtype='float32')
        seg = slice(self.sr * 2, self.sr * 4)
        v[seg] = (0.5 * np.sin(2 * np.pi * 440.0 * t[seg])).astype('float32')
        self.voice = os.path.join(self.dir, 'voice.wav')
        sf.write(self.voice, v, self.sr)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def _rms(self, path, a, b):
        y, sr = sf.read(path)
        if y.ndim > 1:
            y = y.mean(axis=1)
        seg = y[int(a * sr):int(b * sr)]
        return float(np.sqrt(np.mean(seg ** 2)))

    def test_말하는_동안_배경음이_낮아진다(self):
        dest = os.path.join(self.dir, 'mixed.wav')
        r = audio_fit.duck(self.bg, self.voice, dest)
        self.assertTrue(os.path.isfile(dest))
        # 말이 없는 구간(0~1.5초)과 말하는 구간(2.5~3.5초)의 배경 성분을 비교한다.
        # 섞인 결과에서 말하는 구간은 목소리가 더해져 커지므로, **배경만** 따로 눌러 확인한다.
        self.assertIsNotNone(r.get('ducked_bg_path'))
        quiet = self._rms(r['ducked_bg_path'], 0.2, 1.5)
        during = self._rms(r['ducked_bg_path'], 2.5, 3.5)
        self.assertLess(during, quiet * 0.7,
                        '말하는 동안 배경이 %.4f, 조용할 때 %.4f — 충분히 낮아지지 않았다'
                        % (during, quiet))

    def test_말이_끝나면_배경음이_돌아온다(self):
        dest = os.path.join(self.dir, 'back.wav')
        r = audio_fit.duck(self.bg, self.voice, dest)
        quiet_before = self._rms(r['ducked_bg_path'], 0.2, 1.5)
        after = self._rms(r['ducked_bg_path'], 5.0, 5.8)
        self.assertGreater(after, quiet_before * 0.8, '말이 끝난 뒤 배경이 돌아와야 한다')

    def test_길이가_원본_배경음을_따른다(self):
        dest = os.path.join(self.dir, 'len.wav')
        audio_fit.duck(self.bg, self.voice, dest)
        self.assertLess(abs(audio_fit.probe_duration(dest)
                            - audio_fit.probe_duration(self.bg)), 0.05)
```

- [ ] **2단계: 실패를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: `AttributeError: module 'audio_fit' has no attribute 'duck'`

- [ ] **3단계: 구현**

`python/audio_fit.py` 에 붙인다:

```python
# 덕킹 기본값. 방송에서 쓰는 보통 값에서 출발한다 — 들어 보고 조정할 수 있게 인자로 연다.
DUCK_THRESHOLD = 0.03
DUCK_RATIO = 8.0
DUCK_ATTACK_MS = 20.0
DUCK_RELEASE_MS = 300.0


def duck(bg: str, voice: str, dest: str, *, threshold: float = DUCK_THRESHOLD,
         ratio: float = DUCK_RATIO, attack_ms: float = DUCK_ATTACK_MS,
         release_ms: float = DUCK_RELEASE_MS, ffmpeg=None) -> dict:
    """말하는 동안 배경음을 눌러(덕킹) 목소리와 섞는다.

    돌려주는 `ducked_bg_path` 는 **목소리를 섞기 전의 배경음**이다 — 검사와 진단이
    '정말 낮아졌는가' 를 섞인 소리가 아니라 배경음만 보고 확인할 수 있게 함께 낸다.
    """
    ducked_bg = os.path.splitext(dest)[0] + '.bg.wav'
    graph = (
        '[1:a]asplit=2[sc][v];'
        '[0:a][sc]sidechaincompress='
        'threshold=%.5f:ratio=%.3f:attack=%.1f:release=%.1f[bgd];'
        '[bgd]asplit=2[bgout][bgmix];'
        '[bgmix][v]amix=inputs=2:normalize=0[mix]'
        % (threshold, ratio, attack_ms, release_ms)
    )
    _run_ffmpeg([
        '-i', bg, '-i', voice, '-filter_complex', graph,
        '-map', '[mix]', dest,
        '-map', '[bgout]', ducked_bg,
    ], ffmpeg=ffmpeg)
    return {
        'ducked_bg_path': ducked_bg,
        'threshold': threshold,
        'ratio': ratio,
        'attack_ms': attack_ms,
        'release_ms': release_ms,
        'out_sec': probe_duration(dest),
    }
```

- [ ] **4단계: 통과를 확인한다**

실행: `python -m unittest python/test_audio_fit.py -v`
예상: 검사 15건 OK

문제가 나면: `sidechaincompress` 의 `threshold` 는 0~1 선형값이다. 배경이 충분히 안 낮아지면
`ratio` 를 올리거나 `threshold` 를 낮춘다. **검사의 단정(0.7배)을 낮추지 않는다** — 값을 고친다.

- [ ] **5단계: 커밋**

```bash
git add python/audio_fit.py python/test_audio_fit.py
git commit -m "feat(dubbing): 말하는 동안 배경음을 낮춘다(덕킹)"
```

---

## 과제 5: 배율 견본 만들기 — 한계선을 사람이 정하게

**파일:**
- 생성: `python/make_stretch_samples.py`

이 과제의 산출물은 **사용자가 들을 파일들**이다. 숫자만으로 한계선을 정하지 않는다.

- [ ] **1단계: 측정 스크립트를 쓴다**

`python/make_stretch_samples.py` 를 만든다:

```python
# -*- coding: utf-8 -*-
"""시간 조절 배율 견본 — 한계선을 **듣고** 정하기 위한 측정 스크립트.

제품 코드가 아니다. 저장소 fixture 음성으로 여러 배율의 견본을 만들고,
길이가 정확한지·음높이가 유지되는지를 숫자로 재서 함께 적는다.
'자연스러운가' 는 사람이 듣고 판단한다 — 이 스크립트는 판단하지 않는다.

실행:
  python python/make_stretch_samples.py [나갈폴더]
기본 나갈 폴더: _local/artifacts/dubbing/stretch-samples
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import librosa

import audio_fit

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(REPO, 'test', 'fixtures', 'audio', 'ko-speech-7s.wav')
RATIOS = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.7]


def median_f0(path):
    y, sr = librosa.load(path, sr=16000, mono=True)
    f0 = librosa.yin(y, fmin=70, fmax=400, sr=sr)
    return float(np.median(f0))


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        REPO, '_local', 'artifacts', 'dubbing', 'stretch-samples')
    os.makedirs(out_dir, exist_ok=True)

    src_sec = audio_fit.probe_duration(FIXTURE)
    base_f0 = median_f0(FIXTURE)
    lines = ['원본 %.3f초 · 음높이 중앙값 %.1fHz' % (src_sec, base_f0), '']

    for r in RATIOS:
        dest = os.path.join(out_dir, 'x%.2f.wav' % r)
        info = audio_fit.stretch_to(FIXTURE, dest, src_sec / r)
        f0 = median_f0(dest)
        cents = 1200.0 * np.log2(f0 / base_f0)
        lines.append(
            '%.2f배  길이 %.3f초(목표 %.3f초, 오차 %+.0fms)  음높이 %+.1f센트  %s'
            % (r, info['out_sec'], info['target_sec'],
               (info['out_sec'] - info['target_sec']) * 1000.0, cents,
               os.path.basename(dest)))

    report = os.path.join(out_dir, 'measurements.txt')
    with open(report, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    print('\n견본과 측정값: %s' % out_dir)
    print('★어느 배율까지 자연스러운지는 **들어 보고** 정한다. 이 스크립트는 판단하지 않는다.')


if __name__ == '__main__':
    main()
```

- [ ] **2단계: 돌린다**

실행: `python python/make_stretch_samples.py`
예상: 배율 7개의 줄이 찍히고, 길이 오차가 전부 ±50ms 안, 음높이 이동이 전부 ±50센트 안.

- [ ] **3단계: 커밋**

```bash
git add python/make_stretch_samples.py
git commit -m "test(dubbing): 시간 조절 배율 견본 만들기 — 한계선은 듣고 정한다"
```

- [ ] **4단계: 사용자에게 건넨다**

견본 폴더 경로와 측정표를 보고하고 **어느 배율까지 쓸 만한지 물어본다.**
`_local/` 은 저장소에 올라가지 않는다 — 파일은 이 컴퓨터에만 남는다.

---

## 과제 6: 한계선을 기획서에 적고 게이트를 확인한다

**파일:**
- 수정: `doc/work-in-progress/video-dubbing.md`

- [ ] **1단계: 사용자가 정한 값을 적는다**

기획서 '자리 맞추기 규칙' 의 `★한계선의 값은 아직 모른다` 문단을 지우고, 정해진 값과
**어떻게 정했는지**(견본을 듣고 정했다는 사실, 측정된 길이 오차·음높이 이동)를 적는다.

★한계선 상수 자체는 여기서 코드에 넣지 않는다 — 그것을 쓰는 것은 2단계(자리 맞추기)이고,
쓰는 자리에 두어야 같은 값이 두 곳에 생기지 않는다.

- [ ] **2단계: 게이트를 돌린다**

실행: `npm run verify:ui`
예상: 전부 통과. 새 파이썬 검사는 `python/test_*.py` 자동 수집으로 '파이썬 시험 전량' 에 포함된다
(따로 등록하지 않는다). 파이썬 검사 수가 늘어난 것을 확인한다.

- [ ] **3단계: 커밋하고 푸시한다**

```bash
git add doc/work-in-progress/video-dubbing.md
git commit -m "docs(dubbing): 시간 조절 한계선을 청취로 확정"
git push origin develop
```

---

## 이 계획이 끝나면

- 더빙에 쓸 보정 부품 셋이 실제로 돌고, 검사가 **숫자로** 지킨다.
- 시간 조절의 한계선이 **들어 본 근거로** 정해져 기획서에 남는다.
- 2단계(자리 맞추기 계산)가 그 값을 받아 쓸 준비가 된다.

**이 계획에서 하지 않는 것:** 자리 맞추기 판단(2단계), 앞단 이어 달리기(3단계),
화면(4단계), 영상 내보내기(5단계). 부품만 만든다.
