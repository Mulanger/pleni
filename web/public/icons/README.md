# Pleni brand and launcher icons

The supplied full-resolution Pleni artwork is stored at
`../brand/pleni-logo.png`. Keep that file as the canonical source for future
store listings, download pages and marketing exports.

The launcher and browser exports came from the supplied favicon package:

- `pleni-icon-192-20260812.png` and `pleni-icon-512-20260812.png` are the
  Android/PWA launcher icons.
- `pleni-icon-maskable-512-20260812.png` uses the same safe-margin 512 px
  artwork and is the manifest's maskable icon.
- `pleni-apple-touch-icon-20260812.png` is the 180 px Apple home-screen icon.
- `../favicon.ico`, `../favicon-32x32.png` and `../favicon-16x16.png` are the
  browser favicon variants.

Do not replace these with the former black-T placeholder or add another
platform corner mask to the supplied artwork. When the artwork changes, publish
new versioned filenames and update the manifest; installed browsers treat an
unchanged icon URL as unchanged artwork.
