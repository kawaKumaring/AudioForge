# 노래 변환 결과 카드 연결 계약

구현: `src/renderer/components/SongResultCard.tsx`
검사: `test/e2e/song-result.component.mjs`
SongWorkspace.tsx 및 엔진·저장 코드는 이번 작업에서 변경하지 않았다.

## 연결

```tsx
<SongResultCard
  result={{ id: result.requestId, title: originalName,
    originalAudioPath: resultOriginalAudio, mixPath: resultMix }}
  disabled={busy}
  onSave={async snapshot => { /* 보호된 저장 IPC, 실패 시 throw */ }}
  onOpenFolder={async snapshot => { /* 해당 결과 폴더 열기, 실패 시 throw */ }}
/>
```

위 변수명은 연결 예시이며 실제 IPC 필드명이 아니다. 호스트에서 실제 결과 계약을 매핑할 것.

- id는 실행마다 유일한 요청 ID. 원본과 결과 경로도 실행 당시 스냅샷을 사용한다.
- originalAudioPath는 해당 원곡의 디코딩 가능한 오디오 경로. 영상 입력이면 추출한 오디오를 제공한다.
- mixPath는 반주와 변환 보컬을 합친 최종 음원. 화면 제목은 ‘변환 음원’이다.
- 콜백은 화면에서 전달한 snapshot을 사용한다. 현재 편집 중인 파일로 바꾸지 않는다.
- IPC가 `{ok:false}`를 반환하면 호스트가 오류로 처리해 throw해야 한다. 사용자가 저장 창을 취소한 것은 정상 반환한다.
- 컴포넌트는 파일 쓰기, 출력 보호, 변환 실행, 설정 저장을 하지 않는다.

## 동작

변환본 기본 선택 → 원곡/변환본 전환 → 현재 시간 유지.
재생 중 전환은 이전 플레이어를 폐기한 뒤 새 파일이 준비되면 이어 재생한다.
정지 중 전환은 자동 재생하지 않는다. 대상 길이가 짧으면 끝으로 제한하고 재생하지 않는다.
새 결과, 언마운트, disabled 변경 시 이전 재생을 정리한다. 늦은 파일 응답은 무시한다.
공용 재생 음량 구독과 기존 compact 재생 중복 방지 이벤트에 참여한다.
재생 버튼은 좌우 동일 폭의 가운데 열에 둔다.

‘같은 시간’은 파일의 절대 재생 시간이다. 두 파일의 앞부분 잘림/지연을 자동 추정하거나 보정하지 않는다.
엔진에서 원곡과 변환본의 시간 기준을 보존해야 한다. 곡 전체 파형 로딩의 메모리 비용은 실제 긴 곡으로 확인할 것.

## 검증

웹 타입 검사 통과. 실제 React 컴포넌트 + WaveSurfer 대역으로 8건 통과:
기본 변환본, 시간 유지/이전 재생 해제/공용 음량, disabled 정지, 새 결과와 늦은 응답,
저장/폴더 스냅샷, 저장 오류, 좁은 창, 런타임 오류.

실제 파일 디코딩·재생 청취·긴 곡 성능·전체 앱 연동은 미검증이다.
아직 SongWorkspace에 탑재되지 않았다. 클로드가 결과 계약에 맞춰 연결한 뒤 실제 파일로 검수한다.
