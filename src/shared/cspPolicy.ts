/**
 * 화면 보안 정책(CSP) — **한 곳에서 만든다.** 외부 전송 금지의 세 번째 겹이다(`offlinePolicy.ts`).
 *
 * ★바깥 주소로의 연결·불러오기를 막는다. 허락하는 것은 앱 자신(self·file·local-file)과
 *   이 컴퓨터 안(localhost — 개발 서버의 화면 다시 불러오기)뿐이다.
 * ★file: 을 함께 적는다 — 배포 빌드는 file:// 로 열리고, 크롬에서 self 가 file: 을 덮는지는 판에 따라 다르다.
 * ★검사로 띄운 앱(AF_E2E=1)만 eval 을 허락한다 — 검사 도구(Playwright)가 조건식을 화면 안에서
 *   new Function 으로 만든다. 검사 도구의 우회(bypassCSP)는 창이 처음 뜰 때와 경주해 들쭉날쭉했다(실측).
 *   **바깥 연결 차단은 검사와 제품이 같다** — 달라지는 것은 eval 한 가지뿐이다.
 */
export function rendererCsp(opts: { e2e?: boolean } = {}): string {
  const script = ["'self'", 'file:', "'unsafe-inline'", ...(opts.e2e ? ["'unsafe-eval'"] : [])].join(' ')
  return [
    "default-src 'self' file:",
    `script-src ${script}`,
    "style-src 'self' file: 'unsafe-inline'",
    "img-src 'self' data: blob: file: local-file:",
    "media-src 'self' data: blob: file: local-file:",
    "font-src 'self' data: file:",
    "connect-src 'self' data: blob: file: local-file: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ')
}

/**
 * 화면이 뜨는 첫 순간에 정책을 건다(`main.tsx` 맨 앞). 넣은 뒤의 모든 불러오기·연결에 걸린다.
 * 이미 있으면 다시 넣지 않는다.
 */
export function applyRendererCsp(doc: Document, e2e: boolean): void {
  if (doc.querySelector('meta[http-equiv="Content-Security-Policy"]')) return
  const m = doc.createElement('meta')
  m.httpEquiv = 'Content-Security-Policy'
  m.content = rendererCsp({ e2e })
  doc.head.prepend(m)
}
