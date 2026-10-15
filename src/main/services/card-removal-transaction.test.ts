import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeWorkTransaction, recoverWorkTransaction, type TransactionStep } from './work-transaction.ts';
import { fileNameOf, makeRecord } from '../../shared/workRecord.ts';
import { listRecords } from './work-store.ts';
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'audioforge_remove_')), dir = join(root, 'works', 'cards');
    const folders = [join(root, '출력 하나'), join(root, '출력 둘')];
    folders.forEach(p => mkdirSync(p));
    const files = [join(folders[0], 'voice.wav'), join(folders[0], 'card.input.json'), join(folders[1], 'voice.flac')];
    const bytes = files.map((p, i) => Buffer.from('검사용 원본 ' + i));
    files.forEach((p, i) => writeFileSync(p, bytes[i]));
    const source = join(root, '사용자 원본.wav');
    writeFileSync(source, '보존할 원본');
    const before = ['current', 'kept'].map(key => ({ name: fileNameOf(key), body: JSON.stringify(makeRecord(key, { cards: ['삭제 대상', '유지 대상'] }, 1)) }));
    const after = before.map(f => ({ name: f.name, body: JSON.stringify(makeRecord(JSON.parse(f.body).key, { cards: ['유지 대상'] }, 2)) }));
    writeWorkTransaction(dir, before);
    return { root, dir, files, bytes, source, before, after };
}
function original(f: ReturnType<typeof fixture>) { for (const [i, p] of f.files.entries())
    assert.deepEqual(readFileSync(p), f.bytes[i]); for (const x of f.before)
    assert.equal(readFileSync(join(f.dir, x.name), 'utf8'), x.body); assert.equal(readFileSync(f.source, 'utf8'), '보존할 원본'); }
function deleted(f: ReturnType<typeof fixture>) { for (const p of f.files)
    assert.ok(!existsSync(p)); for (const x of f.after)
    assert.equal(readFileSync(join(f.dir, x.name), 'utf8'), x.body); assert.equal(readFileSync(f.source, 'utf8'), '보존할 원본'); }
