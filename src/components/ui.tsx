import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, Inbox, Loader2, Lock, RefreshCw, X } from 'lucide-react'
import { initials } from '@/lib/format'
import { ApiError } from '@/lib/api'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

// ───────── Buttons ─────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
const variants: Record<Variant, string> = {
  primary: 'bg-forest text-paper hover:bg-forest-600 active:bg-forest-700 shadow-soft',
  secondary: 'bg-paper text-ink border border-line-strong hover:border-ink-2/40 hover:bg-white',
  ghost: 'text-ink-2 hover:bg-porcelain hover:text-ink',
  quiet: 'text-forest hover:bg-forest-50',
  danger: 'bg-paper text-danger border border-danger/30 hover:bg-danger-bg',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-100 disabled:opacity-50 disabled:pointer-events-none select-none',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx('inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-porcelain hover:text-ink transition-colors', className)} {...rest}>
      {children}
    </button>
  )
}

// ───────── Form fields ─────────

/** Base control styles. Full width unless the caller sets an explicit width class. */
const controlCls = (className?: string) => (/(^|\s)!?(w-|max-w-|min-w-)/.test(className ?? '') ? control : `w-full ${control}`)
const control = 'rounded-md border border-line-strong bg-paper px-3 text-[13.5px] text-ink placeholder:text-faint transition-colors hover:border-ink-2/35 focus:border-forest focus:outline-none focus:ring-2 focus:ring-forest/15 disabled:bg-porcelain disabled:text-muted aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/10'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(controlCls(className), 'h-9', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={cx(controlCls(className), 'py-2 leading-relaxed resize-y', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(controlCls(className), 'h-9 pr-8 appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 fill=%27none%27 stroke=%27%23767a74%27 stroke-width=%271.6%27%3E%3Cpath d=%27M3 4.5l3 3 3-3%27/%3E%3C/svg%3E")] bg-[right_10px_center] bg-no-repeat', className)} {...rest}>
      {children}
    </select>
  )
})

export function Field({ label, hint, error, children, className, required, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string; required?: boolean; htmlFor?: string }) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-ink-2">
        {label}
        {required && <span className="text-gold-700"> *</span>}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  )
}

