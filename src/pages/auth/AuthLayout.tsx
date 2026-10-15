import type { ReactNode } from 'react'
import { BrandLockup, BrandMark } from '@/components/ui'

/** Sign-in family layout, echoing the visionary-x.in hero: carbon, star field, bold uppercase type with an outlined line. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[1.1fr_minmax(400px,0.9fr)]">
      <aside className="starfield relative hidden overflow-hidden border-r border-line p-10 lg:flex lg:flex-col">
        <BrandLockup size={34} sub="Operations" />
        <div className="mt-auto">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-line-strong px-3 py-1 text-[10.5px] font-medium uppercase tracking-[0.2em] text-ink-2">
            <span className="size-1.5 rounded-full bg-ink" /> Internal workspace
          </div>
          <p className="display text-[64px] text-ink xl:text-[84px]">
            Run the
            <br />
            <span className="outline-text">mission</span>
            <br />
            control.
          </p>
          <p className="mt-6 max-w-sm text-[14px] text-ink-2">Clients, projects, people and delivery — one place the whole crew works from. Access is limited to Visionary X staff and is monitored.</p>
        </div>
        <div className="pointer-events-none absolute right-10 top-20 opacity-90">
          <BrandMark size={240} />
        </div>
      </aside>
      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-10 lg:hidden">
            <BrandLockup size={32} sub="Operations" />
          </div>
          <h1 className="display text-[34px] text-ink">{title}</h1>
          {subtitle && <p className="mt-3 text-[13.5px] text-ink-2">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 border-t border-line pt-5 text-[13px] text-muted">{footer}</div>}
        </div>
      </div>
    </div>
  )
}
