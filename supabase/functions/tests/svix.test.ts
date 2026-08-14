import assert from "node:assert/strict";
import test from "node:test";

import { verifySvixSignature } from "../_shared/svix.ts";

const SECRET_BYTES = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
let binary = "";
for (const byte of SECRET_BYTES) binary += String.fromCharCode(byte);
const SECRET = `whsec_${btoa(binary)}`;
const NOW = 1_786_700_000;

async function signedHeaders(body: string, timestamp = NOW): Promise<Headers> {
  const id = "msg_test";
  const key = await crypto.subtle.importKey(
    "raw",
    SECRET_BYTES,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  );
  let signatureBinary = "";
  for (const byte of signature) signatureBinary += String.fromCharCode(byte);
  return new Headers({
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${btoa(signatureBinary)}`
  });
}

test("accepts a current correctly signed Clerk webhook", async () => {
  const body = JSON.stringify({ type: "user.deleted", data: { id: "user_test" } });
  await verifySvixSignature(await signedHeaders(body), body, SECRET, NOW);
});

test("rejects a tampered webhook body", async () => {
  const body = JSON.stringify({ type: "user.deleted", data: { id: "user_test" } });
  await assert.rejects(
    verifySvixSignature(await signedHeaders(body), `${body} `, SECRET, NOW),
    /invalid_webhook_signature/
  );
});

test("rejects a stale webhook", async () => {
  const body = "{}";
  await assert.rejects(
    verifySvixSignature(await signedHeaders(body, NOW - 301), body, SECRET, NOW),
    /invalid_webhook_timestamp/
  );
});
