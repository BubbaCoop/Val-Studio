import type { ReactNode } from "react";

export function Panel({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`border border-line bg-panel ${className}`}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-2">
          <h2 className="text-xs font-semibold tracking-[0.08em] text-ink-2 uppercase">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({
  children, onClick, kind = "secondary", disabled, title, type = "button",
}: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean; title?: string; type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-ink text-white border-ink hover:opacity-90",
    secondary: "bg-panel text-ink border-line hover:bg-ground",
    danger: "bg-blocking text-white border-blocking hover:opacity-90",
  }[kind];
  return (
    <button
      type={type} onClick={onClick} disabled={disabled} title={title}
      className={`border px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "blocking" | "draft" | "ok" }) {
  const tones = {
    neutral: "border-line bg-ground text-ink-2",
    blocking: "border-blocking/40 bg-blocking/10 text-blocking",
    draft: "border-draft/40 bg-draft/10 text-draft",
    ok: "border-ok/40 bg-ok/10 text-ok",
  }[tone];
  return <span className={`inline-block border px-1.5 py-0.5 font-mono text-[10px] leading-none ${tones}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-ink-3">{children}</p>;
}

/**
 * A failure the user has to see.
 *
 * Studio's rule is that nothing fails quietly: an unreachable backend, an unreadable
 * config, a dropped event stream, a refused write. Each of those used to leave a
 * screen sitting on a spinner or an empty list, which is indistinguishable from a
 * pipeline that is simply taking its time.
 */
export function Banner({ title, children, tone = "blocking" }: { title: string; children: ReactNode; tone?: "blocking" | "draft" }) {
  const tones = {
    blocking: "border-blocking bg-blocking/5 text-blocking",
    draft: "border-draft bg-draft/5 text-draft",
  }[tone];
  return (
    <div className={`border-l-2 border ${tones} p-3`}>
      <p className="text-xs font-semibold">{title}</p>
      <div className="mt-1 text-xs text-ink-2">{children}</div>
    </div>
  );
}

/** Monospace, pre-wrapped, verbatim. Used wherever the pipeline's own words are shown. */
export function Verbatim({ text }: { text: string }) {
  return <pre className="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">{text}</pre>;
}
