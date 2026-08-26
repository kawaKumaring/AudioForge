# Narakeet 음성 샘플 및 서비스 분석

조사일: 2026-08-26

대상: 사용자 제공 `서울의 봄날 아침 벚꽃잎이 바람에 흩.mp3`

방법: 파일을 재생하거나 변경하지 않고 디코딩된 모노 파형을 20 ms 프레임·10 ms hop으로 측정

## 1. 파일 무결성·전체 특성

| 항목 | 측정값 |
| --- | ---: |
| SHA-256 | `6158a1cb911515cb3dbc4277a9e09e87e5ee341856a0d9adf6f9cf27dde0201d` |
| 크기 | 399,213 bytes |
| 포맷 | MP3 / MPEG Layer III |
| 샘플레이트·채널 | 48,000 Hz / mono |
| 길이 | 16.575 s |
| 전체 RMS | -19.109 dBFS |
| peak | -4.258 dBFS |
| crest factor | 14.851 dB |
| clipping ratio (`|x| >= 0.999`) | 0.0 |
| DC offset | 0.0000044 |

`[M]` 클리핑과 의미 있는 DC 편향은 관측되지 않았다. 여유 peak와 높은 crest factor는 강제 리미팅으로 평평하게 누른 파일이 아니라는 신호다. 다만 MP3 자체의 손실 압축 영향을 포함한다.

## 2. 시작음·끝음

| 구간 | 결과 |
| --- | --- |
| 파일 시작 0–20 ms | RMS -120 dBFS, 첫 sample·첫 sample jump 0 |
| 첫 활동 시작 | 약 0.150 s |
| 첫 300 ms 활동 RMS | -15.735 dBFS |
| 마지막 활동 종료 | 약 15.710 s |
| 후행 무음 | 약 0.865 s |
| 마지막 500 ms | 디코딩 파형 0 |

`[M]` 파일의 시작과 끝은 모두 0에 가까운 무음에서 출발·종료한다. 따라서 파일 경계 자체에는 hard cut click을 만들 만한 sample jump가 없다. 첫 활동은 충분한 150 ms pre-roll 뒤 시작하고 끝에는 865 ms post-roll이 있다.

`[I]` 이 특성은 AudioForge에서 보고된 “조각마다 첫 음색이 튄다”는 문제와 다르다. Narakeet 샘플은 최소한 파일 전체 시작을 안정된 무음으로 감싸지만, 이것만으로 내부 합성 조각이 없었다거나 모든 내부 경계가 연속적이었다고 증명할 수는 없다.

## 3. 휴지 구조

보수적인 -45 dBFS 활동 기준에서 80 ms 이상 비활동 구간을 측정했다.

- `[M]` 약 1.02 s 완전 무음: 4.78–5.80 s
- `[M]` 약 1.01 s 완전 무음: 11.33–12.34 s
- `[M]` 그 밖의 주요 휴지: 약 0.37 s, 0.44 s
- `[M]` 80–170 ms의 짧은 비활동도 여러 곳 존재

`[I]` 두 1초 구간은 문장군/문단 사이의 의도된 휴지와 일치하는 모양이다. 짧은 휴지는 발음 내부의 무성음도 분리할 수 있으므로 합성 chunk 경계로 해석해서는 안 된다. 서비스 내부 분할 위치를 확인하려면 동일 문장의 speech mark 또는 생성 메타데이터가 필요하다.

## 4. Narakeet에서 공식적으로 확인되는 구조

- `[F]` Narakeet은 단일 공개 모델이 아니라 AWS Polly, Google Cloud TTS, IBM Watson, Microsoft Azure, CereProc, Unreal Speech, Rime 등 여러 TTS 제공자를 통합한다. [Narakeet data security](https://www.narakeet.com/docs/data-security/)
- `[F]` 음성 목록 API는 음성별 지원 스타일을 제공하며, 사용 가능한 기능이 음성마다 다를 수 있다. [Listing voices API](https://www.narakeet.com/docs/automating/listing-voices-api/)
- `[F]` 짧은 스트리밍 합성과 긴 작업용 비동기/polling 경로를 분리한다. [Text-to-speech API](https://www.narakeet.com/docs/automating/text-to-speech-api/)
- `[F]` `voice-speed`, `voice-pitch`, `voice-volume`, `voice-emphasis`, pause 계열 지시와 `narration-mode: fragment`를 문서화한다. fragment 모드는 한 문장을 여러 블록으로 나눌 때 더 작은 간격으로 연결하기 위한 기능이다. [Narakeet format](https://www.narakeet.com/docs/format/), [pause control](https://www.narakeet.com/docs/how-to/add-pauses-to-text-to-speech-voiceovers.html)
- `[F]` 신경망 음성은 주변 텍스트의 문맥을 이용하므로, 문단 단위 문맥 유지와 선택 영역 미리듣기를 권장한다. [Test text to speech](https://www.narakeet.com/docs/how-to/test-text-to-speech.html)

## 5. 자연스러움에 대한 해석

`[I]` 이 샘플의 자연스러움은 하나의 비공개 Narakeet 모델 기법이라기보다 다음 조합에서 나올 가능성이 높다.

1. 검증된 상용 TTS 제공자·음성을 선택하는 라우팅
2. 짧은 발화마다 재시작하지 않고 문단 문맥을 제공하는 합성
3. 음성별로 지원하는 강조·속도·pitch 기능만 적용하는 capability 처리
4. 문장/문단 휴지를 명시적으로 제어하는 script 계층
5. 긴 작업을 별도로 조율하는 job 경로

이는 공식 문서와 파형의 정합적 해석이지, Narakeet의 비공개 모델 구조에 대한 사실 주장이 아니다.

## 6. AudioForge 비교 실험에 사용할 기준

`[R]` 같은 한국어 대사·같은 목표 길이로 AudioForge 후보를 만든 뒤 다음을 비교한다.

- 첫 유성음 전 pre-roll 및 첫 300 ms의 RMS/F0/speaker embedding 변화
- 문장 내부 자동분할 경계의 무음 길이, sample jump, 스펙트럼 변화
- 문단 휴지와 문장 휴지 분포
- 전체 clipping·loudness 및 마지막 500 ms tail
- 사용자 블라인드 청취: 시작음 안정성, 화자 일관성, 문장 간 연결감, 감정 전환 자연스러움

Narakeet 파일만으로 AudioForge의 최적 threshold나 fade 값을 복사하지 않는다.
