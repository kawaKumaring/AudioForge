# Tailwind CSS v4 레이아웃 버그 기록

## 현상

AudioForge 초기 개발 시, 모든 UI 요소가 **왼쪽 상단 모서리**에 몰려 표시됨.
- 드롭존 아이콘이 카드 왼쪽 밖으로 튀어나옴
- 콘텐츠가 화면 중앙에 오지 않음
- `mx-auto`, `text-center`, `items-center` 등 Tailwind 유틸리티가 의도대로 동작하지 않음

## 근본 원인: Tailwind CSS v4의 유틸리티 변경

### 1. `mx-auto` → `margin-inline: auto`

Tailwind v3에서는:
```css
.mx-auto { margin-left: auto; margin-right: auto; }
```

Tailwind v4에서는:
```css
.mx-auto { margin-inline: auto; }
```

`margin-inline`은 CSS Logical Properties로, **flex 자식 요소에서 예상대로 동작하지 않는 경우**가 있음.
특히 Electron(Chromium) 환경에서 flex 컨테이너 내부의 block-level 요소에 `margin-inline: auto`를 적용하면
중앙 정렬이 되지 않고 기본값(좌측 정렬)으로 fallback됨.

### 2. `text-center`의 한계

`text-center`는 `text-align: center`를 생성하지만, 이는 **inline/inline-block 자식**에만 적용됨.
`div` (block-level) 자식은 `text-align`의 영향을 받지 않음.

아이콘을 `<div class="mx-auto">` + 부모 `<div class="text-center">`로 중앙 정렬하려 했으나:
- `text-center` → block 자식에 무효
- `mx-auto` → `margin-inline: auto`가 flex 컨텍스트에서 무시됨
- 결과: 아이콘이 왼쪽 상단에 고정

### 3. `@layer` 우선순위 충돌

Tailwind v4는 모든 유틸리티를 `@layer utilities` 안에 생성함.
커스텀 CSS (`.glass-card`, `.gradient-border` 등)가 `@layer` 밖에 있으면
**Tailwind 유틸리티보다 높은 우선순위**를 가져 덮어쓸 수 있음.

특히 `.gradient-border`의 `background-clip: padding-box`가 내부 레이아웃에 영향을 줌.

## 해결 방법

**레이아웃 관련 스타일은 inline style로 직접 작성**, Tailwind는 장식용으로만 사용.

### Before (동작 안 함)
```tsx
<div className="flex flex-col items-center justify-center">
  <div className="mx-auto max-w-[640px] px-8">
    <div className="text-center">
      <div className="mx-auto h-20 w-20">아이콘</div>
      <p>텍스트</p>
    </div>
  </div>
</div>
```

### After (정상 동작)
```tsx
<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
  <div style={{ maxWidth: '520px', width: '100%', margin: '0 auto', padding: '0 32px' }}>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '72px', height: '72px' }}>아이콘</div>
      <p>텍스트</p>
    </div>
  </div>
</div>
```

## 규칙

| 용도 | 방식 |
|------|------|
| 중앙 정렬, flex 배치, 위치 | **inline style** |
| 너비, 높이, 패딩, 마진 | **inline style** |
| 색상, 배경, 폰트, 테두리 | Tailwind 유틸리티 또는 CSS 변수 |
| 애니메이션, 트랜지션 | Tailwind 또는 framer-motion |
| glass-card, glow 등 장식 | CSS 클래스 |

## 환경

- Tailwind CSS v4.0.0 (`@tailwindcss/vite`)
- electron-vite 3.0.0
- Electron 34.2.0 (Chromium)
- `@import 'tailwindcss'` (v4 방식)

## 참고

이 문제는 Tailwind v4 + Electron 조합에서 발생. 일반 브라우저에서는 재현되지 않을 수 있음.
Tailwind v3로 다운그레이드하면 해결되지만, 프로젝트 통일성을 위해 v4를 유지하되
레이아웃은 inline style로 처리하는 방식을 채택.
