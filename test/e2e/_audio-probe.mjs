// 재생을 **실제로 일어나는 자리에서** 엿본다.
//
// ★왜 생겼나 (2026-09-28 실측)
//   화면들이 저마다 오디오 요소를 들던 것을 2026-09-27 에 **공용 파형 하나**로 모았다
//   (지시: "소리는 한 번에 한 곳만"). 그런데 그 파형은 WaveSurfer 의 **Web Audio**
//   백엔드를 쓴다 — `HTMLMediaElement` 를 전혀 만들지 않는다.
//
//   검사들은 여전히 `HTMLMediaElement.prototype.currentTime` 을 엿보고 있었다.
//   그래서 **재생이 멀쩡히 되는데도** 아무것도 안 보여 실패로 나왔다.
//   검사를 지우거나 느슨하게 하는 대신, **겨누는 자리를 사실에 맞춘다.**
//
// Web Audio 는 `AudioBufferSourceNode.start(when, offset)` 으로 소리를 낸다.
// `offset` 이 곧 "어느 시각부터 트는가" 이고, `stop()` 이 멈춤이다.
// 옛 자리(HTMLMediaElement)도 함께 본다 — 아직 그쪽을 쓰는 화면이 있을 수 있다.

/** 페이지에 심는다. 누르기 **전에** 불러야 한다. */
export const installAudioProbe = `() => {
  window.__seeks = []      // 어느 시각으로 옮겼나 (두 갈래 합친 것)
  window.__plays = []      // 재생을 시작한 횟수
  window.__pauses = 0      // 멈춘 횟수

  // ── 옛 자리: HTMLMediaElement ─────────────────────────────────────────
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    get() { return d.get.call(this) },
    set(v) { window.__seeks.push(v); return d.set.call(this, v) },
  })
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (...a) { window.__plays.push('media'); return play.apply(this, a) }
  const pause = HTMLMediaElement.prototype.pause
  HTMLMediaElement.prototype.pause = function (...a) { window.__pauses += 1; return pause.apply(this, a) }

  // ── 지금 자리: Web Audio ──────────────────────────────────────────────
  //   start(when, offset) 의 **둘째 인자**가 시작 시각이다.
  if (typeof AudioBufferSourceNode !== 'undefined') {
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when, offset, ...rest) {
      if (typeof offset === 'number') window.__seeks.push(offset)
      window.__plays.push('webaudio')
      return start.call(this, when, offset, ...rest)
    }
    const stop = AudioBufferSourceNode.prototype.stop
    AudioBufferSourceNode.prototype.stop = function (...a) {
      window.__pauses += 1
      // 이미 멈춘 노드를 다시 멈추면 브라우저가 던진다 — 검사가 거기서 죽지 않게 한다.
      try { return stop.apply(this, a) } catch { /* 이미 멈춤 */ }
    }
  }
}`

/**
 * 옮겨 간 시각들 중 `want` 와 맞는 것이 있는가.
 *
 * ★자로 잰 듯 같은 값을 요구하지 않는다. Web Audio 의 offset 은 버퍼 길이에 맞춰
 *   아주 조금 다듬어질 수 있다. 다만 **다른 문장과 헷갈릴 만큼 느슨하지는 않다**
 *   — 이 검사의 문장 간격은 2.5초다.
 */
export function seekedTo(seeks, want, tol = 0.25) {
  return (seeks || []).some((v) => typeof v === 'number' && Math.abs(v - want) <= tol)
}
