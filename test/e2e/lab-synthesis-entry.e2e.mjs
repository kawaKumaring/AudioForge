// 기존 npm run test:e2e:lab-entry 진입점을 유지한다.
// 일반/고급 및 빈 테스트개발 탭을 정답으로 삼던 검사는 새 작업 흐름 계약으로 대체했다.
// 실제 Electron · 사용자 데이터 격리 · 모델/음성 생성 없음.
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import './ux-workflow.e2e.mjs'
