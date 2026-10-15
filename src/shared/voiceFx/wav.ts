/** WAV 만들기 — 16비트 PCM(리미터 뒤라 −1dBTP 이하). 채널은 섞어 쓴다(interleave). */
export function encodeWav16 (channels: Float32Array[], sampleRate: number): Uint8Array {
  const ch = channels.length, n = channels[0]?.length ?? 0
  const data = n * ch * 2
  const buf = new ArrayBuffer(44 + data)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, data, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      v.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true); o += 2
    }
  }
  return new Uint8Array(buf)
}
