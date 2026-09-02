# UI17 desktop feed

## Product decision

Pleni desktop is a calm parliamentary video workspace: the existing vertical
clip is the visual anchor, navigation is navy on a warm light surface, and a
single inspector supplies context. The approved visual reference is
`docs/mockups/pleni-desktop-feed-v1.png`.

The media contract does not change. Desktop uses the published 540×960 MP4 at
exactly 9:16, with no crop, upscale-specific rendition or backfill.

## Responsive contract

- 0–699 px: the released mobile app and bottom navigation.
- 700–1099 px: the existing honest “open on mobile” gate.
- 1100 px and wider: desktop shell and desktop Home feed.
- Desktop Följer, Sök and Profil keep their routes but show honest waiting
  screens. Their mobile versions remain complete and unchanged.

Only one app surface and one `FeedScreen` are mounted at a time. Crossing a
breakpoint therefore invokes the existing media cleanup before another surface
can play.

## Desktop interaction

The feed retains autoplay fallback, visibility pausing, progress seeking,
one-clip snap and its four-source media ceiling. Arrow buttons, Arrow Up/Down
and Page Up/Down settle exactly one adjacent clip. The action rail carries no
fabricated counts.

The right inspector shows the active speaker, title, transcript excerpt,
debate date and Riksdagen source. Comments replace that inspector rather than
opening a desktop modal; video resumes only when it was playing before comments
opened. Escape closes comments.

Migration 031 appends source identity and master chronology to the existing
security-invoker catalogue view. Related cards load public, published,
non-rejected clips from that source. Selecting one enters a same-debate feed;
Back restores the former main-feed clip.

## Release order

1. Run all local frontend, migration and project acceptance checks.
2. Apply migration 031 and verify anonymous catalogue reads and ordering.
3. Deploy the backward-compatible `feed-requests` Function so personalised
   rows carry `sourceId` too.
4. Deploy the frontend from `main` through InstaPods.
5. Smoke-test 1100×720, 1280×720, 1440×900 and 1920×1080 plus mobile
   360×800 and 390×844.
6. Roll back frontend first if needed; the additive read-only columns may stay
   until the frontend is safely reverted.
