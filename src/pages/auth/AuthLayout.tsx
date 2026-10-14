import type { ReactNode } from 'react'

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-ivory lg:grid-cols-[minmax(380px,0.9fr)_1.1fr]">
      <aside className="relative hidden overflow-hidden bg-forest-700 p-10 text-paper lg:flex lg:flex-col">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-[6px] bg-gold font-display text-lg font-semibold text-forest-700">X</span>
          <div className="leading-tight">
            <div className="font-display text-lg">Visionary X</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#9db3a5]">Operations</div>
          </div>
        </div>
        <div className="mt-auto max-w-sm">
          <div className="mb-5 h-px w-16 bg-gold" />
          <p className="font-display text-[26px] leading-snug text-paper" style={{ fontVariationSettings: '"opsz" 72' }}>
            Clients, delivery and people — in one ledger the whole company trusts.
          </p>
          <p className="mt-4 text-[13px] text-[#a9bcb0]">Internal workspace. Access is limited to Visionary X staff and is monitored.</p>
        </div>
        <svg className="pointer-events-none absolute -right-24 -top-24 size-[420px] opacity-[0.07]" viewBox="0 0 100 100" aria-hidden>
          <path d="M10 10 L90 90 M90 10 L10 90" stroke="#b39556" strokeWidth="6" strokeLinecap="round" />
        </svg>
      </aside>
      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-[5px] bg-forest font-display text-paper">X</span>
            <span className="font-display text-lg">Visionary X</span>
          </div>
          <h1 className="font-display text-[30px] leading-tight text-ink" style={{ fontVariationSettings: '"opsz" 72' }}>{title}</h1>
          {subtitle && <p className="mt-2 text-[13.5px] text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 border-t border-line pt-5 text-[13px] text-muted">{footer}</div>}
        </div>
      </div>
    </div>
  )
}
