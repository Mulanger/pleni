import type { ReactNode } from "react";
import { ClerkProvider, useClerk, useSession, useUser } from "@clerk/react";
import { svSE } from "@clerk/localizations";

/**
 * Clerk configuration for the Pleni mobile app.
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

/**
 * Who the viewer is, and how to ask them to sign in — safe to call whether or
 * not Clerk is configured.
 *
 * `clerkEnabled` is derived from a `VITE_` constant, so it is fixed at build
 * time and cannot change between renders. That is what makes the branch below
 * legal despite looking like a conditional hook: for any given bundle exactly
 * one path is ever taken, so the hook order is stable for the app's lifetime.
 * Calling `useUser()` outside a `ClerkProvider` throws, which is why the branch
 * has to exist at all.
 *
 * A deploy without the key reports "not signed in" rather than crashing. That
 * keeps the anonymous feed working — the same property `AuthProvider` protects —
 * while making the library actions unavailable rather than silently anonymous.
 */
export function useViewer(): {
  signedIn: boolean;
  userId: string | null;
  suggestedUsername: string | null;
  getAccessToken: () => Promise<string | null>;
  requireSignIn: () => void;
} {
  if (!clerkEnabled) {
    return {
      signedIn: false,
      userId: null,
      suggestedUsername: null,
      getAccessToken: async () => null,
      requireSignIn: () => {}
    };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- build-time constant, see above.
  const { isSignedIn, user } = useUser();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- build-time constant, see above.
  const clerk = useClerk();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- build-time constant, see above.
  const { session } = useSession();

  return {
    signedIn: !!isSignedIn,
    userId: user?.id ?? null,
    // Only Clerk's explicit username is suggested. A full name or email local
    // part must never be turned into a public comment identity implicitly.
    suggestedUsername: user?.username ?? null,
    getAccessToken: async () => (await session?.getToken()) ?? null,
    requireSignIn: () => clerk.openSignIn({})
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!clerkEnabled) {
    if (import.meta.env.DEV) {
      console.warn(
        "[pleni] VITE_CLERK_PUBLISHABLE_KEY is not set — running without authentication."
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
