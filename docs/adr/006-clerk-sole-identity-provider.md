# ADR 006: Clerk as the sole identity provider

Date: 2026-08-02

## Status

Accepted

## Context

Prerequisites `A-1`, `A-3`, `A-4`, `A-5`, `A-7`, `A-9`.

Personalized ranking needs a stable subject to attach preferences and consent to.
Three options existed: Supabase Auth, Supabase anonymous Auth users, or a
third-party identity provider.

`docs/RECOMMENDATION_LAUNCH_PLAN.md` originally sketched Supabase anonymous Auth.
That was reconsidered: an anonymous Auth user is a persistent pseudonymous
account created without the person asking for one. For a service whose profile
data is political opinion under GDPR Article 9, silently minting an identity for
every visitor is the wrong default. It also needs its own abuse prevention and
cleanup story for accounts nobody wanted.

## Decision

**Identity is Clerk only**, wired into Supabase through the **native third-party
auth integration**.

1. Supabase Auth is not used as an identity provider. `supabase/config.toml` sets
   `[auth.email] enable_signup = false`.
2. There are no Supabase anonymous users. A logged-out visitor is genuinely
   anonymous: no account, no persistent subject, no viewer history (`T-5`).
3. **The deprecated Clerk "Supabase JWT template" must not be used.** It has been
   deprecated since 2025-04-01 and it works by handing the Supabase JWT signing
   secret to a third party — anyone holding that secret can mint a token for any
   user. The native integration instead has Supabase verify Clerk's RS256
   signatures against the Clerk JWKS, so no shared secret exists. If a future
   session finds the integration broken, the fix is never to reintroduce the
   template.
4. **Subject keys are `text`, not `uuid`** (`A-7`). Clerk user IDs look like
   `user_2abc…`. There is no `auth.users` table to reference and `auth.uid()`
   does not apply. Every private table keys on `clerk_user_id text` and RLS
   compares `(select auth.jwt()->>'sub')`.
5. **Signed out stays fully functional** (`A-9`). `Senaste` uses the publishable
   key and RLS-limited public reads. There is no sign-in wall. Besides being
   better product, this is what makes consent "freely given" — consent obtained
   by withholding the service is not consent.
6. Clerk is optional at runtime. `web/src/clerk.tsx` renders the app unwrapped
   when `VITE_CLERK_PUBLISHABLE_KEY` is absent, so a deploy that loses the env
   var degrades to the anonymous feed instead of taking the site down.
7. Auth UI uses `mode="modal"`. The InstaPods static host serves the pod root
   with no SPA fallback, so a redirect route such as `/sign-in` would 404
   (`N-4`). Modal flows sidestep the problem rather than depending on host
   configuration nobody controls from this repo.

## Consequences

A third processor joins the data-flow inventory, almost certainly with a US
transfer to assess (`F0-4`, `F0-5`). Clerk MAU pricing plus Supabase third-party
MAU charges become a real cost line (`A-17`).

The production launch is gated on DNS. A Clerk production instance requires CNAME
records on a domain we control, and `rikettv.nbg1-3.instapods.app` is not one
(`A-2`). Development instances work on any origin, so everything else in Block A
can be built in parallel — but production cannot ship until a domain exists.

Deleting a user in Clerk must cascade into our data. That is a webhook we have to
build and Svix-verify, not something the integration does for us (`A-14`).

The `role: authenticated` claim comes from Clerk's Supabase integration being
enabled in the Clerk dashboard. That is dashboard state, which drifts and is
invisible in review, so `supabase/config.toml` and migration 003's `auth_probe()`
exist to make the configuration reproducible and testable.

## Contracts Impact

None.
