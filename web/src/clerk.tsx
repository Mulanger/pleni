import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/react";
import { svSE } from "@clerk/localizations";

/**
 * Clerk configuration for the Riket TV mobile app.
 *
 * The publishable key is public by design and is the only Clerk credential that
 * may appear in a Vite build. The secret key belongs to server-side code only —
 * never in a `VITE_*` variable.
 *
 * Clerk is treated as optional at runtime. If `VITE_CLERK_PUBLISHABLE_KEY` is
 * absent the app still renders and the anonymous `Senaste` feed still works;
 * only the account surfaces are hidden. That keeps a deploy without the env var
 * from taking the public site down.
 */
export const CLERK_PUBLISHABLE_KEY = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "").trim();

export const clerkEnabled = CLERK_PUBLISHABLE_KEY.length > 0;

/** Dark appearance tuned for the full-bleed mobile feed. */
const appearance = {
  variables: {
    colorPrimary: "#1f2937",
    colorText: "#111827",
    borderRadius: "14px",
    fontFamily: "inherit"
  }
} as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!clerkEnabled) {
    if (import.meta.env.DEV) {
      console.warn(
        "[riket] VITE_CLERK_PUBLISHABLE_KEY is not set — running without authentication."
      );
    }
    return <>{children}</>;
  }

  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      localization={svSE}
      appearance={appearance}
      afterSignOutUrl="/"
    >
      {children}
    </ClerkProvider>
  );
}
