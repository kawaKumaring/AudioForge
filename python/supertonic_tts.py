"""Supertonic 3 — 참조 소리 없이 읽는 **기본 목소리 열 개**(여성 5 · 남성 5).

★왜 (2026-09-30 지시): "기본 모델들을 여러 개 연결해 봐라, 하나씩 사용자가 들어 보고 선택하게."
  그때까지 기본 목소리는 piper 한국어 하나(딱딱하게 읽는다는 피드백)뿐이었다.
  Supertonic 3(Supertone)은 한국어를 지원하고, ONNX 로 **CPU 에서** 돈다 — torch·GPU 를 건드리지 않는다.

★인터넷에 닿지 않는다. 공식 패키지(`pip install supertonic`)는 처음 실행 때 허깅페이스에서 모델을 받는다
  (`auto_download=True`) — 외부 전송 금지 원칙에 어긋나서 쓰지 않는다. 받아 둔 파일(`externals/supertonic3`)만
  onnxruntime 으로 연다. 없으면 **없다고 말한다**(받으러 가지 않는다).

★출처·조건
  - 모델: huggingface.co/Supertone/supertonic-3 — OpenRAIL-M(`externals/supertonic3/LICENSE`). model-licenses.json 에 적었다.
  - 추론 코드: github.com/supertone-inc/supertonic 의 py/helper.py(MIT)를 옮겨 왔다 — 받아 둔 모델만 쓰게 줄이고,
    입력 이름은 실제 모델에서 확인했다(duration_predictor · text_encoder · vector_estimator · vocoder).
  - 기본값은 만든 곳의 것: 다듬기 단계 8(5 낮음 ~ 12 높음), 속도 1.05.
"""
import json
import os
import re
from unicodedata import normalize

ROOT_ENV = "AUDIOFORGE_SUPERTONIC"
ROOT_DIRNAME = "supertonic3"
ONNX_FILES = ("duration_predictor.onnx", "text_encoder.onnx", "vector_estimator.onnx", "vocoder.onnx")
CONFIG_FILES = ("tts.json", "unicode_indexer.json")
TOTAL_STEPS = 8
BASE_SPEED = 1.05
LANG = "ko"
AVAILABLE_LANGS = ("en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu", "id",
                   "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na")
# 덩이 안에서 문장 사이 쉼(초) — 만든 곳의 값.
SILENCE_SEC = 0.3


def root(repo_root=None):
    env = os.environ.get(ROOT_ENV)
    if env:
        return env
    if repo_root is None:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(repo_root, "externals", ROOT_DIRNAME)


def missing_files(base):
    """없는 파일 이름들. 비면 다 있다."""
    out = [f for f in ONNX_FILES + CONFIG_FILES if not os.path.isfile(os.path.join(base, "onnx", f))]
    return out


def voice_label(style_id):
    """F1 → 여성 1, M3 → 남성 3. 모르는 이름은 그대로."""
    m = re.fullmatch(r"([FM])(\d+)", style_id or "")
    if not m:
        return style_id
    return ("여성 " if m.group(1) == "F" else "남성 ") + m.group(2)


def scan(repo_root=None):
    """받아 둔 목소리 스타일들 — [(id, path)]. 모델 파일이 빠졌으면 빈 목록과 사유."""
    base = root(repo_root)
    if not os.path.isdir(base):
        return [], "받아 둔 Supertonic 모델이 없습니다"
    miss = missing_files(base)
    if miss:
        return [], "모델 파일이 빠졌습니다: %s" % ", ".join(miss)
    styles_dir = os.path.join(base, "voice_styles")
    styles = []
    if os.path.isdir(styles_dir):
        for n in sorted(os.listdir(styles_dir)):
            if n.endswith(".json"):
                styles.append((n[:-5], os.path.join(styles_dir, n)))
    if not styles:
        return [], "목소리 스타일 파일이 없습니다"
    return styles, ""


