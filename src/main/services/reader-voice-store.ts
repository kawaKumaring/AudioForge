/**
 * 낭독 — 구간을 잘라 쓴 **내 목소리**를 앱이 관리하는 자리에 보관한다(2026-10-03).
 *
 * ★왜: 준비가 자른 조각은 임시 자리(`userData/refclips/audioforge_refclip_*`)에 생긴다. 그 자리는 앱을 켤 때·끌 때,
 *   그리고 다음 준비 때 치운다(임시 파일 청소 — 끄지 않는다). 그런데 낭독은 그 **임시 경로**를 고른 목소리로 저장해,
 *   다시 켜면 '내 목소리 파일을 찾지 못했습니다' 로 막혔다(실제 앱 재현).
 * ★두 방법을 견줘 이것을 골랐다
 *   · 원본 + 고른 구간을 저장해 켤 때마다 다시 준비 — 원본을 옮기거나 고치면 깨지고, 켤 때마다 분석을 다시 돌리며,
 *     분석이 다른 구간을 고르면 목소리가 바뀐다.
 *   · **조각 자체를 보관(여기)** — 전에 쓰던 바로 그 소리를 곧바로 쓴다. 대가는 목소리 하나에 수백 KB.
 * ★쓰는 것만 남긴다 — 고른 목소리와 최근 목소리가 가리키는 것 밖의 보관본은 지운다(사용자 원본은 건드리지 않는다).
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'

/** p 가 dir 안에 있는가(같은 자리·바깥·다른 드라이브는 아니다). */
export function insideDir(dir: string, p: string): boolean {
  const r = relative(resolve(dir), resolve(p))
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

const sameFile = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * 임시 조각을 보관 자리로 옮겨 적고 그 경로를 돌려준다. 같은 소리는 한 벌만(내용 지문 이름).
 * @param keep 남길 보관본(고른 목소리·최근 목소리의 경로). 새 보관본은 늘 남는다.
 */
export function keepVoiceClip(src: string, o: { tempRoot: string; storeDir: string; keep: readonly string[] }): string {
  // ★준비가 만든 조각만 받는다 — 화면이 아무 파일이나 앱 자리로 복사시키지 못하게.
  if (!insideDir(o.tempRoot, src)) throw new Error('준비한 목소리 조각이 아닙니다')
  if (!statSync(src).isFile()) throw new Error('준비한 목소리 조각이 없습니다')
  const bytes = readFileSync(src)
  mkdirSync(o.storeDir, { recursive: true })
  const dest = join(o.storeDir, createHash('sha256').update(bytes).digest('hex').slice(0, 24) + '.wav')
  if (!existsSync(dest)) {
    const part = dest + '.part'
    writeFileSync(part, bytes)
    renameSync(part, dest)        // 반쯤 쓴 파일을 보관본으로 남기지 않는다
  }
  pruneVoiceStore(o.storeDir, [...o.keep, dest])
  return dest
}

/** 남길 것 밖의 보관본(과 쓰다 만 .part)을 지운다. 지운 개수. */
export function pruneVoiceStore(storeDir: string, keep: readonly string[]): number {
  let names: string[]
  try { names = readdirSync(storeDir) } catch { return 0 }
  let removed = 0
  for (const n of names) {
    if (!/\.wav(\.part)?$/i.test(n)) continue
    const p = join(storeDir, n)
    if (!n.endsWith('.part') && keep.some((k) => k && sameFile(k, p))) continue
    try { rmSync(p, { force: true }); removed++ } catch { /* 다음에 다시 */ }
  }
  return removed
}
