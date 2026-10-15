import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeWorkTransaction, recoverWorkTransaction } from './work-transaction.ts';
import { fileNameOf, makeRecord } from '../../shared/workRecord.ts';
const fresh = () => mkdtempSync(join(tmpdir(), 'audioforge_transaction_'));
const file = (key: string, value: number) => ({ name: fileNameOf(key), body: JSON.stringify(makeRecord(key, { value }, 1)) });
function crash(dir: string) {
    const code = `import {writeWorkTransaction} from ${JSON.stringify(new URL('./work-transaction.ts', import.meta.url).href)};writeWorkTransaction(${JSON.stringify(dir)},${JSON.stringify([file('A', 9), file('B', 8)])},()=>process.exit(81));`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 81, child.stderr);
}
test('여러 작업 파일을 개별로 보존하며 함께 확정한다', () => { const d = fresh(); try {
    writeWorkTransaction(d, [file('A', 1), file('B', 2)]);
    assert.equal(JSON.parse(readFileSync(join(d, fileNameOf('A')), 'utf8')).data.value, 1);
    assert.ok(!existsSync(join(d, '.audioforge-work-transaction')));
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('첫 파일 교체 뒤 오류가 나면 둘 다 이전 내용으로 복구한다', () => { const d = fresh(); try {
    writeWorkTransaction(d, [file('A', 1), file('B', 2)]);
    assert.throws(() => writeWorkTransaction(d, [file('A', 9), file('B', 8)], () => { throw Error('디스크 실패'); }));
    assert.equal(JSON.parse(readFileSync(join(d, fileNameOf('A')), 'utf8')).data.value, 1);
    assert.equal(JSON.parse(readFileSync(join(d, fileNameOf('B')), 'utf8')).data.value, 2);
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('기존에 없던 파일도 실패 복구 때 남기지 않는다', () => { const d = fresh(); try {
    assert.throws(() => writeWorkTransaction(d, [file('A', 1), file('B', 2)], () => { throw Error('실패'); }));
    assert.ok(!existsSync(join(d, fileNameOf('A'))));
    assert.ok(!existsSync(join(d, fileNameOf('B'))));
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('실제 프로세스 중단 뒤 다음 접근에서 반쪽 교체를 복구한다', () => { const d = fresh(); try {
    writeWorkTransaction(d, [file('A', 1), file('B', 2)]);
    crash(d);
    assert.ok(existsSync(join(d, '.audioforge-work-transaction')));
    recoverWorkTransaction(d);
    assert.equal(JSON.parse(readFileSync(join(d, fileNameOf('A')), 'utf8')).data.value, 1);
    assert.equal(JSON.parse(readFileSync(join(d, fileNameOf('B')), 'utf8')).data.value, 2);
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('중단 뒤 사용자가 바꾼 파일은 자동 복구로 덮지 않는다', () => { const d = fresh(); try {
    writeWorkTransaction(d, [file('A', 1), file('B', 2)]);
    crash(d);
    writeFileSync(join(d, fileNameOf('A')), '사용자가 고침');
    assert.throws(() => recoverWorkTransaction(d), /자동 복구/);
    assert.equal(readFileSync(join(d, fileNameOf('A')), 'utf8'), '사용자가 고침');
    assert.ok(existsSync(join(d, '.audioforge-work-transaction')));
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('변경된 복구 사본은 보존하고 자동 복구를 멈춘다', () => { const d = fresh(); try {
    writeWorkTransaction(d, [file('A', 1), file('B', 2)]);
    crash(d);
    writeFileSync(join(d, '.audioforge-work-transaction', fileNameOf('A') + '.before'), '손상');
    assert.throws(() => recoverWorkTransaction(d), /사본/);
    assert.ok(existsSync(join(d, '.audioforge-work-transaction')));
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('대상 파일이 폴더이거나 중복이면 원래 파일을 건드리지 않는다', () => { const d = fresh(); try {
    writeWorkTransaction(d, [file('A', 1)]);
    mkdirSync(join(d, fileNameOf('B')));
    assert.throws(() => writeWorkTransaction(d, [file('A', 9), file('B', 8)]));
    assert.throws(() => writeWorkTransaction(d, [file('A', 9), file('A', 8)]));
    assert.equal(JSON.parse(readFileSync(join(d, fileNameOf('A')), 'utf8')).data.value, 1);
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('갈래 폴더 연결을 따라가 쓰거나 정리하지 않는다', () => { const d = fresh(); try {
    const target = join(d, '원본'), link = join(d, '연결');
    mkdirSync(target);
    symlinkSync(target, link, 'junction');
    assert.throws(() => writeWorkTransaction(link, [file('A', 1)]), /연결/);
    assert.ok(!existsSync(join(target, fileNameOf('A'))));
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
