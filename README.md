# riketTV

Riket TV is a local-first pipeline and mobile web app for turning Swedish parliamentary debate videos into vertical short-form clips.

The Python worker in `src/` processes and publishes clips to Bunny + Supabase. The public React app lives in `web/` and is intended for InstaPods deployment.

## Web App

```powershell
cd web
npm ci
node .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json
node .\node_modules\vite\bin\vite.js build
```

Current InstaPods Git deploy runs from the repository root. Use:

- Install: `cd web && npm ci`
- Build: `cd web && node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && node ./node_modules/vite/bin/vite.js build && cd .. && rm -rf ./assets ./index.html ./dist && cp -R web/dist/. ./`

The final copy step is required because the static host serves the pod root.
