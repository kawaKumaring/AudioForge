#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""provision_cli — Electron이 경로로 실행하는 provisioner 진입 스크립트(Agent Q, 얇은 어댑터).

`python -m provision`은 임베디드 Python(python_embeded, ._pth로 sys.path 고정)에서 동작하지 않으므로,
기존 separate.py와 동일하게 **경로로 실행되는 스크립트**가 sys.path를 스스로 보정한 뒤 provision.cli.main에
위임한다. 로직 재구현 0 — plan/verify state machine·DAG·manifest·fingerprint는 전부 P의 pure core 소유.

실행: python -X utf8 -B provision_cli.py --config <json>
plan/verify는 순수 stdlib다 — torch/모델/GPU/네트워크 불요, 파일 쓰기·다운로드·pip·venv 생성 0.
"""

import os
import sys

# cwd/HOME 추측 없이 이 파일 기준으로 python/ 디렉터리를 sys.path에 둔다(separate.py와 동일 관례).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from provision.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
