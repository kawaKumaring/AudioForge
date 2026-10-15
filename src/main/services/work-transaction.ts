/** 작업 파일은 나누어 두고, 여러 파일의 교체만 복구 가능한 거래로 묶는다. */
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-ignore TS5097
import { replaceFileAtomically, writeFileDurable } from './durable-write.ts';
// @ts-ignore TS5097
import { isWorkFile } from '../../shared/workRecord.ts';
const STAGE = '.audioforge-work-transaction';
const OWNER = 'audioforge-work-transaction-v1';
const managedName = (name: string) => isWorkFile(name) || name === '.legacy-migration.json';
interface Entry {
    name: string;
    before: string | null;
    after: string;
}
interface Journal {
    owner: typeof OWNER;
    phase: 'prepared' | 'committed';
    entries: Entry[];
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
    throw Error('작업 기록의 파일 형식 또는 연결을 확인해야 합니다'); return s; }
function readJournal(stage: string): Journal {
    regular(join(stage, 'journal.json'));
    const x = JSON.parse(readFileSync(join(stage, 'journal.json'), 'utf8')) as Journal;
    if (x.owner !== OWNER || !['prepared', 'committed'].includes(x.phase) || !Array.isArray(x.entries) || !x.entries.length)
        throw Error('작업 저장 복구 기록이 손상되었습니다');
    if (new Set(x.entries.map(e => e.name)).size !== x.entries.length)
        throw Error('작업 저장 복구 대상이 겹칩니다');
    for (const e of x.entries)
        if (typeof e.name !== 'string' || !managedName(e.name) || e.name.includes('/') || e.name.includes('\\') || !(/^[a-f0-9]{64}$/.test(e.after)) || e.before !== null && !(/^[a-f0-9]{64}$/.test(e.before)))
            throw Error('작업 저장 복구 경로가 올바르지 않습니다');
    return x;
}
/** 준비된 거래만 되돌린다. 완료 표 이후의 거래는 새 파일을 유지한다. */
export function recoverWorkTransaction(dir: string): void {
    const parent = info(dir);
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink()))
        throw Error('작업 기록 폴더가 연결이거나 폴더가 아닙니다');
    const stage = join(dir, STAGE), s = info(stage);
    if (!s)
        return;
    if (!s.isDirectory() || s.isSymbolicLink())
        throw Error('작업 저장 복구 폴더가 연결이거나 올바르지 않습니다');
    const journal = readJournal(stage);
    if (journal.phase === 'prepared') {
        // 복구 파일을 전부 확인한 뒤에만 대상에 손댄다.
        for (const e of journal.entries) {
            const target = join(dir, e.name);
            if (regular(target)) {
                const hash = sha(readFileSync(target));
                if (hash !== e.before && hash !== e.after)
                    throw Error('저장 중단 뒤 작업 파일이 바뀌어 자동 복구를 멈췄습니다');
            }
            if (e.before !== null) {
                const backup = join(stage, e.name + '.before');
                regular(backup);
                if (sha(readFileSync(backup)) !== e.before)
                    throw Error('작업 저장 복구 사본이 변경되었습니다');
            }
        }
        for (const e of journal.entries) {
            const target = join(dir, e.name);
            if (e.before === null)
                rmSync(target, { force: true });
            else {
                const restore = join(stage, e.name + '.restore');
                writeFileDurable(restore, readFileSync(join(stage, e.name + '.before')));
                renameSync(restore, target);
            }
        }
    }
    rmSync(stage, { recursive: true, force: true });
}
/** 검사의 fault는 실제 파일 교체 중 실패·중단을 재현하기 위한 주입점이다. */
export function writeWorkTransaction(dir: string, files: {
    name: string;
    body: string;
}[], fault?: (replaced: number) => void): void {
    recoverWorkTransaction(dir);
    if (!files.length)
        return;
    if (new Set(files.map(f => f.name)).size !== files.length)
        throw Error('한 거래에 같은 작업을 두 번 쓸 수 없습니다');
    const snapshots = files.map(f => {
        if (!managedName(f.name) || f.name.includes('/') || f.name.includes('\\'))
            throw Error('작업 파일 이름이 올바르지 않습니다');
        const existed = regular(join(dir, f.name));
        return { ...f, before: existed ? readFileSync(join(dir, f.name)) : null };
    });
    mkdirSync(dir, { recursive: true });
    const stage = join(dir, STAGE);
    mkdirSync(stage);
    let prepared = false, committed = false;
    try {
        const entries: Entry[] = snapshots.map(f => ({ name: f.name, before: f.before === null ? null : sha(f.before), after: sha(Buffer.from(f.body)) }));
        for (const f of snapshots) {
            if (f.before !== null)
                writeFileDurable(join(stage, f.name + '.before'), f.before);
            writeFileDurable(join(stage, f.name + '.after'), f.body);
        }
        replaceFileAtomically(join(stage, 'journal.json'), JSON.stringify({ owner: OWNER, phase: 'prepared', entries }));
        prepared = true;
        let replaced = 0;
        for (const f of snapshots) {
            renameSync(join(stage, f.name + '.after'), join(dir, f.name));
            fault?.(++replaced);
        }
        replaceFileAtomically(join(stage, 'journal.json'), JSON.stringify({ owner: OWNER, phase: 'committed', entries }));
        committed = true;
    }
    catch (e) {
        if (prepared) {
            try {
                recoverWorkTransaction(dir);
            }
            catch {
                throw Error('작업 저장 실패 후 복구가 필요합니다. 기존 사본을 보존했습니다');
            }
        }
        else
            rmSync(stage, { recursive: true, force: true });
        throw e;
    }
    finally {
        // 완료 뒤 임시 사본 정리 실패는 저장 실패로 거짓 보고하지 않는다. 다음 접근에서 정리한다.
        if (committed) {
            try {
                rmSync(stage, { recursive: true, force: true });
            }
            catch { /* 복구 표로 다음 접근에서 정리 */ }
        }
    }
}
