// 개발 전용. AudioForge 실행·사용자 파일 열기·네트워크 전송 없이 로컬 REA MCP를 호출한다.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
async function main(){
  const [reaRoot,outputDir]=process.argv.slice(2);
  if(!reaRoot||!outputDir)throw Error('REA 폴더와 로컬 근거 저장 폴더를 지정하세요');
  const req=createRequire(path.join(path.resolve(reaRoot),'package.json'));
  const {Client}=req('@modelcontextprotocol/client');
  const {StdioClientTransport}=req('@modelcontextprotocol/client/stdio');
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(reaRoot,'scripts/rea.mjs'),'mcp'],stderr:'pipe'});
  const client=new Client({name:'audioforge-h3-audit',version:'1'});
  fs.mkdirSync(outputDir,{recursive:true});
  try{
    await client.connect(transport);
    const tools=await client.listTools();
    const tool=tools.tools.find(t=>t.name==='analyze_javascript_application');
    if(!tool)throw Error('REA 정적 분석 도구가 없습니다');
    fs.writeFileSync(path.join(outputDir,'tool-schema.json'),JSON.stringify(tool,null,2));
    const root=path.resolve(__dirname,'..','out');
    const entry=fs.readdirSync(path.join(root,'renderer/assets')).filter(n=>/^index-.*\.js$/.test(n));
    if(entry.length!==1)throw Error('현재 빌드의 렌더러 진입점을 하나로 확인하지 못했습니다');
    const selected=['main/index.js','preload/index.js','renderer/assets/'+entry[0]];
    const args={input_path:root,source_paths:selected,detail:'summary',analysis_timeout_ms:60000};
    fs.writeFileSync(path.join(outputDir,'request.json'),JSON.stringify(args,null,2));
    const result=await client.callTool({name:tool.name,arguments:args},undefined,{timeout:210000});
    fs.writeFileSync(path.join(outputDir,'summary.json'),JSON.stringify(result,null,2));
    if(result.isError)throw Error('REA 분석 실패: '+JSON.stringify(result.content));
    const exporter=tools.tools.find(t=>t.name==='export_evidence_bundle');
    if(!exporter)throw Error('전체 근거를 저장할 REA 도구가 없습니다');
    fs.writeFileSync(path.join(outputDir,'export-schema.json'),JSON.stringify(exporter,null,2));
    const exported=await client.callTool({name:exporter.name,arguments:{path:path.resolve(outputDir,'evidence-bundle.json'),overwrite:true}},undefined,{timeout:60000});
    fs.writeFileSync(path.join(outputDir,'export.json'),JSON.stringify(exported,null,2));
    if(exported.isError)throw Error('REA 전체 근거 저장 실패');
    const evidence=JSON.parse(result.content.find(c=>c.type==='text').text);
    const bundle=JSON.parse(fs.readFileSync(path.join(outputDir,'evidence-bundle.json'),'utf8'));
    const analysis=bundle.records.find(r=>r.operation===tool.name);
    if(!analysis)throw Error('저장한 근거에 분석 원본이 없습니다');
    const findings=analysis.normalized_result.graph.nodes.filter(n=>n.kind==='ipc-channel').flatMap(n=>
      n.observations.filter(o=>['audio:process','audio:result','audio:error'].includes(o.properties?.channel)).map(o=>
        ({node_id:n.node_id,channel:o.properties.channel,side:o.properties.side,operation:o.properties.operation,
          location:o.evidence?.location,confidence:o.evidence?.confidence})));
    fs.writeFileSync(path.join(outputDir,'h3-ipc-findings.json'),JSON.stringify({parent_evidence_id:analysis.evidence_id,
      source_selection:analysis.normalized_result.source_selection,statistics:analysis.normalized_result.statistics,findings,
      limitation:'정적 관측이며 실제 실행·Python 생성 성공을 증명하지 않음'},null,2));
    console.log(JSON.stringify({evidence_id:evidence.evidence_id,parent_evidence_id:evidence.normalized_result?.parent_evidence_id,
      coverage:evidence.normalized_result?.coverage,export:exported}));
  }finally{await client.close()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