def sample_rate(repo_root=None):
    with open(os.path.join(root(repo_root), "onnx", "tts.json"), "r", encoding="utf-8") as f:
        return int(json.load(f)["ae"]["sample_rate"])


# ── 글 다듬기(만든 곳의 규칙 그대로) ────────────────────────────────────────
_EMOJI = re.compile(
    "[\U0001f600-\U0001f64f\U0001f300-\U0001f5ff\U0001f680-\U0001f6ff\U0001f700-\U0001f77f\U0001f780-\U0001f7ff"
    "\U0001f800-\U0001f8ff\U0001f900-\U0001f9ff\U0001fa00-\U0001fa6f\U0001fa70-\U0001faff☀-⛿✀-➿"
    "\U0001f1e6-\U0001f1ff]+", flags=re.UNICODE)
_REPLACE = {"–": "-", "‑": "-", "—": "-", "_": " ", "“": '"', "”": '"', "‘": "'", "’": "'",
            "´": "'", "`": "'", "[": " ", "]": " ", "|": " ", "/": " ", "#": " ", "→": " ", "←": " "}


def preprocess(text, lang=LANG):
    text = normalize("NFKD", text)          # 한글은 자모로 풀린다 — 모델의 글자표가 자모 단위다
    text = _EMOJI.sub("", text)
    for k, v in _REPLACE.items():
        text = text.replace(k, v)
    text = re.sub(r"[♥☆♡©\\]", "", text)
    for k, v in {"@": " at ", "e.g.,": "for example, ", "i.e.,": "that is, "}.items():
        text = text.replace(k, v)
    for p in (",", ".", "!", "?", ";", ":", "'"):
        text = text.replace(" " + p, p)
    while '""' in text:
        text = text.replace('""', '"')
    while "''" in text:
        text = text.replace("''", "'")
    text = re.sub(r"\s+", " ", text).strip()
    if not re.search(r"[.!?;:,'\"')\]}…。」』】〉》›»]$", text):
        text += "."
    if lang not in AVAILABLE_LANGS:
        raise ValueError("Supertonic 이 모르는 언어: %s" % lang)
    return "<%s>%s</%s>" % (lang, text, lang)


def chunk_text(text, max_len=120):
    """문단 → 문장 단위로 max_len 글자 안쪽 덩이. 한국어·일본어는 120(만든 곳의 값)."""
    chunks = []
    for para in [p.strip() for p in re.split(r"\n\s*\n+", text.strip()) if p.strip()]:
        cur = ""
        for sent in re.split(r"(?<=[.!?])\s+", para):
            if len(cur) + len(sent) + 1 <= max_len:
                cur += (" " if cur else "") + sent
            else:
                if cur:
                    chunks.append(cur.strip())
                cur = sent
        if cur:
            chunks.append(cur.strip())
    return chunks


def _length_to_mask(lengths, max_len=None):
    import numpy as np
    max_len = int(max_len or lengths.max())
    ids = np.arange(0, max_len)
    return (ids < np.expand_dims(lengths, axis=1)).astype(np.float32).reshape(-1, 1, max_len)


