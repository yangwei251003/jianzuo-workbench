import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { CheckCircle, Info, SpinnerGap, Warning, WarningCircle } from "@phosphor-icons/react";

export function Button({ children, variant = "primary", size = "normal", loading, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "small" | "normal" | "large";
  loading?: boolean;
}) {
  return <button className={`button button-${variant} button-${size} ${className}`} disabled={loading || props.disabled} {...props}>
    {loading && <SpinnerGap className="spin" size={17} aria-hidden="true" />}{children}
  </button>;
}

export function StatusPill({ children, tone = "neutral", dot = true }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "blue"; dot?: boolean }) {
  return <span className={`status-pill status-${tone}`}>{dot && <span className="status-dot" />}{children}</span>;
}

export function Panel({ children, className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`panel ${className}`} {...props}>{children}</section>;
}

export function SectionHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="section-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="section-actions">{actions}</div>}</div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function InlineAlert({ children, tone = "info", title }: { children: ReactNode; tone?: "info" | "warning" | "danger" | "success"; title?: string }) {
  const Icon = tone === "danger" ? WarningCircle : tone === "warning" ? Warning : tone === "success" ? CheckCircle : Info;
  return <div className={`inline-alert alert-${tone}`} role={tone === "danger" ? "alert" : "status"}><Icon size={19} weight="fill" /><div>{title && <strong>{title}</strong>}<span>{children}</span></div></div>;
}

export function Spinner({ size = 20 }: { size?: number }) { return <SpinnerGap className="spin" size={size} aria-label="加载中" />; }

export function LoadingState({ label = "正在读取" }: { label?: string }) {
  return <div className="state-block"><Spinner size={24} /><p>{label}</p></div>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="state-block empty-state"><div className="empty-line" /><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="state-block error-state"><WarningCircle size={28} /><h3>没有完成读取</h3><p>{message}</p>{retry && <Button variant="secondary" onClick={retry}>重试</Button>}</div>;
}

export function Metric({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: string; tone?: "default" | "price" | "danger" | "success" }) {
  return <div className={`metric metric-${tone}`}><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>{options.map((option) => <button key={option.value} className={option.value === value ? "active" : ""} onClick={() => onChange(option.value)} type="button">{option.label}</button>)}</div>;
}

export function ProgressBar({ value, max = 100, label }: { value: number; max?: number; label?: string }) {
  const percent = Math.max(0, Math.min(100, max ? value / max * 100 : 0));
  return <div className="progress-wrap">{label && <span>{label}</span>}<div className="progress" role="progressbar" aria-valuenow={value} aria-valuemax={max}><div style={{ width: `${percent}%` }} /></div></div>;
}

