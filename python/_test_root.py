# -*- coding: utf-8 -*-
"""테스트 전용 폴더 — tools/test-root.cjs 의 파이썬 짝(2026-10-10).

자리: 본체 저장소의 `_local/테스트` (환경변수 AF_TEST_ROOT 가 이긴다). 하위 폴더 이름은 JS 쪽과 같다.
"""
import os

SUB = {"temp": "임시", "results": "결과", "shots": "화면", "records": "기록",
       "tools": "도구", "scripts": "스크립트", "inputs": "입력"}


def main_repo_root(start=None):
    root = start or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dotgit = os.path.join(root, ".git")
    try:
        if os.path.isdir(dotgit):
            return root
        with open(dotgit, encoding="utf-8") as fh:
            line = fh.read()
        if line.startswith("gitdir:"):
            gitdir = os.path.abspath(os.path.join(root, line.split(":", 1)[1].strip()))
            norm = gitdir.replace("\\", "/")
            idx = norm.rfind("/.git/worktrees/")
            if idx >= 0:
                return gitdir[:idx]
    except OSError:
        pass
    return root


TEST_ROOT = os.path.abspath(os.environ["AF_TEST_ROOT"]) if os.environ.get("AF_TEST_ROOT") \
    else os.path.join(main_repo_root(), "_local", "테스트")


def test_dir(sub, *rest):
    """하위 폴더 경로(만들어 둔다)."""
    p = os.path.join(TEST_ROOT, SUB[sub], *rest)
    os.makedirs(p, exist_ok=True)
    return p
