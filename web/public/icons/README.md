# Pleni brand and launcher icons

The original supplied Pleni artwork is stored at `../brand/pleni-logo.png`.
The edge-to-edge icon master is `../brand/pleni-logo-edge-20260812.png`; use it
for future launcher and favicon exports so white canvas padding is not
reintroduced.

The launcher and browser exports came from the supplied favicon package:

- `pleni-icon-192-20260812b.png` and `pleni-icon-512-20260812b.png` are the
  Android/PWA launcher icons.
- `pleni-icon-maskable-512-20260812b.png` uses the same centred P over a blue
  field that reaches every edge; the P remains inside the maskable safe zone.
- `pleni-apple-touch-icon-20260812b.png` is the 180 px Apple home-screen icon.
- `../favicon-20260812b.ico`, `../favicon-32-20260812b.png` and
  `../favicon-16-20260812b.png` are the browser favicon variants.

Do not replace these with the former black-T placeholder or add another
platform corner mask to the supplied artwork. When the artwork changes, publish
new versioned filenames and update the manifest; installed browsers treat an
unchanged icon URL as unchanged artwork.