export function Checkbox({ label, description, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  const id = useId()
  return (
    <label htmlFor={id} className="flex items-start gap-2.5 cursor-pointer select-none">
      <input id={id} type="checkbox" className="mt-0.5 size-4 rounded border-line-strong accent-forest" {...rest} />
      <span>
        <span className="text-[13.5px] text-ink">{label}</span>
        {description && <span className="block text-[12px] text-muted">{description}</span>}
      </span>
    </label>
  )
}

// ───────── Display ─────────

export type Tone = 'neutral' | 'forest' | 'gold' | 'ok' | 'warn' | 'danger' | 'info' | 'outline'
const tones: Record<Tone, string> = {
  neutral: 'bg-porcelain text-ink-2',
  forest: 'bg-forest-100 text-forest-700',
  gold: 'bg-gold-100 text-gold-700',
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  outline: 'border border-line-strong text-ink-2',
}

export function Badge({ tone = 'neutral', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-[1px] text-[11.5px] font-medium leading-5 whitespace-nowrap', tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" aria-hidden />}
      {children}
    </span>
  )
}

export function SampleTag() {
  return (
    <Badge tone="outline" className="!text-[10px] uppercase tracking-wider font-mono">
      Sample
    </Badge>
  )
}

export function Progress({ value, tone = 'forest', className, label }: { value: number; tone?: 'forest' | 'gold' | 'danger'; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-sage', className)} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
      <div className={cx('h-full rounded-full transition-[width] duration-500', tone === 'gold' ? 'bg-gold' : tone === 'danger' ? 'bg-danger' : 'bg-forest')} style={{ width: `${v}%` }} />
    </div>
  )
}

export function Avatar({ name, color, size = 28, className }: { name?: string | null; color?: string | null; size?: number; className?: string }) {
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-medium text-paper ring-2 ring-paper', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: color ?? '#5B6B4E' }}
      title={name ?? undefined}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-paper px-1 font-mono text-[10.5px] text-muted">{children}</kbd>
}

// ───────── Layout primitives ─────────

export function PageHeader({ eyebrow, title, meta, actions, children }: { eyebrow?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 border-b border-line pb-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
          <h1 className="font-display text-[28px] leading-[1.15] font-[480] tracking-[-0.01em] text-ink" style={{ fontVariationSettings: '"opsz" 72' }}>
            {title}
          </h1>
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">{meta}</div>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  )
}

export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mb-8', className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            {title && <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-2">{title}</h2>}
            {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-lg border border-line bg-paper', className)}>{children}</div>
}

export function KeyValue({ items, cols = 2 }: { items: { label: ReactNode; value: ReactNode }[]; cols?: 1 | 2 | 3 | 4 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-3', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : cols === 3 ? 'grid-cols-2 lg:grid-cols-3' : 'grid-cols-2 lg:grid-cols-4')}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[11.5px] uppercase tracking-[0.06em] text-muted">{it.label}</dt>
          <dd className="mt-0.5 text-[13.5px] text-ink break-words">{it.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

/** An inline ledger of figures separated by hairlines — the house alternative to big metric cards. */
export function StatStrip({ stats }: { stats: { label: string; value: ReactNode; tone?: 'danger' | 'warn' | 'ok'; hint?: string; to?: string }[] }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-paper sm:grid-cols-3 lg:grid-flow-col lg:auto-cols-fr lg:grid-cols-none">
      {stats.map((s, i) => {
        const inner = (
          <>
            <div className="text-[11.5px] uppercase tracking-[0.07em] text-muted">{s.label}</div>
            <div className={cx('mt-1 font-display text-[26px] leading-none tabular', s.tone === 'danger' ? 'text-danger' : s.tone === 'warn' ? 'text-warn' : 'text-ink')} style={{ fontVariationSettings: '"opsz" 48' }}>
              {s.value ?? <span className="text-faint">—</span>}
            </div>
            {s.hint && <div className="mt-1 text-[11.5px] text-muted">{s.hint}</div>}
          </>
        )
        const cls = 'block border-line px-4 py-3.5 [&:not(:last-child)]:border-r border-b lg:border-b-0'
        return s.to ? (
          <Link key={i} to={s.to} className={cx(cls, 'hover:bg-ivory transition-colors')}>
            {inner}
          </Link>
        ) : (
          <div key={i} className={cls}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}

// ───────── States ─────────

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton h-4', className)} aria-hidden />
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-4 w-1/5" />
          <Skeleton className="h-4 w-1/6" />
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-paper/60 px-6 py-12 text-center">
      <div className="mb-3 text-faint">{icon ?? <Inbox className="size-7" strokeWidth={1.4} />}</div>
      <p className="font-medium text-ink">{title}</p>
      {body && <p className="mt-1 max-w-md text-[13px] text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const e = error instanceof ApiError ? error : null
  if (e?.status === 403) {
    return <EmptyState icon={<Lock className="size-7" strokeWidth={1.4} />} title="You don’t have access to this" body={e.message} />
  }
  if (e?.status === 404) {
    return <EmptyState title="Not found" body="It may have been removed, or you may not have access to it." action={<Link to="/" className="link">Back to overview</Link>} />
  }
  return (
    <div className="flex items-start gap-3 rounded-lg border border-danger/25 bg-danger-bg/60 px-4 py-3 text-[13px]" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="flex-1">
        <p className="font-medium text-danger">Couldn’t load this</p>
        <p className="text-ink-2">{e?.message ?? (error instanceof Error ? error.message : 'Unexpected error')}</p>
      </div>
      {retry && (
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  )
}

/** Uniform loading / error / empty handling for a query. */
export function QueryState<T>({ q, empty, children, skeleton }: { q: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown }; empty?: (d: T) => ReactNode | null; children: (d: T) => ReactNode; skeleton?: ReactNode }) {
  if (q.isLoading) return <>{skeleton ?? <SkeletonRows />}</>
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  if (q.data === undefined) return null
  const e = empty?.(q.data)
  if (e) return <>{e}</>
  return <>{children(q.data)}</>
}

// ───────── Dialog (native <dialog>: focus trap + Esc handled by the browser) ─────────

export function Dialog({ open, onClose, title, description, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      // showModal() focuses the first focusable element (the close button); prefer the form's intended field.
      const target = d.querySelector<HTMLElement>('[data-autofocus], [autofocus], input:not([type=hidden]):not([disabled]), textarea, select')
      target?.focus()
    }
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className="m-auto max-h-[88vh] w-[calc(100vw-32px)] overflow-visible rounded-lg bg-transparent p-0 open:animate-rise"
      style={{ maxWidth: width }}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-pop">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 className="font-display text-[19px] leading-tight text-ink">{title}</h2>
              {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
            </div>
            <IconButton label="Close" onClick={onClose} className="-mr-1.5 -mt-1">
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line bg-ivory/60 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  )
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13.5px] text-ink-2">{body}</div>
    </Dialog>
  )
}

// ───────── Tabs (URL-friendly, keyboard accessible) ─────────

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number | null }[] }) {
  return (
    <div role="tablist" className="no-print -mb-px flex gap-1 overflow-x-auto" onKeyDown={(e) => {
      const i = tabs.findIndex((t) => t.value === value)
      if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length]!.value)
      if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length]!.value)
    }}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
          className={cx(
            'relative whitespace-nowrap px-3 py-2.5 text-[13px] font-medium transition-colors',
            t.value === value ? 'text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-forest' : 'text-muted hover:text-ink',
          )}
        >
          {t.label}
          {t.count != null && t.count > 0 && <span className="ml-1.5 rounded bg-porcelain px-1 font-mono text-[10.5px] text-ink-2">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

// ───────── Table ─────────

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto rounded-lg border border-line bg-paper', className)}>
      <table className="w-full border-collapse text-left text-[13px]">{children}</table>
    </div>
  )
}
export function Th({ children, className, align }: { children?: ReactNode; className?: string; align?: 'right' | 'center' }) {
  return (
    <th scope="col" className={cx('border-b border-line bg-ivory/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted whitespace-nowrap', align === 'right' && 'text-right', align === 'center' && 'text-center', className)}>
      {children}
    </th>
  )
}
export function Td({ children, className, align, colSpan }: { children?: ReactNode; className?: string; align?: 'right' | 'center'; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cx('border-b border-line/70 px-3 py-2.5 align-middle', align === 'right' && 'text-right', align === 'center' && 'text-center', className)}>
      {children}
    </td>
  )
}
export const Tr = ({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) => (
  <tr onClick={onClick} className={cx('last:[&>td]:border-b-0 transition-colors', onClick && 'cursor-pointer hover:bg-ivory/80', className)}>
    {children}
  </tr>
)

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('size-4 animate-spin text-muted', className)} aria-label="Loading" />
}
