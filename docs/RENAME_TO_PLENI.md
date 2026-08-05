# Renaming Riket → Pleni: where the name actually lives

**Written:** 2026-08-05 · **Audience:** an agent with browser control, plus whoever
does the in-repo half.

The project is now **Pleni** (`pleni.se`). The old name **Riket / RiketTV** is
still baked into hostnames, dashboard labels, env vars and UI strings. Not all
of them are safe to change.

---

## Rule 0 — read this before touching any dashboard

Some of these names are **load-bearing infrastructure identifiers**, not labels.
Renaming them breaks live URLs that 1,762 published clips depend on. The table
below separates them. **If a row says DO NOT RENAME, do not rename it**, even
though the string clearly says "riket".

| # | Where | Current value | Verdict |
|---|---|---|---|
| 1 | Bunny storage + pull zone | `riketnlooigm` | 🔴 **DO NOT RENAME** |
| 2 | InstaPods pod | `rikettv` | 🟠 **LEAVE FOR NOW** |
| 3 | Supabase project ref | `nlooigmwuqqhhnontlgp` | ⚪ Cannot be renamed (no "riket" in it) |
| 4 | Supabase project *display name* | check dashboard | 🟢 Safe |
| 5 | Clerk application name | `RiketTV` | 🟢 Safe |
| 6 | GitHub repo | `Mulanger/riketTV` | 🟢 Safe, with follow-ups |

---

## 🔴 1. Bunny CDN zone `riketnlooigm` — DO NOT RENAME

The public CDN host is `https://riketnlooigm.b-cdn.net`. Verified against the
live database on 2026-08-05:

```
total clips: 1762 | url_540x960 containing 'riketnlooigm': 1762
                  | thumb_url    containing 'riketnlooigm': 1762
```

**3,524 absolute URLs** stored in `public.clips` point at that hostname.
Renaming the zone 404s every video and every thumbnail in the app
simultaneously. There is no redirect.

Changing it later is a real project: rename the zone, then rewrite both URL
columns across 1,762 rows, then re-verify CDN reachability. It is not a
dashboard rename. **Skip it.**

---

## 🟠 2. InstaPods pod `rikettv` — leave until someone plans it

Pod hostname `rikettv.nbg1-3.instapods.app`. As of today **that hostname is the
DNS target for the live domain**:

```
ALIAS  pleni.se  →  rikettv.nbg1-3.instapods.app
CNAME  www       →  rikettv.nbg1-3.instapods.app
```

Renaming the pod changes its hostname and instantly breaks both records, taking
`pleni.se` down until the DNS is re-pointed and re-propagated. It is *possible*
safely — rename, then immediately update both records at Simply, then re-verify
in InstaPods → Domains — but it is a coordinated change with downtime, not a
label edit. **Do not do it as part of a naming sweep.**

Note the deploy URL `rikettv.nbg1-3.instapods.app` is not user-facing any more;
visitors use `pleni.se`. The cosmetic win is small and the risk is not.

---

## 🟢 3–6. Safe dashboard renames — this is the browser agent's job

### Supabase — https://supabase.com/dashboard
Project ref `nlooigmwuqqhhnontlgp` is **permanent** and appears in
`VITE_SUPABASE_URL` and every API call. It contains no "riket", so nothing to do
there.

- **Settings → General → Project name** — if it reads "Riket"/"RiketTV", change
  to **Pleni**. Purely a display label. Safe.

### Clerk — https://dashboard.clerk.com
- **Application name** is currently **RiketTV** → change to **Pleni**.
  It appears on the hosted sign-in UI, so it is worth doing.
- **Do not** try to change the development instance domain
  `leading-seasnail-33.clerk.accounts.dev` — Clerk generates it and it is not
  editable. It disappears when the production instance on `pleni.se` is created,
  which is separate work (prerequisite `A-2`).

### GitHub — https://github.com/Mulanger/riketTV
- **Settings → Repository name** → `pleni` (or `pleni.se`). GitHub keeps
  redirects from the old URL, so this is low risk.
