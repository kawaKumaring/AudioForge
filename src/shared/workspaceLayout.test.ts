import {test} from 'node:test'
import assert from 'node:assert/strict'
import {defaultWorkspaceLayout,moveWorkspace,stepWorkspace,validWorkspaceLayout,WORKSPACE_IDS} from './workspaceLayout.ts'
test('기본 배치는 일곱 작업실을 보존한다',()=>{const x=defaultWorkspaceLayout();assert.ok(validWorkspaceLayout(x));assert.equal(x.create.length,3)})
test('분류 이동이 기존 배열과 모든 작업을 보존한다',()=>{const original=defaultWorkspaceLayout();const x=moveWorkspace(original,'tts','files','conversation');assert.deepEqual(x.files,['music','tts','conversation','transcribe','split']);assert.ok(!x.create.includes('tts'));assert.equal(original.create[0],'tts');assert.ok(validWorkspaceLayout(x))})
test('그룹 끝과 빈 그룹에도 이동한다',()=>{let x=defaultWorkspaceLayout();for(const id of [...x.create])x=moveWorkspace(x,id,'files');assert.equal(x.create.length,0);x=moveWorkspace(x,'music','create');assert.deepEqual(x.create,['music']);assert.ok(validWorkspaceLayout(x))})
test('중복·숨은 작업·누락·잘못된 버전을 거부한다',()=>{const x=defaultWorkspaceLayout();assert.ok(!validWorkspaceLayout({...x,files:[...x.files,'tts']}));assert.ok(!validWorkspaceLayout({...x,files:['lab']}));assert.ok(!validWorkspaceLayout({...x,version:2}));assert.ok(!validWorkspaceLayout(null))})
test('모든 작업을 왕복해도 하나씩만 남는다',()=>{let x=defaultWorkspaceLayout();for(const id of WORKSPACE_IDS)x=moveWorkspace(x,id,'create');for(const id of WORKSPACE_IDS)x=moveWorkspace(x,id,'files');assert.ok(validWorkspaceLayout(x));assert.equal(x.create.length,0)})
test('방향 버튼은 경계와 목록 끝을 올바르게 처리한다',()=>{let x=defaultWorkspaceLayout();x=stepWorkspace(x,'tts',-1);assert.equal(x.files.at(-1),'tts');x=stepWorkspace(x,'tts',1);assert.equal(x.create[0],'tts');x=stepWorkspace(x,'reader',-1);assert.deepEqual(x.create,['reader','tts','dub']);assert.deepEqual(stepWorkspace(x,'music',-1),x);assert.deepEqual(stepWorkspace(x,'dub',1),x)})
test('자기 자리에 놓으면 변경하지 않는다',()=>{const x=defaultWorkspaceLayout();assert.equal(moveWorkspace(x,'tts','create','tts'),x)})
