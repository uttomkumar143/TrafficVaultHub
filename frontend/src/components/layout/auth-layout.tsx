import type { ReactNode } from "react";
import { Link } from "react-router";

interface AuthLayoutProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Secondary links rendered under the card (e.g. "Create an account"). */
  footer?: ReactNode;
}

/** Centered single-card layout shared by every public auth page. */
export function AuthLayout({ title, description, children, footer }: AuthLayoutProps) {
  return (
    <section id="auth-section" className="mx-auto w-full max-w-md space-y-6">
      <header className="space-y-2 text-center">
        <Link to="/" className="text-sm font-semibold tracking-tight text-muted-foreground">
          TrafficVaultHub
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </header>
      <div className="rounded-lg border bg-card p-6 shadow-xs">{children}</div>
      {footer ? <footer className="text-center text-sm text-muted-foreground">{footer}</footer> : null}
    </section>
  );
}
