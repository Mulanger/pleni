import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { AlertCircle, ChevronLeft, Home, LoaderCircle } from "lucide-react";

export function DesktopRouteFrame({
  focusKey,
  children
}: {
  focusKey: string;
  children: ReactNode;
}) {
  const routeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    routeRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  return (
    <div ref={routeRef} className="desktop-route-frame" tabIndex={-1} data-route-key={focusKey}>
      {children}
    </div>
  );
}

export function DesktopPage({
  eyebrow,
  title,
  description,
  backLabel,
  onBack,
  children
}: {
  eyebrow: string;
  title: string;
  description?: string;
  backLabel?: string;
  onBack?: () => void;
  children?: ReactNode;
}) {
  const headingId = useId();

  return (
    <section className="desktop-page" aria-labelledby={headingId}>
      <DesktopPageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        backLabel={backLabel}
        onBack={onBack}
        headingId={headingId}
      />
      {children}
    </section>
  );
}

export function DesktopPageHeader({
  eyebrow,
  title,
  description,
  backLabel,
  onBack,
  headingId
}: {
  eyebrow: string;
  title: string;
  description?: string;
  backLabel?: string;
  onBack?: () => void;
  headingId?: string;
}) {
  return (
    <header className="desktop-page-header">
      {onBack && (
        <button className="desktop-back-action" type="button" onClick={onBack}>
          {backLabel === "Till videoflödet" ? <Home size={17} /> : <ChevronLeft size={18} />}
          <span>{backLabel ?? "Tillbaka"}</span>
        </button>
      )}
      <span className="desktop-page-eyebrow">{eyebrow}</span>
      <h1 id={headingId}>{title}</h1>
      {description && <p>{description}</p>}
    </header>
  );
}

export function DesktopSection({
  title,
  description,
  children
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="desktop-section">
      {(title || description) && (
        <div className="desktop-section-heading">
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

export function DesktopState({
  kind,
  title,
  detail,
  action
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className={`desktop-state desktop-state--${kind}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "loading" ? (
        <LoaderCircle className="desktop-state-spinner" size={20} aria-hidden="true" />
      ) : kind === "error" ? (
        <AlertCircle size={20} aria-hidden="true" />
      ) : null}
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </div>
  );
}