function crash(f: ReturnType<typeof fixture>, step: TransactionStep, index = 0) {
    const code = `import {writeWorkTransaction} from ${JSON.stringify(new URL('./work-transaction.ts', import.meta.url).href)};writeWorkTransaction(${JSON.stringify(f.dir)},${JSON.stringify(f.after)},undefined,{removals:${JSON.stringify(f.files)},onStep:(step,index)=>{if(step===${JSON.stringify(step)}&&index===${index})process.exit(81)}});`;
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 81, child.stderr);
}
test('여러 폴더의 파일과 모든 카드 기록을 함께 제거한다', () => { const f = fixture(); try {
    const r = writeWorkTransaction(f.dir, f.after, undefined, { removals: f.files });
    assert.equal(r.pending, 0);
    deleted(f);
    assert.ok(!existsSync(join(f.dir, '.audioforge-work-transaction')));
    for (const p of f.files)
        assert.ok(!readdirSync(join(p, '..')).some(n => n.endsWith('.pending')));
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
for (const point of ['staged', 'metadata', 'before-commit'] as const)
    test(point + ' 실패면 음원·입력·카드 정보 모두 이전 상태다', () => { const f = fixture(); try {
        assert.throws(() => writeWorkTransaction(f.dir, f.after, undefined, { removals: f.files, onStep: step => { if (step === point)
                throw Error('쓰기 거절'); } }));
        original(f);
    }
    finally {
        rmSync(f.root, { recursive: true, force: true });
    } });
for (const point of ['prepared', 'staged', 'metadata', 'before-commit'] as const)
    test(point + ' 직후 실제 프로세스 종료도 다음 접근에서 복구한다', () => { const f = fixture(); try {
        crash(f, point);
        const r = recoverWorkTransaction(f.dir);
        assert.equal(r.pending, 0);
        original(f);
    }
    finally {
        rmSync(f.root, { recursive: true, force: true });
    } });
for (const point of ['committed', 'cleanup'] as const)
    test(point + ' 직후 프로세스 종료는 삭제를 되살리지 않고 청소한다', () => { const f = fixture(); try {
        crash(f, point);
        const r = recoverWorkTransaction(f.dir);
        assert.equal(r.pending, 0);
        deleted(f);
    }
    finally {
        rmSync(f.root, { recursive: true, force: true });
    } });
test('확정 뒤 청소 실패는 삭제 성공과 정리 대기를 구분한다', () => { const f = fixture(); try {
    const r = writeWorkTransaction(f.dir, f.after, undefined, { removals: f.files, onStep: step => { if (step === 'cleanup')
            throw Error('잠긴 파일'); } });
    assert.equal(r.committed, true);
    assert.equal(r.pending, 3);
    deleted(f);
    assert.ok(existsSync(join(f.dir, '.audioforge-work-transaction', 'journal.json')));
    assert.equal(recoverWorkTransaction(f.dir).pending, 0);
    deleted(f);
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
test('일부만 청소된 뒤 재시도해도 남은 임시본만 지운다', () => { const f = fixture(); try {
    const r = writeWorkTransaction(f.dir, f.after, undefined, { removals: f.files, onStep: (step, index) => { if (step === 'cleanup' && index === 1)
            throw Error('잠김'); } });
    assert.equal(r.pending, 1);
    deleted(f);
    assert.equal(recoverWorkTransaction(f.dir).pending, 0);
    deleted(f);
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
test('복구 자체가 실패해도 사본을 남기고 다음 목록 읽기에서 복구한다', () => { const f = fixture(); try {
    assert.throws(() => writeWorkTransaction(f.dir, f.after, undefined, { removals: f.files, onStep: step => { if (step === 'staged' || step === 'rollback')
            throw Error('잠김'); } }), /복구가 필요/);
    assert.ok(existsSync(join(f.dir, '.audioforge-work-transaction', 'journal.json')));
    const listed = listRecords({ root: f.root, now: () => 1 }, 'cards');
    assert.ok(!listed.error);
    original(f);
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
test('복구 위치에 새 파일이 생기면 덮지 않고 양쪽을 보존한다', () => { const f = fixture(); try {
    crash(f, 'staged');
    writeFileSync(f.files[0], '사용자가 새로 만든 소리');
    assert.throws(() => recoverWorkTransaction(f.dir), /충돌/);
    assert.equal(readFileSync(f.files[0], 'utf8'), '사용자가 새로 만든 소리');
    assert.ok(existsSync(join(f.dir, '.audioforge-work-transaction', 'journal.json')));
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
test('확정 뒤 같은 이름에 새 파일이 생겨도 그 파일은 지우지 않는다', () => { const f = fixture(); try {
    crash(f, 'committed');
    writeFileSync(f.files[0], '새 파일');
    recoverWorkTransaction(f.dir);
    assert.equal(readFileSync(f.files[0], 'utf8'), '새 파일');
    for (const x of f.after)
        assert.equal(readFileSync(join(f.dir, x.name), 'utf8'), x.body);
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
test('삭제 임시 사본 변조는 읽기를 막고 파일을 보존한다', () => { const f = fixture(); try {
    crash(f, 'staged');
    const stage = join(f.dir, '.audioforge-work-transaction'), j = JSON.parse(readFileSync(join(stage, 'journal.json'), 'utf8'));
    writeFileSync(j.removals[0].staged, '손상');
    const got = listRecords({ root: f.root, now: () => 1 }, 'cards');
    assert.ok(got.error);
    assert.ok(existsSync(j.removals[0].staged));
    assert.ok(existsSync(join(stage, 'journal.json')));
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
test('변조된 복구 표로 무관한 파일을 지우지 않는다', () => { const f = fixture(); try {
    crash(f, 'committed');
    const stage = join(f.dir, '.audioforge-work-transaction'), j = JSON.parse(readFileSync(join(stage, 'journal.json'), 'utf8'));
    j.removals[0].staged = f.source;
    writeFileSync(join(stage, 'journal.json'), JSON.stringify(j));
    assert.throws(() => recoverWorkTransaction(f.dir), /경로/);
    assert.equal(readFileSync(f.source, 'utf8'), '보존할 원본');
}
finally {
    rmSync(f.root, { recursive: true, force: true });
} });
test('복구 도중 다시 종료돼도 다음 실행에서 복구를 이어 간다', () => {
    const f = fixture();
    try {
        const code = `import {writeWorkTransaction} from ${JSON.stringify(new URL('./work-transaction.ts', import.meta.url).href)};writeWorkTransaction(${JSON.stringify(f.dir)},${JSON.stringify(f.after)},undefined,{removals:${JSON.stringify(f.files)},onStep:(step)=>{if(step==='staged')throw Error('장애');if(step==='rollback')process.exit(81)}});`;
        const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000 });
        assert.equal(child.status, 81, child.stderr);
        recoverWorkTransaction(f.dir);
        original(f);
    }
    finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
