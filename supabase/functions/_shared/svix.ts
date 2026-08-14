const MAX_AGE_SECONDS = 300;

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function secretBytes(secret: string): Uint8Array {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    return base64Bytes(encoded);
  } catch {
    throw new Error("invalid_webhook_secret");
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifySvixSignature(
  headers: Headers,
  body: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<void> {
  const id = headers.get("svix-id") ?? "";
  const timestampValue = headers.get("svix-timestamp") ?? "";
  const signatures = headers.get("svix-signature") ?? "";
  const timestamp = Number(timestampValue);
  if (!id || !Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_AGE_SECONDS) {
    throw new Error("invalid_webhook_timestamp");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secretBytes(secret)).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      Uint8Array.from(new TextEncoder().encode(`${id}.${timestampValue}.${body}`)).buffer
    )
  );
  const verified = signatures
    .split(" ")
    .map((value) => value.split(",", 2))
    .filter(([version, signature]) => version === "v1" && !!signature)
    .some(([, signature]) => {
      try {
        return constantTimeEqual(expected, base64Bytes(signature));
      } catch {
        return false;
      }
    });
  if (!verified) throw new Error("invalid_webhook_signature");
}
