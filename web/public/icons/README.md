# Pleni launcher icons

`../favicon.svg` is the canonical Pleni mark. Launcher exports use its black
symbol, blue dot and warm-white field.

- `icon-192.png` and `icon-512.png` are full-field `any` launcher exports.
- `icon-maskable-512.png` uses `icon-maskable-source.svg`; the symbol is scaled
  into the central maskable safe zone and the background reaches every edge.
- `apple-touch-icon.png` is the full-field 180×180 Apple launcher export. iOS
  applies the platform corner mask.

PNG exports are RGBA, rendered with 4× antialiasing, and use these exact colors:

- field: `#fafaf9`
- symbol: `#18181b`
- accent: `#4664e6`

Do not add baked-in platform corner masks to the maskable or Apple exports.
