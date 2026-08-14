import assert from "node:assert/strict";
import test from "node:test";

import { ClerkAuthError, clearJwksCache, verifyClerkJwt } from "../_shared/jwt.ts";

const ISSUER = "https://clerk.example.test";
const ORIGIN = "https://pleni.se";
const NOW = 1_786_700_000;

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keyPair(kid: string): Promise<{ privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid: string };
  jwk.kid = kid;
  return { privateKey: pair.privateKey, jwk };
}

async function token(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  kid = "test-key"
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = base64Url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(signingInput)
    )
  );
  return `${signingInput}.${base64Url(signature)}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "user_test",
    iss: ISSUER,
    azp: ORIGIN,
    role: "authenticated",
    nbf: NOW - 5,
    exp: NOW + 60,
    ...overrides
  };
}

function fetcher(jwk: JsonWebKey): typeof fetch {
  return (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;
}

test("verifies RS256 signature, issuer, expiry and authorized party", async () => {
  clearJwksCache();
  const pair = await keyPair("test-key");
  const verified = await verifyClerkJwt(await token(pair.privateKey, claims()), {
    issuers: new Set([ISSUER]),
    authorizedParties: new Set([ORIGIN]),
    fetcher: fetcher(pair.jwk),
    nowSeconds: NOW
  });
  assert.equal(verified.sub, "user_test");
  assert.equal(verified.role, "authenticated");
});

test("rejects a token signed by the wrong key", async () => {
  clearJwksCache();
  const trusted = await keyPair("test-key");
  const attacker = await keyPair("test-key");
  await assert.rejects(
    verifyClerkJwt(await token(attacker.privateKey, claims()), {
      issuers: new Set([ISSUER]),
      authorizedParties: new Set([ORIGIN]),
      fetcher: fetcher(trusted.jwk),
      nowSeconds: NOW
    }),
    (error: unknown) => error instanceof ClerkAuthError && error.code === "invalid_signature"
  );
});

test("refreshes a warm JWKS cache once when Clerk rotates signing keys", async () => {
  clearJwksCache();
  const oldPair = await keyPair("old-key");
  const newPair = await keyPair("new-key");
  let activeJwk = oldPair.jwk;
  let fetchCount = 0;
  const rotatingFetcher = (async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ keys: [activeJwk] }), { status: 200 });
  }) as typeof fetch;

  await verifyClerkJwt(await token(oldPair.privateKey, claims(), "old-key"), {
    issuers: new Set([ISSUER]),
    authorizedParties: new Set([ORIGIN]),
    fetcher: rotatingFetcher,
    nowSeconds: NOW
  });
  activeJwk = newPair.jwk;
  await verifyClerkJwt(await token(newPair.privateKey, claims(), "new-key"), {
    issuers: new Set([ISSUER]),
    authorizedParties: new Set([ORIGIN]),
    fetcher: rotatingFetcher,
    nowSeconds: NOW
  });

  assert.equal(fetchCount, 2);
});

for (const [name, override, expected] of [
  ["expired token", { exp: NOW - 10 }, "expired_token"],
  ["unknown issuer", { iss: "https://attacker.test" }, "unknown_issuer"],
  ["wrong authorized party", { azp: "https://evil.test" }, "wrong_authorized_party"]
] as const) {
  test(`rejects ${name}`, async () => {
    clearJwksCache();
    const pair = await keyPair("test-key");
    await assert.rejects(
      verifyClerkJwt(await token(pair.privateKey, claims(override)), {
        issuers: new Set([ISSUER]),
        authorizedParties: new Set([ORIGIN]),
        fetcher: fetcher(pair.jwk),
        nowSeconds: NOW
      }),
      (error: unknown) => error instanceof ClerkAuthError && error.code === expected
    );
  });
}
