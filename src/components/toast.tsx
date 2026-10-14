import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { Link } from 'react-router'
import { cx } from './ui'

interface Toast {
  id: number
  tone: 'ok' | 'error' | 'info'
  title: string
  body?: string
  href?: string
}

const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined)
let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextId++
    setToasts((list) => [...list.slice(-3), { ...t, id }])
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.tone === 'error' ? 7000 : 4500)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="no-print pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => {
          const Icon = t.tone === 'ok' ? CheckCircle2 : t.tone === 'error' ? TriangleAlert : Info
          const content = (
            <>
              <Icon className={cx('mt-0.5 size-4 shrink-0', t.tone === 'ok' ? 'text-ok' : t.tone === 'error' ? 'text-danger' : 'text-gold-700')} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{t.title}</p>
                {t.body && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{t.body}</p>}
              </div>
            </>
          )
          return (
            <div key={t.id} className="pointer-events-auto flex animate-rise items-start gap-2.5 rounded-lg border border-line bg-paper px-3.5 py-3 shadow-pop">
              {t.href ? (
                <Link to={t.href} className="flex flex-1 items-start gap-2.5" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
                  {content}
                </Link>
              ) : (
                content
              )}
              <button aria-label="Dismiss" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))} className="text-faint hover:text-ink">
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
