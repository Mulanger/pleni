export interface ClerkClaims {
  sub: string;
  iss: string;
  azp: string;
  exp: number;
  nbf?: number;
  iat?: number;
  role?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface ClerkJwk extends JsonWebKey {
  kid?: string;
}

interface JwksDocument {
  keys?: ClerkJwk[];
}

export interface VerifyClerkJwtOptions {
  issuers: ReadonlySet<string>;
  authorizedParties: ReadonlySet<string>;
  fetcher?: typeof fetch;
  nowSeconds?: number;
  clockSkewSeconds?: number;
}

export class ClerkAuthError extends Error {
  readonly status = 401;
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "ClerkAuthError";
  }
}

const jwksCache = new Map<string, { expiresAt: number; keys: ClerkJwk[] }>();
const JWKS_CACHE_SECONDS = 300;

export function clearJwksCache(): void {
  jwksCache.clear();
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ClerkAuthError("malformed_token");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
  } catch (error) {
    if (error instanceof ClerkAuthError) {
      throw error;
    }
    throw new ClerkAuthError("malformed_token");
  }
}

async function issuerKeys(
  issuer: string,
  fetcher: typeof fetch,
  nowSeconds: number,
  forceRefresh = false
): Promise<ClerkJwk[]> {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > nowSeconds) {
    return cached.keys;
  }
  const response = await fetcher(`${issuer.replace(/\/$/, "")}/.well-known/jwks.json`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new ClerkAuthError("jwks_unavailable");
  }
  const document = (await response.json()) as JwksDocument;
  const keys = Array.isArray(document.keys) ? document.keys : [];
  if (keys.length === 0) {
    throw new ClerkAuthError("jwks_unavailable");
  }
  jwksCache.set(issuer, { expiresAt: nowSeconds + JWKS_CACHE_SECONDS, keys });
  return keys;
}

function numericClaim(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ClerkAuthError(code);
  }
  return value;
}

export async function verifyClerkJwt(
  token: string,
  options: VerifyClerkJwtOptions
): Promise<ClerkClaims> {
  if (token.length < 40 || token.length > 16_000) {
    throw new ClerkAuthError("malformed_token");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new ClerkAuthError("malformed_token");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson<JwtHeader>(encodedHeader);
  const payload = decodeJson<Record<string, unknown>>(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) {
    throw new ClerkAuthError("unsupported_token");
  }

  const issuer = typeof payload.iss === "string" ? payload.iss.replace(/\/$/, "") : "";
  if (!issuer || !options.issuers.has(issuer)) {
    throw new ClerkAuthError("unknown_issuer");
  }
  const authorizedParty = typeof payload.azp === "string" ? payload.azp.replace(/\/$/, "") : "";
  if (!authorizedParty || !options.authorizedParties.has(authorizedParty)) {
    throw new ClerkAuthError("wrong_authorized_party");
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 5;
  const expiresAt = numericClaim(payload.exp, "missing_expiry");
  if (expiresAt <= now - skew) {
    throw new ClerkAuthError("expired_token");
  }
  if (payload.nbf !== undefined && numericClaim(payload.nbf, "invalid_not_before") > now + skew) {
    throw new ClerkAuthError("token_not_active");
  }
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  if (subject.length < 3 || subject.length > 200) {
    throw new ClerkAuthError("invalid_subject");
  }

  const fetcher = options.fetcher ?? fetch;
  let keys = await issuerKeys(issuer, fetcher, now);
  let key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!key) {
    // Clerk may rotate keys while the five-minute JWKS cache is warm. Refresh
    // once before rejecting so valid sessions do not fail until cache expiry.
    keys = await issuerKeys(issuer, fetcher, now, true);
    key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
    if (!key) throw new ClerkAuthError("unknown_signing_key");
  }
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch {
    throw new ClerkAuthError("invalid_signing_key");
  }
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    Uint8Array.from(decodeBase64Url(encodedSignature)).buffer,
    Uint8Array.from(new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)).buffer
  );
  if (!verified) {
    throw new ClerkAuthError("invalid_signature");
  }

  return {
    sub: subject,
    iss: issuer,
    azp: authorizedParty,
    exp: expiresAt,
    nbf: typeof payload.nbf === "number" ? payload.nbf : undefined,
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
    role: typeof payload.role === "string" ? payload.role : undefined
  };
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) {
    throw new ClerkAuthError("missing_bearer_token");
  }
  return match[1];
}
