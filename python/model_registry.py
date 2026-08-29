# -*- coding: utf-8 -*-
"""내부 모델 snapshot 해석 — from_pretrained 에 **로컬 절대경로**를 직접 넘기기 위한 단일 지점.

왜 cache_dir 이나 환경변수가 아니라 경로인가:
  * `cache_dir=` 는 앰비언트 HUGGINGFACE_HUB_CACHE 에 지는 경로가 있어 격리 환경에서
    네트워크로 새어 나갔다(실측).
  * process 전역 HF_HOME 을 바꾸는 방식은 같은 프로세스의 다른 모델 로딩·테스트에
    영향을 주고, huggingface_hub 상수가 import 시점에 굳는 경우도 있어 불안정하다.
  * snapshot 디렉터리를 **첫 인자**로 주면 hub 해석 자체가 일어나지 않는다 — 가장 단순하고
    가장 확실하다. 내부 snapshot 은 이미 실제 파일로 materialize 돼 있어 blobs 도 필요 없다.

이 모듈은 어떤 환경변수도 설정하지 않는다(읽기만 한다).
"""
import json
import os

MANIFEST_NAME = "model-manifest.json"
HF_SUBDIR = os.path.join("hf_models", "hub")


class ModelRegistryError(Exception):
    """manifest 부재·revision 불일치·필수 파일 손상. 전역 캐시 fallback·다운로드로 넘어가지 않는다."""


def _externals():
    import app_runtime
    return app_runtime.assets_root()


def manifest_path():
    return os.path.join(_externals(), MANIFEST_NAME)


def load_manifest():
    p = manifest_path()
    if not os.path.isfile(p):
        raise ModelRegistryError("MODEL_MANIFEST_NOT_FOUND: %s" % MANIFEST_NAME)
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        raise ModelRegistryError("MODEL_MANIFEST_UNREADABLE: %s" % type(e).__name__)


def _entry(repo_id):
    for m in load_manifest().get("models", []):
        if m.get("model") == repo_id:
            return m
    raise ModelRegistryError("MODEL_NOT_IN_MANIFEST: %s" % repo_id)


def hub_dir_name(repo_id):
    return "models--" + repo_id.replace("/", "--")


def snapshot_path(repo_id, verify_files=True):
    """내부 snapshot 절대경로. from_pretrained 의 첫 인자로 그대로 쓴다.

    검증: manifest 등재 → INTERNALIZED → revision 디렉터리 실재 → realpath 가 externals 아래
          → (verify_files) 필수 파일 존재·크기 일치.
    어느 하나라도 어긋나면 구조화 오류. 전역 캐시로 내려가지 않는다.
    """
    e = _entry(repo_id)
    status = e.get("status")
    if status != "INTERNALIZED":
        raise ModelRegistryError("MODEL_NOT_INTERNALIZED: %s (%s)" % (repo_id, status))
    rev = e.get("revision")
    if not rev:
        raise ModelRegistryError("MODEL_REVISION_MISSING: %s" % repo_id)
    root = _externals()
    snap = os.path.join(root, HF_SUBDIR, hub_dir_name(repo_id), "snapshots", rev)
    if not os.path.isdir(snap):
        raise ModelRegistryError("MODEL_SNAPSHOT_NOT_FOUND: %s@%s" % (repo_id, rev[:12]))
    real = os.path.realpath(snap)
    if not os.path.realpath(root) == os.path.commonpath([os.path.realpath(root), real]):
        raise ModelRegistryError("MODEL_SNAPSHOT_OUTSIDE_EXTERNALS: %s" % repo_id)
    # refs/main 이 있으면 manifest revision 과 일치해야 한다(둘이 갈라지면 조용히 옛 것을 쓴다).
    ref = os.path.join(root, HF_SUBDIR, hub_dir_name(repo_id), "refs", "main")
    if os.path.isfile(ref):
        with open(ref, encoding="utf-8") as f:
            on_disk = f.read().strip()
        if on_disk != rev:
            raise ModelRegistryError(
                "MODEL_REVISION_MISMATCH: %s manifest=%s disk=%s" % (repo_id, rev[:12], on_disk[:12]))
    if verify_files:
        want = e.get("file_sha256") or {}
        for rel in sorted(want):
            fp = os.path.join(snap, rel.replace("/", os.sep))
            if not os.path.isfile(fp):
                raise ModelRegistryError("MODEL_FILE_MISSING: %s :: %s" % (repo_id, rel))
    return snap


def verify_sha256(repo_id):
    """무거운 전수 해시 검증(설치 검증용). 로딩 경로에서는 부르지 않는다."""
    import hashlib
    e = _entry(repo_id)
    snap = snapshot_path(repo_id, verify_files=True)
    bad = []
    for rel, want in sorted((e.get("file_sha256") or {}).items()):
        fp = os.path.join(snap, rel.replace("/", os.sep))
        h = hashlib.sha256()
        with open(fp, "rb") as f:
            for b in iter(lambda: f.read(1 << 20), b""):
                h.update(b)
        if h.hexdigest() != want:
            bad.append(rel)
    return bad


def whisper_checkpoint(name):
    """whisper .pt 절대경로(있으면). 없으면 None — 호출부가 기존 계약대로 판단한다."""
    p = os.path.join(_externals(), "whisper_models", "%s.pt" % name)
    return p if os.path.isfile(p) else None
