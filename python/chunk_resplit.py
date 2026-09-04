# -*- coding: utf-8 -*-
"""상한 도달 chunk 의 1회 재분할 뒤 번호 매기기 — 순수 함수.

부모(tts_worker)는 segment 마다 chunk_index 가 0..cc-1 로 빈틈없고 모든 항목의 chunk_count 가 같기를 요구한다.
재분할로 조각이 k 개가 되면 그 segment 의 뒤 항목은 k-1 만큼 밀리고, 이미 끝난 항목까지 chunk_count 가 k-1 만큼
는다. 화자·감정·참조는 원래 항목(seg)을 그대로 상속한다 — 텍스트만 바뀐다.
"""


def renumber_after_resplit(done, queue, seg_index, chunk_index, pieces):
    """done: 끝난 항목(dict, original_segment_index/chunk_index/chunk_count) 리스트(제자리 갱신).
    queue: 아직 남은 plan 항목(dict, seg/chunk_index/chunk_count/text) 리스트(제자리 갱신).
    seg_index/chunk_index: 상한에 도달한 항목. pieces: 그 텍스트의 재분할 조각(2개 이상).
    반환: queue 앞에 넣을 새 plan 항목 리스트(같은 seg 상속, chunk_index 는 chunk_index.. 연속).
    """
    if len(pieces) < 2:
        raise ValueError("pieces must be >= 2")
    grow = len(pieces) - 1
    template_seg = None
    for it in queue:
        if int(it["seg"]["index"]) == int(seg_index):
            template_seg = it["seg"]
            if int(it["chunk_index"]) > int(chunk_index):
                it["chunk_index"] = int(it["chunk_index"]) + grow
            it["chunk_count"] = int(it["chunk_count"]) + grow
    for d in done:
        if int(d["original_segment_index"]) == int(seg_index):
            d["chunk_count"] = int(d["chunk_count"]) + grow
    return grow


def make_pieces(seg, chunk_index, chunk_count_after, pieces, resplit_of=None):
    """재분할 조각을 plan 항목으로. seg(화자·감정·참조·prefix 포함)를 그대로 상속한다."""
    out = []
    for i, txt in enumerate(pieces):
        out.append({"seg": seg, "chunk_index": int(chunk_index) + i, "chunk_count": int(chunk_count_after),
                    "text": txt, "resplit_of": resplit_of if resplit_of is not None else int(chunk_index)})
    return out
