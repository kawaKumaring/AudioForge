import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { useAppStore } from '@/stores/app.store'
import { planEmotionRefs } from '@/lib/emotions'
import './styles/globals.css'

// E2E 전용(AF_E2E=1): 자동화가 store를 통해 파일/모드/상태를 주입할 수 있게 노출. 그 외엔 노출하지 않음.
if ((window as { api?: { _e2e?: boolean } }).api?._e2e) {
  ;(window as unknown as { __afStore: typeof useAppStore }).__afStore = useAppStore
  // 게이팅/전송 판정을 그대로(ProcessButton과 동일 로직) 검증할 수 있게 노출 — 실제 합성 없이 config 전달 확인.
  ;(window as unknown as { __afPlanEmotionRefs: (text: string) => unknown }).__afPlanEmotionRefs =
    (text: string) => planEmotionRefs(text, useAppStore.getState().ttsEmotionRefState)
}

// 진단: uncaught 오류/거부를 콘솔로 남겨 main console-message / E2E pageerror가 수집하게 한다.
window.addEventListener('error', (e) => {
  console.error('[renderer][window.error]', e.message, e.error?.stack || '', `${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer][unhandledrejection]', (e.reason as Error)?.stack || String(e.reason))
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
