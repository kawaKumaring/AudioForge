import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileDurable, replaceFileAtomically } from './durable-write.ts';
test('유니코드와 바이트를 잘림 없이 쓴다', () => { const d = mkdtempSync(join(tmpdir(), 'audioforge_write_')); try {
    const file = join(d, '본문.json'), body = '한글 글자와 기호 ♡'.repeat(10000);
    writeFileDurable(file, body);
    assert.equal(readFileSync(file, 'utf8'), body);
    writeFileDurable(file, Buffer.from([0, 255, 1]));
    assert.deepEqual(readFileSync(file), Buffer.from([0, 255, 1]));
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
test('검증 실패는 기존 파일을 유지하고 임시본을 정리한다', () => { const d = mkdtempSync(join(tmpdir(), 'audioforge_write_')); try {
    const file = join(d, '기록.json');
    replaceFileAtomically(file, '{"v":1}');
    assert.throws(() => replaceFileAtomically(file, '깨진 JSON'));
    assert.equal(readFileSync(file, 'utf8'), '{"v":1}');
    assert.deepEqual(readdirSync(d), ['기록.json']);
}
finally {
    rmSync(d, { recursive: true, force: true });
} });