class Supertonic:
    """모델을 한 번 열어 두고 여러 번 읽는다. 목소리 스타일은 파일마다 한 번만 읽는다."""

    def __init__(self, repo_root=None):
        import numpy as np  # noqa: F401 — 여기서 없으면 곧바로 알린다
        import onnxruntime as ort
        base = root(repo_root)
        miss = missing_files(base)
        if miss:
            raise RuntimeError("Supertonic 모델 파일이 빠졌습니다: %s" % ", ".join(miss))
        d = os.path.join(base, "onnx")
        with open(os.path.join(d, "tts.json"), "r", encoding="utf-8") as f:
            cfg = json.load(f)
        with open(os.path.join(d, "unicode_indexer.json"), "r", encoding="utf-8") as f:
            self._indexer = json.load(f)
        self.sample_rate = int(cfg["ae"]["sample_rate"])
        self._base_chunk = int(cfg["ae"]["base_chunk_size"])
        self._compress = int(cfg["ttl"]["chunk_compress_factor"])
        self._ldim = int(cfg["ttl"]["latent_dim"])
        opts = ort.SessionOptions()
        cpu = ["CPUExecutionProvider"]       # ★CPU 로만 — 합성(GPU)과 겹치지 않는다
        self._dp = ort.InferenceSession(os.path.join(d, ONNX_FILES[0]), sess_options=opts, providers=cpu)
        self._enc = ort.InferenceSession(os.path.join(d, ONNX_FILES[1]), sess_options=opts, providers=cpu)
        self._est = ort.InferenceSession(os.path.join(d, ONNX_FILES[2]), sess_options=opts, providers=cpu)
        self._voc = ort.InferenceSession(os.path.join(d, ONNX_FILES[3]), sess_options=opts, providers=cpu)
        self._styles = {}

    def style(self, path):
        import numpy as np
        if path not in self._styles:
            with open(path, "r", encoding="utf-8") as f:
                s = json.load(f)
            ttl_dims, dp_dims = s["style_ttl"]["dims"], s["style_dp"]["dims"]
            ttl = np.array(s["style_ttl"]["data"], dtype=np.float32).reshape(1, ttl_dims[1], ttl_dims[2])
            dp = np.array(s["style_dp"]["data"], dtype=np.float32).reshape(1, dp_dims[1], dp_dims[2])
            self._styles[path] = (ttl, dp)
        return self._styles[path]

    def _ids(self, text):
        import numpy as np
        t = preprocess(text)
        ids = np.zeros((1, len(t)), dtype=np.int64)
        for i, ch in enumerate(t):
            cp = ord(ch)
            v = self._indexer[cp] if cp < len(self._indexer) else -1
            # 글자표에 없는 글자(-1)는 빈칸으로 — 모델을 깨뜨리지 않는다.
            ids[0, i] = v if v is not None and v >= 0 else self._indexer[ord(" ")]
        return ids, _length_to_mask(np.array([len(t)], dtype=np.int64))

    def _infer(self, text, style, steps, speed, seed):
        import numpy as np
        ttl, dp = style
        ids, mask = self._ids(text)
        dur, = self._dp.run(None, {"text_ids": ids, "style_dp": dp, "text_mask": mask})
        dur = dur / speed
        emb, = self._enc.run(None, {"text_ids": ids, "style_ttl": ttl, "text_mask": mask})
        wav_len = (dur * self.sample_rate).astype(np.int64)
        chunk = self._base_chunk * self._compress
        latent_len = int((wav_len.max() + chunk - 1) // chunk)
        lat_mask = _length_to_mask((wav_len + chunk - 1) // chunk, latent_len)
        rng = np.random.default_rng(seed)
        xt = rng.standard_normal((1, self._ldim * self._compress, latent_len)).astype(np.float32) * lat_mask
        total = np.array([steps], dtype=np.float32)
        for step in range(steps):
            xt, = self._est.run(None, {"noisy_latent": xt, "text_emb": emb, "style_ttl": ttl, "text_mask": mask,
                                       "latent_mask": lat_mask, "current_step": np.array([step], dtype=np.float32),
                                       "total_step": total})
        wav, = self._voc.run(None, {"latent": xt})
        # 모델이 말한 길이만큼만 — 뒤의 채움을 자른다.
        return wav[0, : int(wav_len[0])]

    def synthesize(self, text, style_path, speed=1.0, steps=TOTAL_STEPS, seed=0):
        """글 → float32 소리(모노). 속도 1.0 = 만든 곳의 기본 빠르기(1.05)."""
        import numpy as np
        style = self.style(style_path)
        sp = BASE_SPEED * (float(speed) if speed and float(speed) > 0 else 1.0)
        pieces = []
        for i, part in enumerate(chunk_text(text)):
            if pieces:
                pieces.append(np.zeros(int(SILENCE_SEC * self.sample_rate), dtype=np.float32))
            pieces.append(self._infer(part, style, steps, sp, seed + i))
        if not pieces:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(pieces)
