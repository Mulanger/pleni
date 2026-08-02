# Riket TV Web

Mobile-only React frontend for the published Riket TV clip feed.

## Local

```powershell
npm ci
node .\node_modules\vite\bin\vite.js --host 127.0.0.1 --port 5199 --strictPort
```

## Build

```powershell
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
```

## InstaPods

The current pod deploy runs from the repository root, not this directory, because InstaPods ignored the subdirectory setting during dependency installation in testing.

- Install command: `cd web && npm ci`
- Build command: `cd web && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ./node_modules/vite/bin/vite.js build && cd .. && rm -rf ./assets ./index.html ./dist && cp -R web/dist/. ./`
- Runtime: static React/Vite

Configure these environment variables in InstaPods:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Only the Supabase publishable key belongs in this frontend. Bunny URLs are read from Supabase clip metadata.
