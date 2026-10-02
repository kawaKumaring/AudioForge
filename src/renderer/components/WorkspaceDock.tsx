import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** 실행 조작은 스크롤 문서 밖의 고정 칸을 쓴다. 독립 화면 검사에서는 원래 위치에 그린다. */
export const WorkspaceDockContext = createContext<HTMLElement | null>(null)
export default function WorkspaceDock({ children }: { children: ReactNode }) {
  const host = useContext(WorkspaceDockContext)
  return host ? createPortal(children, host) : <>{children}</>
}
