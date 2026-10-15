import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [react(), tailwindcss()],
    // 음성 처리 실시간 모듈(AudioWorklet)은 모듈 형식으로 묶는다 — 기본(iife)은 import.meta.url 을
    // self.location 으로 바꾸는데, AudioWorklet 안에는 self.location 이 없어 등록 전에 멈춘다(2026-10-16 실측).
    worker: { format: 'es' }
  }
})
