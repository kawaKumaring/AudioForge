/** 파일별 기록과 여러 음원 삭제를 하나의 복구 표로 확정한다. */
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, rmdirSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
// @ts-ignore TS5097
import { replaceFileAtomically, writeFileDurable } from './durable-write.ts';
// @ts-ignore TS5097
import { isWorkFile } from '../../shared/workRecord.ts';
const STAGE = '.audioforge-work-transaction';
const OWNER = 'audioforge-work-transaction-v1';
const managedName = (name: string) => isWorkFile(name) || name === '.legacy-migration.json';
const same = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
interface Entry {
    name: string;
    before: string | null;
    after: string;
}
interface Removal {
    path: string;
    staged: string;
    sha256: string;
    bytes: number;
}
interface Journal {
    owner: typeof OWNER;
    phase: 'prepared' | 'committed' | 'rolled-back';
    entries: Entry[];
    id?: string;
    removals?: Removal[];
}
export interface RecoveryState {
    pending: number;
    committed: boolean;
    restored?: boolean;
    message?: string;
}
export type TransactionStep = 'prepared' | 'staged' | 'metadata' | 'before-commit' | 'committed' | 'cleanup' | 'rollback';
export interface TransactionOptions {
    removals?: string[];
    /** 디스크 고장·프로세스 종료를 합성 자료로 재현하는 주입점. IPC로 노출하지 않는다. */
    onStep?: (step: TransactionStep, index: number) => void;
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function info(path: string) { try {
    return lstatSync(path);
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return null;
    throw e;
} }
function regular(path: string) { const s = info(path); if (s && (!s.isFile() || s.isSymbolicLink()))
    throw Error('작업 파일이 연결이거나 파일이 아닙니다'); return s; }
function fileHash(path: string): string {
    const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024);
    try {
        for (;;) {
            const n = readSync(fd, buffer, 0, buffer.length, null);
            if (!n)
                break;
            hash.update(buffer.subarray(0, n));
        }
        return hash.digest('hex');
    }
    finally {
        closeSync(fd);
    }
}
function journalFile(stage: string) { return join(stage, 'journal.json'); }
function readJournal(stage: string): Journal {
    regular(journalFile(stage));
    const x = JSON.parse(readFileSync(journalFile(stage), 'utf8')) as Journal;
    if (!x || x.owner !== OWNER || !['prepared', 'committed', 'rolled-back'].includes(x.phase) || !Array.isArray(x.entries))
        throw Error('작업 복구 기록이 손상되었습니다');
    if (new Set(x.entries.map(e => e.name)).size !== x.entries.length)
        throw Error('복구 대상 기록이 겹칩니다');
    for (const e of x.entries)
        if (!e || typeof e.name !== 'string' || !managedName(e.name) || e.name.includes('/') || e.name.includes('\\') || !/^[a-f0-9]{64}$/.test(e.after) || e.before !== null && !/^[a-f0-9]{64}$/.test(e.before))
            throw Error('작업 복구 경로가 올바르지 않습니다');
    if (x.removals !== undefined) {
        if (!Array.isArray(x.removals) || typeof x.id !== 'string' || !/^[a-f0-9-]{36}$/.test(x.id))
            throw Error('파일 삭제 복구 표가 손상되었습니다');
        const paths = new Set<string>();
        for (const [i, r] of x.removals.entries()) {
            if (!r || typeof r.path !== 'string' || !isAbsolute(r.path) || !same(r.staged, join(dirname(r.path), `.audioforge-delete-${x.id}-${i}.pending`)) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.bytes) || r.bytes < 0)
                throw Error('파일 삭제 복구 경로가 올바르지 않습니다');
            const key = process.platform === 'win32' ? r.path.toLowerCase() : r.path;
            if (paths.has(key))
                throw Error('삭제 복구 대상이 겹칩니다');
            paths.add(key);
        }
    }
    if (!x.entries.length && !x.removals?.length)
        throw Error('복구 대상이 없습니다');
    return x;
}
function assertParent(path: string) { if (!same(realpathSync(dirname(path)), dirname(path)))
    throw Error('삭제 대상 폴더의 연결이 바뀌어 복구를 멈췄습니다'); }
