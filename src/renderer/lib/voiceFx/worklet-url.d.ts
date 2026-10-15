// Vite 가 '?worker&url' 로 묶은 실시간 처리 모듈의 주소(문자열).
declare module '*?worker&url' {
  const url: string
  export default url
}
