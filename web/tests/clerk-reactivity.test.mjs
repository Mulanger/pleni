import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SIGNED_OUT_VIEWER,
  nextViewerIdentity
} from "../src/auth/viewer-identity.ts";

const clerk = await readFile(new URL("../src/clerk.tsx", import.meta.url), "utf8");

test("account UI subscribes to settled Clerk session changes", () => {
  assert.match(
    clerk,
    /nextViewerIdentity\(SIGNED_OUT_VIEWER, clerk\.user, clerk\.session\)/
  );
  assert.match(clerk, /clerk\.addListener\(\(\{ user, session \}\) =>/);
  assert.match(clerk, /nextViewerIdentity\(current, user, session\)/);
  assert.match(clerk, /return clerk\.addListener/);
});

test("viewer state and tokens use the current Clerk client resources", () => {
  assert.match(clerk, /signedIn: identity\.signedIn/);
  assert.match(clerk, /userId: identity\.userId/);
  assert.match(clerk, /clerk\.session\?\.getToken\(\)/);
  assert.doesNotMatch(clerk, /signedIn: !!isSignedIn/);
});

test("profile account content follows the same reactive viewer state", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<ProfileScreen\s+[\s\S]*?signedIn=\{viewer\.signedIn\}/);
  assert.match(app, /<AccountCard signedIn=\{signedIn\}/);
  assert.match(app, /if \(signedIn\) \{\s+return <SignedInAccountCard/);
  assert.doesNotMatch(app, /<Show when="signed-(?:in|out)">/);
});

test("viewer identity stays settled through loading, sign-in and sign-out", () => {
  const loading = nextViewerIdentity(SIGNED_OUT_VIEWER, undefined, undefined);
  assert.equal(loading, SIGNED_OUT_VIEWER);

  const signedIn = nextViewerIdentity(
    loading,
    {
      id: "user_pleni",
      username: "pleni",
      createdAt: new Date("2026-09-03T12:00:00Z"),
      lastSignInAt: new Date("2026-09-03T12:00:01Z")
    },
    { id: "session_pleni" }
  );
  assert.deepEqual(signedIn, {
    signedIn: true,
    userId: "user_pleni",
    createdAt: Date.parse("2026-09-03T12:00:00Z"),
    lastSignInAt: Date.parse("2026-09-03T12:00:01Z"),
    suggestedUsername: "pleni"
  });

  assert.equal(nextViewerIdentity(signedIn, undefined, undefined), signedIn);
  assert.equal(nextViewerIdentity(signedIn, null, null), SIGNED_OUT_VIEWER);
});