function assertBytes(path: string, r: Removal) { const s = regular(path); if (!s || s.size !== r.bytes || fileHash(path) !== r.sha256)
    throw Error('삭제 대상 또는 임시 사본이 변경되어 복구를 멈췄습니다'); }
function cleanStage(stage: string, j: Journal): void {
    // 복구 표는 맨 마지막에 지운다. 정리 도중 종료돼도 다음 실행이 상태를 안다.
    for (const e of j.entries)
        for (const suffix of ['.before', '.after', '.restore']) {
            const path = join(stage, e.name + suffix);
            if (info(path))
                unlinkSync(path);
        }
    for (const name of readdirSync(stage))
        if (/^\.journal\.json\.[0-9]+\.tmp$/.test(name))
            unlinkSync(join(stage, name));
    const extra = readdirSync(stage).filter(n => n !== 'journal.json');
    if (extra.length)
        throw Error('복구 폴더에 알 수 없는 파일이 있어 보존했습니다');
    if (info(journalFile(stage)))
        unlinkSync(journalFile(stage));
    rmdirSync(stage);
}
function finish(stage: string, j: Journal, options: TransactionOptions = {}): RecoveryState {
    let pending = 0;
    if (j.phase === 'committed') {
        // 외부 파일을 바꿔 놓았으면 어느 사본도 지우지 않는다.
        try {
            for (const r of j.removals || []) {
                if (regular(r.staged)) {
                    assertParent(r.path);
                    assertBytes(r.staged, r);
                }
            }
        }
        catch (e) {
            return { pending: Math.max(1, j.removals?.length || 0), committed: true, message: (e as Error).message };
        }
        for (const [i, r] of (j.removals || []).entries()) {
            try {
                options.onStep?.('cleanup', i);
                if (info(r.staged))
                    unlinkSync(r.staged);
            }
            catch {
                pending++;
            }
        }
    }
    if (!pending) {
        try {
            cleanStage(stage, j);
        }
        catch {
            pending = 1;
        }
    }
    return { pending, committed: j.phase === 'committed', ...(pending ? { message: j.phase === 'committed' ? '카드 제거는 확정됐지만 임시 파일 정리가 남았습니다.' : '복구는 끝났지만 임시 기록 정리가 남았습니다.' } : {}) };
}
/** 준비 중이면 전부 복원한다. 확정 뒤에는 삭제 상태를 유지하고 청소만 재시도한다. */
export function recoverWorkTransaction(dir: string, options: TransactionOptions = {}): RecoveryState {
    const parent = info(dir);
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink()))
        throw Error('작업 기록 폴더가 연결이거나 폴더가 아닙니다');
    const stage = join(dir, STAGE), s = info(stage);
    if (!s)
        return { pending: 0, committed: false };
    if (!s.isDirectory() || s.isSymbolicLink())
        throw Error('작업 복구 폴더가 연결이거나 폴더가 아닙니다');
    if (!info(journalFile(stage)) && !readdirSync(stage).length) {
        rmdirSync(stage);
        return { pending: 0, committed: false };
    }
    const j = readJournal(stage);
    if (j.phase === 'prepared') {
        // 전체 사본과 목적지를 확인한 다음에만 복구를 시작한다.
        for (const e of j.entries) {
            const target = join(dir, e.name);
            if (regular(target)) {
                const hash = fileHash(target);
                if (hash !== e.before && hash !== e.after)
                    throw Error('저장 중단 뒤 작업 파일이 바뀌어 자동 복구를 멈췄습니다');
            }
            if (e.before !== null) {
                const backup = join(stage, e.name + '.before');
                regular(backup);
                if (fileHash(backup) !== e.before)
                    throw Error('작업 저장 복구 사본이 변경되었습니다');
            }
        }
        for (const r of j.removals || []) {
            assertParent(r.path);
            const original = regular(r.path), staged = regular(r.staged);
            if (!!original === !!staged)
                throw Error('삭제 복구 위치가 충돌하거나 파일이 없어 사본을 보존했습니다');
            assertBytes(original ? r.path : r.staged, r);
        }
        for (const [i, r] of (j.removals || []).entries()) {
            options.onStep?.('rollback', i);
            if (info(r.staged))
                renameSync(r.staged, r.path);
        }
        for (const e of j.entries) {
            const target = join(dir, e.name);
            if (e.before === null) {
                if (info(target))
                    unlinkSync(target);
            }
            else {
                const restored = join(stage, e.name + '.restore');
                if (info(restored))
                    regular(restored);
                writeFileDurable(restored, readFileSync(join(stage, e.name + '.before')));
                renameSync(restored, target);
            }
        }
        j.phase = 'rolled-back';
        replaceFileAtomically(journalFile(stage), JSON.stringify(j));
    }
    const result = finish(stage, j, options);
    return { ...result, ...(j.phase === 'rolled-back' ? { restored: true } : {}) };
}
/** 메타 교체와 파일 치우기를 같은 확정 표 아래에서 실행한다. */
export function writeWorkTransaction(dir: string, files: {
    name: string;
    body: string;
}[], fault?: (replaced: number) => void, options: TransactionOptions = {}): RecoveryState {
    const prior = recoverWorkTransaction(dir);
    if (prior.pending)
        throw Error(prior.message || '이전 파일 정리를 먼저 마쳐야 합니다');
    const requested = options.removals || [];
    if (!files.length && !requested.length)
        return { pending: 0, committed: false };
    if (new Set(files.map(f => f.name)).size !== files.length)
        throw Error('같은 작업을 두 번 쓸 수 없습니다');
    const snapshots = files.map(f => {
        if (!managedName(f.name) || f.name.includes('/') || f.name.includes('\\'))
            throw Error('작업 파일 이름이 올바르지 않습니다');
        const existed = regular(join(dir, f.name));
        return { ...f, before: existed ? readFileSync(join(dir, f.name)) : null };
    });
    const id = randomUUID(), removals: Removal[] = [], seen = new Set<string>();
    for (const raw of requested) {
        regular(raw);
        const path = realpathSync(raw), key = process.platform === 'win32' ? path.toLowerCase() : path;
        if (seen.has(key))
            continue;
        seen.add(key);
        if (files.some(f => same(path, join(dir, f.name))))
            throw Error('작업 메타 파일을 음원처럼 삭제할 수 없습니다');
        const staged = join(dirname(path), `.audioforge-delete-${id}-${removals.length}.pending`);
        if (info(staged))
            throw Error('삭제 임시 위치가 이미 있습니다');
        const s = regular(path)!;
        removals.push({ path, staged, sha256: fileHash(path), bytes: s.size });
    }
    mkdirSync(dir, { recursive: true });
    const stage = join(dir, STAGE);
    mkdirSync(stage);
    const j: Journal = { owner: OWNER, phase: 'prepared', id, removals, entries: snapshots.map(f => ({ name: f.name, before: f.before === null ? null : sha(f.before), after: sha(Buffer.from(f.body)) })) };
    let prepared = false, committed = false;
    try {
        for (const f of snapshots) {
            if (f.before !== null)
                writeFileDurable(join(stage, f.name + '.before'), f.before);
            writeFileDurable(join(stage, f.name + '.after'), f.body);
        }
        replaceFileAtomically(journalFile(stage), JSON.stringify(j));
        prepared = true;
        options.onStep?.('prepared', 0);
        for (const [i, r] of removals.entries()) {
            assertParent(r.path);
            assertBytes(r.path, r);
            if (info(r.staged))
                throw Error('삭제 임시 위치가 바뀌었습니다');
            renameSync(r.path, r.staged);
            options.onStep?.('staged', i);
        }
        let replaced = 0;
        for (const f of snapshots) {
            renameSync(join(stage, f.name + '.after'), join(dir, f.name));
            replaced++;
            fault?.(replaced);
            options.onStep?.('metadata', replaced - 1);
        }
        options.onStep?.('before-commit', 0);
        j.phase = 'committed';
        replaceFileAtomically(journalFile(stage), JSON.stringify(j));
        committed = true;
        options.onStep?.('committed', 0);
    }
    catch (e) {
        if (committed)
            return finish(stage, j, options);
        if (prepared) {
            try {
                recoverWorkTransaction(dir, options);
            }
            catch {
                throw Error('파일 제거를 완료하지 못했고 복구가 필요합니다. 음원·카드 사본을 보존했습니다');
            }
        }
        else {
            try {
                cleanStage(stage, j);
            }
            catch { /* 원본은 아직 바꾸지 않았다 */ }
        }
        throw e;
    }
    return finish(stage, j, options);
}
