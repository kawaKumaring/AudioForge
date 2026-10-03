import { nativeImage } from 'electron'
import { stat, mkdir, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { createHash } from 'crypto'

/** 사용자가 고른 표지는 작은 사본으로 보관한다. 원본 파일은 바꾸지 않는다. */
export async function keepReaderCover(source: string, userData: string): Promise<string> {
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(source).toLowerCase())) throw new Error('PNG·JPG·WebP 이미지를 골라 주세요.')
  const file = await stat(source)
  if (!file.isFile() || file.size > 12 * 1024 * 1024) throw new Error('표지는 12MB 이하 이미지를 골라 주세요.')
  const img = nativeImage.createFromPath(source)
  if (img.isEmpty()) throw new Error('표지 이미지를 읽지 못했습니다.')
  const size = img.getSize()
  const scaled = Math.max(size.width, size.height) > 640 ? img.resize(size.width >= size.height ? { width: 640 } : { height: 640 }) : img
  const bytes = scaled.toJPEG(85)
  const folder = join(userData, 'readerCovers')
  await mkdir(folder, { recursive: true })
  const path = join(folder, createHash('sha256').update(bytes).digest('hex') + '.jpg')
  await writeFile(path, bytes)
  return path
}
