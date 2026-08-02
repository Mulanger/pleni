# Riket TV Web

Mobile-only React frontend for the published Riket TV clip feed.

## Local

```powershell
npm ci
npm run dev
```

## Build

```powershell
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
```

## InstaPods

Use this directory as the app root.

- Build command: `npm ci && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ./node_modules/vite/bin/vite.js build`
- Output directory: `dist`
- Runtime: static React/Vite

Configure these environment variables in InstaPods:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Only the Supabase publishable key belongs in this frontend. Bunny URLs are read from Supabase clip metadata.
