
'use strict'
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto')
const {McpClient}=require('../../tools/mcp/client.cjs')
const ROOT=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync(path.join(ROOT,'_local/tmp/quality-test-'))
function tone(file){const sr=24000,n=sr*2,b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(sr,24);b.writeUInt32LE(sr*4,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);for(let i=0;i<n;i++){const v=i<sr*.6||i>=sr*1.3?Math.round(12000*Math.sin(i*2*Math.PI*440/sr)):0;b.writeInt16LE(v,44+i*4);b.writeInt16LE(-v,46+i*4)}fs.writeFileSync(file,b)}
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
;(async()=>{const c=new McpClient();await c.start();let count=0;const ok=(v,m)=>{assert.ok(v,m);count++;console.log('PASS',m)};const call=async(n,a={})=>{const r=await c.call('audio_quality_'+n,a);assert.equal(r.isError,false,r.text);return r};try{
 ok((await c.listTools()).filter(t=>t.name.startsWith('audio_quality_')).length===13,'13 tools registered')
 const cap=(await call('capabilities')).json;ok(cap.device==='CPU'&&cap.network===false,'local CPU capability')
 const f=path.join(dir,'stereo.wav');tone(f);const before=sha(f);const record=path.join(dir,'record.json');fs.writeFileSync(record,JSON.stringify({sourceHash:before,note:'x'.repeat(4400)}))
 const a=(await call('analyze',{path:f,records:[record]})).json;ok(a.channels===2&&a.duration===2,'real stereo decoding');ok(a.finite&&a.peak>.36,'signal retained')
 const s=(await call('read',{reportId:a.reportId,section:'signals'})).json;ok(s.items.filter(x=>x.kind==='channel').length===2,'both channels');const gap=s.items.find(x=>x.kind==='quiet_candidate');ok(gap&&gap.start===.6&&gap.end===1.3,'anti-phase stereo not mistaken for silence')
 const read=(await call('read',{reportId:a.reportId,section:'records',limit:1})).json;ok(read.total===3&&read.nextOffset===1,'metadata paginated without loss');const rest=(await call('read',{reportId:a.reportId,section:'records',offset:1})).json;ok(JSON.parse(read.items[0].text+rest.items.map(x=>x.text).join('')).note.length===4400,'record full roundtrip')
 ok((await call('analyze',{path:f,records:[record]})).json.cached,'content cache hit')
 ok((await c.call('audio_quality_analyze',{path:f,expectedSha256:'0'.repeat(64)})).isError,'hash mismatch rejected')
 ok((await c.call('audio_quality_analyze',{path:f,start:1,end:.5})).isError,'invalid range rejected')
 const partial=(await call('analyze',{path:f,start:.5,end:1.5})).json;ok(partial.duration===1&&partial.reportId!==a.reportId,'window changes cache key')
 const clip=(await call('clip',{reportId:a.reportId,start:.5,end:1.5})).json;ok(clip.frames===24000&&clip.channels===2&&fs.existsSync(clip.path),'sample-accurate clip')
 const sourceBytes=fs.readFileSync(f),clipBytes=fs.readFileSync(clip.path);let dataStart=12;while(clipBytes.toString('ascii',dataStart,dataStart+4)!=='data'){const size=clipBytes.readUInt32LE(dataStart+4);dataStart+=8+size+(size%2)}dataStart+=8;let same=true;for(let i=0;i<clip.frames*2;i++){if(clipBytes.readFloatLE(dataStart+i*4)!==sourceBytes.readInt16LE(44+(12000*2+i)*2)/32768){same=false;break}}ok(same,'clip retains every source channel sample');
 const provenance=(await call('read',{reportId:a.reportId,section:'provenance'})).json;ok(provenance.data.source.sha256===before&&provenance.data.environment.dependencies.numpy,'source and runtime provenance accessible');
 fs.writeFileSync(record,JSON.stringify({note:'changed'}));ok(!(await call('read',{reportId:a.reportId,section:'provenance'})).json.data.recordsCurrent[0].current,'changed metadata flagged');
 const recordChanged=(await call('analyze',{path:f,records:[record]})).json;ok(recordChanged.reportId!==a.reportId,'metadata changes invalidate cache');
 const broken=path.join(dir,'broken.wav');fs.writeFileSync(broken,'broken');ok((await c.call('audio_quality_analyze',{path:broken})).isError,'undecodable source is an error');
 const plot=await call('plot',{reportId:a.reportId,otherReportId:a.reportId});ok(plot.images.length===1&&plot.images[0].length>1000,'native MCP image');ok(plot.json.render.normalized===false,'same-scale no normalization')
 const cmp=(await call('compare',{reportId:a.reportId,otherReportId:a.reportId})).json;ok(cmp.sameSource&&cmp.deltaSeconds===0,'self comparison')
 ok(sha(f)===before,'source unchanged by all tools')
 fs.appendFileSync(f,Buffer.from([0,0]));ok(!(await call('read',{reportId:a.reportId})).json.sourceCurrent,'changed source reported');ok((await c.call('audio_quality_plot',{reportId:a.reportId})).isError,'stale plots blocked')
 const changed=(await call('analyze',{path:f})).json;ok(changed.reportId!==a.reportId&&!changed.cached,'source byte change invalidates cache')
 ok((await c.call('audio_quality_analyze',{path:path.join(ROOT,'_local/experiments/longform-2026-09-25/run/synthesized.wav')})).isError,'outside fixture permission guard')
 ok((await c.call('audio_quality_read',{reportId:'../x'})).isError,'report traversal rejected')
 console.log('RESULT',count,'checks, 0 fail')
 }finally{await c.close()}})().catch(e=>{console.error(e);process.exitCode=1})
