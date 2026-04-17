import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Opaque token embedded in L402 challenges. Not a full Google macaroon with
 * third-party caveat discharge - just a signed envelope carrying the payment
 * hash, price, and issue/expiry times. L402 clients treat it as opaque.
 */
export interface MacaroonPayload {
  /** Hex-encoded payment hash */
  h: string;
  /** Price in satoshis */
  p: number;
  /** Issued-at (unix seconds) */
  t: number;
  /** Expires-at (unix seconds), optional */
  e?: number;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecodeToString(input: string): string {
  return Buffer.from(input, "base64url").toString("utf-8");
}

export function issueMacaroon(
  secret: string,
  payload: MacaroonPayload,
): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyMacaroon(
  secret: string,
  token: string,
): MacaroonPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, sig] = parts;
  if (!body || !sig) return undefined;

  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(sig, "base64url");
  if (expected.length !== provided.length) return undefined;
  if (!timingSafeEqual(expected, provided)) return undefined;

  let payload: MacaroonPayload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(body)) as MacaroonPayload;
  } catch {
    return undefined;
  }

  if (
    typeof payload.h !== "string" ||
    typeof payload.p !== "number" ||
    typeof payload.t !== "number"
  ) {
    return undefined;
  }
  if (payload.e !== undefined && typeof payload.e !== "number")
    return undefined;
  if (payload.e !== undefined && Date.now() / 1000 > payload.e)
    return undefined;

  return payload;
}
