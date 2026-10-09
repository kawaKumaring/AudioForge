'use strict'
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('node:assert/strict')
const {McpClient}=require('../../tools/mcp/client.cjs')
const ROOT=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync(path.join(ROOT,'_local/tmp/quality-evidence-'))
const file=path.join(dir,'step.wav'),b=Buffer.alloc(44+24000*4)
b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(12000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40)
for(let i=0;i<24000;i++){const v=i<12000?3277:6554;b.writeInt16LE(v,44+i*4);b.writeInt16LE(-v,46+i*4)}fs.writeFileSync(file,b)
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),sourceHash=hash(file)
const meta=path.join(dir,'context.json'),doc={schema:'audioforge-quality-context/v1',sourceSha256:sourceHash,reference:{sha256:'a'.repeat(64),start:3,end:11,selectionReason:'test only'},joins:[{time:1}]}
fs.writeFileSync(meta,JSON.stringify(doc))
;(async()=>{let count=0;const c=new McpClient();await c.start();const ok=(v,label)=>{assert.ok(v,label);count++;console.log('PASS',label)},call=async(n,a)=>{const v=await c.call('audio_quality_'+n,a);assert.equal(v.isError,false,v.text);return v};try{
 const r=(await call('analyze',{path:file,records:[meta]})).json,reportId=r.reportId
 const context=(await call('context',{reportId})).json.items;ok(context[0].sourceLinked&&context[0].recordCurrent,'context linked to exact output hash');ok(context[0].reference.start===3&&!context[0].reference.audioVerified,'reference assertion not treated as verified audio')
 const boundary=context.find(x=>x.kind==='boundary');ok(boundary.time===1,'recorded join retained');ok(!(await call('context',{reportId,referenceReportId:reportId})).json.items[0].reference.fileHashVerified,'wrong reference hash not verified')
 const measured=(await call('boundary',{reportId,boundaryId:boundary.boundaryId})).json;ok(Math.abs(measured.channels[0].deltaRmsDb-6.0206)<.001,'boundary RMS measured on samples');ok(Math.abs(measured.channels[0].sampleStep-3277/32768)<1e-7&&measured.channels[1].sampleStep<0,'boundary keeps channel phase and exact step')
 ok((await c.call('audio_quality_boundary',{reportId,boundaryId:'invented'})).isError,'invented join rejected')
 ok((await c.call('audio_quality_boundary',{reportId,boundaryId:boundary.boundaryId,window:2})).isError,'boundary window outside report rejected')
 const noAsr=await c.call('audio_quality_sentences',{reportId});ok(noAsr.isError&&noAsr.text.includes('실제 ASR'),'no ASR is not a transcript pass or import error')
 const e=await call('evidence',{reportId,start:.8,end:1.2});ok(e.images.length===1&&e.json.clip.frames===4800&&fs.existsSync(e.json.bundlePath),'evidence includes image exact range audio and manifest')
 const saved=JSON.parse(fs.readFileSync(e.json.bundlePath,'utf8'));ok(saved.plot&&fs.existsSync(saved.plot.image)&&saved.plot.sha256===hash(saved.plot.image)&&saved.plot.render&&saved.plot.render.normalized===false,'saved evidence keeps plot path hash and render conditions');const{bundlePath:_bp,...returned}=e.json;ok(JSON.stringify(returned)===JSON.stringify(saved),'saved evidence equals MCP response')
 const base={reportId,action:'append',start:.8,end:1.2,category:'join',verdict:'uncertain',basis:'machine_observation',observer:'automated fixture',note:'test sample step'}
 ok((await c.call('audio_quality_review',{...base,verdict:'confirmed'})).isError,'machine observation cannot confirm listening defect')
 ok((await c.call('audio_quality_review',{...base,basis:'user_report'})).isError,'human attribution requires original statement')
 const priorCount=(await call('review',{reportId,action:'list'})).json.total;const first=(await call('review',base)).json
 const second=(await call('review',{...base,replaces:first.id,note:'test correction remains uncertain'})).json
 const listed=(await call('review',{reportId,action:'list',limit:1})).json;ok(listed.total===priorCount+2&&listed.nextOffset===1,'reviews append and paginate');ok(second.replaces===first.id,'correction references preserved older entry')
 ok((await c.call('audio_quality_review',{...base,replaces:'missing'})).isError,'unknown correction target rejected')
 ok((await c.call('audio_quality_review',{...base,end:3})).isError,'review out of range rejected')
 fs.writeFileSync(meta,JSON.stringify({...doc,reference:{...doc.reference,sha256:sourceHash}}));const linked=(await call('analyze',{path:file,records:[meta]})).json;ok((await call('context',{reportId:linked.reportId,referenceReportId:reportId})).json.items[0].reference.fileHashVerified,'matching actual reference report verified by hash');fs.writeFileSync(meta,JSON.stringify({...doc,sourceSha256:'0'.repeat(64)}));ok(!(await call('context',{reportId})).json.items[0].recordCurrent,'changed context flagged');ok((await c.call('audio_quality_boundary',{reportId,boundaryId:boundary.boundaryId})).isError,'changed context blocked for fresh measurements')
 const foreign=(await call('analyze',{path:file,records:[meta]})).json;const unbound=(await call('context',{reportId:foreign.reportId})).json.items;ok(!unbound[0].sourceLinked&&!unbound.some(x=>x.kind==='boundary'),'foreign source cannot supply boundaries')
 const noRecord=(await call('analyze',{path:file})).json;ok((await call('context',{reportId:noRecord.reportId})).json.items[0].kind==='unavailable','missing coordinates explicit not inferred')
 fs.writeFileSync(meta,JSON.stringify({...doc,joins:[{time:1},{time:.5}]}));const bad=(await call('analyze',{path:file,records:[meta]})).json;ok((await c.call('audio_quality_context',{reportId:bad.reportId})).isError,'out of order joins rejected')
 fs.writeFileSync(meta,JSON.stringify({...doc,conditions:{seed:42}}));const seeded=(await call('context',{reportId:(await call('analyze',{path:file,records:[meta]})).json.reportId})).json.items[0];fs.writeFileSync(meta,JSON.stringify({...doc,conditions:{}}));const unseeded=(await call('context',{reportId:(await call('analyze',{path:file,records:[meta]})).json.reportId})).json.items[0];ok(seeded.seed===42&&seeded.seedRecorded==='number'&&unseeded.seed===null&&unseeded.seedRecorded==='absent','numeric seed kept with type and distinguished from missing')
 ok(hash(file)===sourceHash,'all source bytes preserved')
 fs.appendFileSync(file,Buffer.from([0,0]));ok((await c.call('audio_quality_review',base)).isError,'changed source blocks new verdict');ok(!(await call('review',{reportId,action:'list'})).json.sourceCurrent,'historical reviews remain accessible as stale')
 console.log('RESULT',count,'checks, 0 fail')
 }finally{await c.close()}})().catch(e=>{console.error(e);process.exitCode=1})
