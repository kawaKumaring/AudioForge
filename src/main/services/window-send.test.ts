// window-send 회귀 — 파괴된 창으로의 전송이 예외를 던져 IPC 핸들러의 뒷정리를 날리지 않게.
// Electron 없이 구조적 fake로 검증.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendToWebContents, sendToWindow, createWindowSender } from './window-send.ts'

function makeWebContents(destroyed: boolean = false, throwOnSend: boolean = false) {
  const sent: { channel: string; args: unknown[] }[] = []
  return {
    sent,
    wc: {
      isDestroyed: () => destroyed,
      send: (channel: string, ...args: unknown[]) => {
        if (throwOnSend) throw new Error('Object has been destroyed')
        sent.push({ channel, args })
      }
    }
  }
}

test('살아있는 webContents → 전송하고 true', () => {
  const { wc, sent } = makeWebContents(false)
  assert.equal(sendToWebContents(wc, 'audio:track-error', { message: 'x' }), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channel, 'audio:track-error')
  assert.deepEqual(sent[0].args, [{ message: 'x' }])
})

test('파괴된 webContents → 전송 없음, false', () => {
  const { wc, sent } = makeWebContents(true)
  assert.equal(sendToWebContents(wc, 'audio:progress', { percent: 1 }), false)
  assert.equal(sent.length, 0)
})

test('null/undefined 대상 → false(throw 없음)', () => {
  assert.equal(sendToWebContents(null, 'c'), false)
  assert.equal(sendToWebContents(undefined, 'c'), false)
  assert.equal(sendToWindow(null, 'c'), false)
  assert.equal(sendToWindow(undefined, 'c'), false)
})

test('send가 throw해도 삼키고 false(검사 직후 파괴 레이스)', () => {
  const { wc } = makeWebContents(false, true)
  assert.equal(sendToWebContents(wc, 'audio:result', {}), false)
})

test('isDestroyed가 throw해도 삼키고 false', () => {
  const wc: any = { isDestroyed: () => { throw new Error('gone') }, send: () => { throw new Error('절대 도달 금지') } }
  assert.equal(sendToWebContents(wc, 'audio:result'), false)
})

test('isDestroyed가 없는 대상(구형 fake)도 전송된다', () => {
  const sent: string[] = []
  const wc: any = { send: (channel: string) => sent.push(channel) }
  assert.equal(sendToWebContents(wc, 'audio:progress'), true)
  assert.deepEqual(sent, ['audio:progress'])
})

test('send가 없는 대상 → false', () => {
  assert.equal(sendToWebContents({} as any, 'c'), false)
})

test('창 파괴 → webContents를 건드리지 않고 false', () => {
  const { wc, sent } = makeWebContents(false)
  let touched = 0
  const win: any = {
    isDestroyed: () => true,
    get webContents() { touched++; return wc }
  }
  assert.equal(sendToWindow(win, 'audio:cancelled'), false)
  assert.equal(sent.length, 0)
  assert.equal(touched, 0, '파괴된 창의 webContents는 접근조차 하지 않는다')
})

test('살아있는 창 → webContents로 전송하고 true', () => {
  const { wc, sent } = makeWebContents(false)
  const win = { isDestroyed: () => false, webContents: wc }
  assert.equal(sendToWindow(win, 'audio:track-result', { tracks: [] }), true)
  assert.equal(sent.length, 1)
})

test('창은 살아있지만 webContents가 파괴 → false', () => {
  const { wc, sent } = makeWebContents(true)
  const win = { isDestroyed: () => false, webContents: wc }
  assert.equal(sendToWindow(win, 'audio:progress'), false)
  assert.equal(sent.length, 0)
})

test('createWindowSender: 창 고정 전송기', () => {
  const { wc, sent } = makeWebContents(false)
  const send = createWindowSender({ isDestroyed: () => false, webContents: wc })
  assert.equal(send('audio:progress', { percent: 10 }), true)
  assert.equal(send('audio:result', { a: 1 }), true)
  assert.equal(sent.length, 2)
})
