import { useState } from 'react'
import App from '../App'

/** A separate, UI-only entrance. Opening the studio never starts processing. */
export default function AppEntrance() {
  const [entered, setEntered] = useState(false)
  if (entered) return <App />
  return <div data-testid="audioforge-welcome" style={{ height: '100%', overflowY: 'auto', color: '#eef3fa', background: 'radial-gradient(ellipse at 75% 45%, #203449 0%, transparent 60%), #101319' }}>
    <header className="titlebar-drag" style={{ display: 'flex', alignItems: 'center', gap: 12, height: 64, padding: '0 28px', borderBottom: '1px solid #ffffff10' }}>
      <img src="./audioforge-character.png" width={40} height={40} alt="" />
      <div><strong style={{ fontSize: 19 }}>AudioForge</strong><div style={{ fontSize: 10, letterSpacing: '.18em', color: '#9aafc2' }}>PERSONAL SOUND STUDIO</div></div>
    </header>
    <main style={{ minHeight: 'calc(100% - 64px)', maxWidth: 1240, margin: '0 auto', padding: '44px clamp(24px, 5vw, 68px)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 48 }}>
      <section style={{ flex: '1 1 320px', maxWidth: 490 }}>
        <h1 style={{ fontSize: 'clamp(34px, 4vw, 51px)', letterSpacing: '-.045em', lineHeight: 1.3, marginBottom: 25 }}>당신의 소리에,<br /><span style={{ color: '#9bd6ef' }}>새로운 가능성을.</span></h1>
        <p style={{ fontSize: 15, lineHeight: 1.95, color: '#b3bfcd', wordBreak: 'keep-all', marginBottom: 30 }}>음악과 대화를 분리하고, 말을 글로 옮기고,<br />목소리로 이야기를 만드세요.<br />소리를 다루는 나만의 작업실, AudioForge.</p>
        <div style={{ display: 'flex', gap: 15, flexWrap: 'wrap', fontSize: 12, color: '#8da5bc', marginBottom: 32 }}><span>음악 · 대화 분리</span><span>받아쓰기</span><span>음성 작업</span></div>
        <button autoFocus type="button" data-testid="welcome-start" onClick={() => setEntered(true)} style={{ width: '100%', textAlign: 'left', padding: '22px 25px', border: '1px solid #658ca4', borderRadius: 12, background: '#284c64', color: '#f3faff', fontSize: 17, fontWeight: 600, cursor: 'pointer', boxShadow: '0 12px 35px #0003' }}>작업실 시작하기 <span aria-hidden="true" style={{ float: 'right' }}>→</span></button>
        <p style={{ marginTop: 17, color: '#94a1b3', fontSize: 12, lineHeight: 1.7 }}>파일 선택과 드래그 불러오기는 작업실에서 이용합니다.<br />시작 버튼만으로 음원 처리나 생성이 실행되지는 않습니다.</p>
      </section>
      <figure style={{ flex: '1 1 320px', maxWidth: 460, margin: 0, padding: 22, borderRadius: 30, border: '1px solid #ffffff14', background: 'linear-gradient(145deg,#ffffff08,#ffffff02)', boxShadow: '0 30px 70px #0004' }}>
        <img data-testid="welcome-character" src="./audioforge-character.png" alt="마이크를 들고 노래하는 하늘색 묶음 머리 캐릭터와 오디오 파형" style={{ display: 'block', width: '100%', height: 'auto' }} />
        <figcaption style={{ padding: '20px 6px 3px', fontSize: 12, color: '#b2c2d0' }}>작은 목소리에서 시작되는, 새로운 이야기.</figcaption>
      </figure>
    </main>
  </div>
}
