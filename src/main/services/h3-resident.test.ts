import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

test('H3 실행 소유권 보호·종료 확인·다음 실행 재시작',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const req=createRequire(import.meta.url),Module=req('node:module'),procs:any[]=[]
  const fakeSpawn=()=>{
    const p:any=new EventEmitter();p.exitCode=null;p.signalCode=null
    p.stdout=new EventEmitter();p.stdout.setEncoding=()=>{}
    p.stderr=new EventEmitter();p.stdin=new EventEmitter();p.stdin.end=()=>{}
    p.kill=()=>{p.killRequested=true;return true};procs.push(p);return p
  }
  const source=buildSync({entryPoints:[new URL('./h3-resident.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
  const mod=new Module(import.meta.filename);mod.paths=(Module as any)._nodeModulePaths(import.meta.dirname)
  mod.require=(id:string)=>id==='child_process'?{...req(id),spawn:fakeSpawn}:id==='fs'?{...req(id),existsSync:()=>true}:req(id)
  mod._compile(source,import.meta.filename)
  const api=mod.exports;let owned=true
  const ready=api.ensureH3Resident('python','server',()=>owned)
  procs[0].stdout.emit('data','{"ready":true}\n');assert.equal(await ready,true)
  assert.equal(await api.yieldIdleH3(),false,'파이프에 아직 붙지 않은 실행도 미리 준비가 끊으면 안 된다')
  owned=false
  procs[0].stdout.emit('data','{"activity":true,"pipe_busy":true}\n')
  const busy=api.yieldIdleH3();t.mock.timers.tick(0);assert.equal(await busy,false)
  const stopped=api.stopH3Resident('검사');let done=false;stopped.then(()=>done=true)
  await Promise.resolve();assert.equal(done,false,'kill 호출만으로 종료 완료라고 하면 안 된다')
  assert.equal(procs[0].killRequested,true)
  procs[0].exitCode=0;procs[0].emit('exit',0);procs[0].emit('close',0)
  assert.equal(await stopped,true);assert.equal(api.h3Running(),false)
  const next=api.ensureH3Resident('python','server',()=>false)
  procs[1].stdout.emit('data','{"ready":true}\n');assert.equal(await next,true)
  assert.equal(procs.length,2)
  const end=api.stopH3Resident('검사 마감');procs[1].exitCode=0;procs[1].emit('exit',0);procs[1].emit('close',0)
  assert.equal(await end,true);t.mock.timers.tick(30000)
})
