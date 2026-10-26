"""Qwen 참조 재사용의 내용 지문. 파일 전체를 메모리에 올리지 않는다."""
import hashlib
import os


def reference_digest(path):
    """읽는 동안 바뀐 파일은 재사용 근거로 삼지 않는다. 지문은 메모리에만 둔다."""
    # Windows Python 3.12의 handle/path ctime 의미가 달라 비교에서 제외한다.
    def stamp(st):
        return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        before = stamp(os.fstat(stream.fileno()))
        for block in iter(lambda: stream.read(256 * 1024), b""):
            h.update(block)
        after = stamp(os.fstat(stream.fileno()))
    if before != after or after != stamp(os.stat(path)):
        raise RuntimeError("참조 파일이 준비 중 변경됐습니다. 다시 시도하세요.")
    return h.hexdigest()