- **Two follow-ups the rename does not do for you:**
  1. Local clone still points at the old remote:
     `git remote set-url origin https://github.com/Mulanger/pleni.git`
  2. **InstaPods → Git** — confirm the connected repository still resolves after
     the rename and that auto-deploy from `origin/main` still fires. Re-link if
     the integration stored the old name. Verify by pushing a commit and
     watching for a new deployment.

---

## In-repo changes — NOT browser work

A browser agent cannot do these. They are code edits, and several are traps.

### ⚠️ The one that silently destroys user data

```
web/src/library-store.ts:26   const KEY = "riket.library.v1";
web/src/onboarding-store.ts:23 const KEY = "riket.onboarding.v1";
```

These are `localStorage` keys holding every viewer's **follows, saved clips,
likes, party choices and consent answers**. Renaming the key does not migrate
the data — it orphans it. Every existing user silently loses their library and
gets the onboarding flow again, including their consent state resetting to
off.

**Either leave these keys alone, or write a migration** that reads the old key,
writes the new one and deletes the old, on first load. The `.v1` suffix is a
version, not a brand.

### User-visible strings (safe, and worth doing)

| File | Line | Current |
|---|---|---|
| `web/index.html` | 8 | `<title>Riket TV</title>` |
| `web/src/App.tsx` | 333 | `aria-label="Riket TV"` |
| `web/src/App.tsx` | 421 | `<div className="wide-kicker">Riket TV</div>` |
| `web/src/App.tsx` | 1407 | `Kammaren 1.0 · data från riksdagen.se` |
| `web/src/onboarding.tsx` | 105 | `<h2>Välkommen till Kammaren</h2>` |
| `web/package.json` | 2 | `"name": "rikettv-web"` |

Note two of these say **"Kammaren"**, not "Riket" — an even older name still
shipping in the onboarding flow and the version footer. A grep for "riket"
alone will miss them.

### Env vars — one line, ~60 references

Every setting is prefixed `RIKET_` (`RIKET_SUPABASE_SECRET_KEY`,
`RIKET_BUNNY_API_KEY`, `RIKET_WORK_DIR`, …). The prefix is defined once:

```
src/config.py:19   model_config = SettingsConfigDict(env_prefix="RIKET_", …)
```

Changing that one line renames all of them at once — but then **every `.env`,
every CI secret and the InstaPods env panel must change in the same commit**, or
the pipeline silently falls back to defaults. `RIKET_SUPABASE_SECRET_KEY` going
missing is the exact failure that downgraded publishing to the Management API
and produced HTTP 413s during the March backfill.

Low value, real risk. **Recommend leaving the prefix alone** unless someone
wants it badly.

### Docs and repo directory

`AGENTS.md`, `docs/*`, `PROGRESS.md` and the local folder name
`C:\Users\Mulen\Desktop\riket.se` all say Riket. Harmless. Rename the docs
opportunistically; renaming the working directory will break the InstaPods
local paths and any absolute path in `.env` (`RIKET_WORK_DIR=D:/riketvideos`).

---

## Suggested order

1. **Clerk** application name → Pleni.
2. **Supabase** project display name → Pleni.
3. **GitHub** repo rename → then fix the git remote → then confirm InstaPods
   auto-deploy still works.
4. **In-repo UI strings** (`index.html`, `App.tsx`, `onboarding.tsx`,
   `package.json`) in one commit, deployed and eyeballed on `pleni.se`.
5. Stop. Leave Bunny, the pod name, the `RIKET_` prefix and the localStorage
   keys.

## Verification after any change

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://pleni.se/
curl -s https://pleni.se/ | grep -oE "<title>[^<]*</title>"
```

Then open `https://pleni.se`, confirm clips still play (that proves the Bunny
URLs are intact) and that your follows/saved clips are still there (that proves
the localStorage keys were not changed out from under you).
