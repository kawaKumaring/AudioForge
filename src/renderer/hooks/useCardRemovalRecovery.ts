import { loadSavedFile } from '../lib/cardWorkSaver';
import { useEffect, useRef, useState, useCallback } from 'react';
/** 화면을 떠나도 복구 기록은 본체가 소유한다. 여기서는 상태와 재시도만 보여 준다. */
export function useCardRemovalRecovery() {
    const [state, setState] = useState({ busy: true, blocked: true, message: '' });
    const alive = useRef(false), sequence = useRef(0);
    const retry = useCallback(async () => {
        const mine = ++sequence.current;
        setState(s => ({ ...s, busy: true }));
        try {
            const r = await window.api.cards.recoverRemovals();
            if (!alive.current || mine !== sequence.current)
                return;
            if (!r.ok)
                throw Error(r.why || '삭제 복구를 확인하지 못했습니다');
            if (r.restored && !r.pending)
                await loadSavedFile(true);
            if (!alive.current || mine !== sequence.current)
                return;
            setState({ busy: false, blocked: !!r.pending, message: r.pending ? r.message || '삭제 임시 파일을 다시 정리해야 합니다.' : '' });
        }
        catch (e) {
            if (alive.current && mine === sequence.current)
                setState({ busy: false, blocked: true, message: (e as Error).message });
        }
    }, []);
    useEffect(() => {
        alive.current = true;
        void retry();
        const listener = () => { void retry(); };
        window.addEventListener('audioforge-card-removal-recovery', listener);
        return () => { alive.current = false; sequence.current++; window.removeEventListener('audioforge-card-removal-recovery', listener); };
    }, [retry]);
    return { ...state, retry };
}
