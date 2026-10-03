/**
 * 파형(wavesurfer)에 소리를 넣는다 — **앱이 직접 받아** 넘긴다 (2026-10-03).
 *
 * ★왜: `ws.load(url)` 은 wavesurfer 가 스스로 내려받는다. 불러오는 중에 화면을 바꾸면 `ws.destroy()` 가 그 내려받기를 끊는데,
 *   wavesurfer 의 진행 읽기가 그 끊김을 오류로 받아 `console.warn('Progress tracking error: AbortError …')` 를 남겼다.
 *   **정상적인 불러오기 취소**가 경고로 찍힌 것이다(MCP 화면 검사 3회 중 3회 — 합성 카드를 만들고 곧바로 다른 작업실로).
 *   그리고 끊긴 불러오기의 실패가 `catch` 로 가 **새 파일 화면에 '파형을 읽지 못했습니다'** 를 세울 수 있었다(트랙 편집).
 * ★여기서는 취소 손잡이를 앱이 쥔다: 우리가 끊은 것은 'cancelled' 로 조용히 끝나고, 진짜 읽기 실패만 던진다.
 *   경고를 숨기는 것이 아니다 — 우리 쪽 취소는 애초에 wavesurfer 의 내려받기를 거치지 않는다.
 */
export type WaveLoadOutcome = 'loaded' | 'cancelled'

export async function loadWave(
  ws: { loadBlob: (blob: Blob) => Promise<unknown> },
  url: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<WaveLoadOutcome> {
  try {
    const res = await fetchFn(url, { signal })
    if (!res.ok) throw new Error(`소리를 받지 못했습니다(${res.status})`)
    const blob = await res.blob()
    if (signal.aborted) return 'cancelled'
    await ws.loadBlob(blob)
    return signal.aborted ? 'cancelled' : 'loaded'
  } catch (e) {
    if (signal.aborted || (e as { name?: string })?.name === 'AbortError') return 'cancelled'
    throw e
  }
}
