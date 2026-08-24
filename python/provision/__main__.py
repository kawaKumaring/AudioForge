# -*- coding: utf-8 -*-
"""provision 패키지 실행 진입점 — `python -m provision --config <json>`.

Electron(Agent Q)이 subprocess로 이 모듈을 호출한다. 실제 로직은 provision.cli(얇은 어댑터)에 있고,
그 어댑터는 P의 pure core(state/default_manifest/fingerprint)만 소비한다. 여기서는 인자 파싱·경로
배선을 cli.main에 위임할 뿐이다. plan/verify는 순수 stdlib(부작용 0).
"""

import sys

from provision.cli import main

if __name__ == "__main__":
    sys.exit(main())
