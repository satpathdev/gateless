import { createHash } from "node:crypto";

import type { InvoiceProvider } from "./invoice-provider.js";
import { issueMacaroon, verifyMacaroon } from "./macaroon.js";

export interface L402ServerConfig {
  /** HMAC key used to sign macaroons. Must be kept secret. */
  secret: string;
  invoiceProvider: InvoiceProvider;
  /** Default memo written into generated invoices (default: "L402") */
  defaultMemo?: string;
  /** Default invoice expiry in seconds (default: 3600) */
  defaultExpirySeconds?: number;
}

export interface L402Challenge {
  status: 402;
  macaroon: string;
  invoice: string;
  paymentHash: string;
  /** Ready-to-set WWW-Authenticate header value */
  wwwAuthenticate: string;
}

export type VerifyResult =
  | { ok: true; paymentHash: string; priceSats: number }
  | { ok: false; reason: string };

export interface ProtectOptions {
  priceSats: number;
  /** Overrides the server's defaultMemo for this route */
  memo?: string;
}

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}
interface ResLike {
  status(code: number): ResLike;
  setHeader(name: string, value: string): void;
  send(body?: string): ResLike;
  locals?: Record<string, unknown>;
}
type NextFn = (err?: unknown) => void;
type Middleware = (req: ReqLike, res: ResLike, next: NextFn) => void;

export class L402Server {
  private secret: string;
  private invoiceProvider: InvoiceProvider;
  private defaultMemo: string;
  private defaultExpirySeconds: number;

  constructor(config: L402ServerConfig) {
    if (!config.secret) {
      throw new Error("L402Server: secret is required");
    }
    this.secret = config.secret;
    this.invoiceProvider = config.invoiceProvider;
    this.defaultMemo = config.defaultMemo ?? "L402";
    this.defaultExpirySeconds = config.defaultExpirySeconds ?? 3600;
  }

  async issueChallenge(
    priceSats: number,
    memo?: string,
  ): Promise<L402Challenge> {
    const invoice = await this.invoiceProvider.createInvoice({
      amountSats: priceSats,
      memo: memo ?? this.defaultMemo,
      expirySeconds: this.defaultExpirySeconds,
    });

    const now = Math.floor(Date.now() / 1000);
    const macaroon = issueMacaroon(this.secret, {
      h: invoice.paymentHash,
      p: priceSats,
      t: now,
      e: invoice.expiresAt ?? now + this.defaultExpirySeconds,
    });

    return {
      status: 402,
      macaroon,
      invoice: invoice.paymentRequest,
      paymentHash: invoice.paymentHash,
      wwwAuthenticate: `L402 macaroon="${macaroon}", invoice="${invoice.paymentRequest}"`,
    };
  }

  verifyAuthorization(header: string | null | undefined): VerifyResult {
    if (!header) return { ok: false, reason: "missing Authorization header" };

    const match = header.match(/^L402\s+([^:\s]+):([0-9a-fA-F]+)$/);
    if (!match || !match[1] || !match[2]) {
      return { ok: false, reason: "malformed Authorization header" };
    }
    const macaroon = match[1];
    const preimage = match[2];

    const payload = verifyMacaroon(this.secret, macaroon);
    if (!payload) return { ok: false, reason: "invalid or expired macaroon" };

    const preimageBytes = Buffer.from(preimage, "hex");
    if (preimageBytes.length !== 32) {
      return { ok: false, reason: "preimage must be 32 bytes hex" };
    }

    const computedHash = createHash("sha256")
      .update(preimageBytes)
      .digest("hex");
    if (computedHash.toLowerCase() !== payload.h.toLowerCase()) {
      return { ok: false, reason: "preimage does not match payment hash" };
    }

    return { ok: true, paymentHash: payload.h, priceSats: payload.p };
  }

  /**
   * Framework-agnostic middleware. Works with Express, Hono (via Node adapter),
   * and any library whose request/response objects duck-type as expected.
   */
  protect(options: ProtectOptions): Middleware {
    return async (req, res, next) => {
      const authHeader = req.headers["authorization"];
      const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;

      if (auth) {
        const result = this.verifyAuthorization(auth);
        if (result.ok) {
          if (res.locals) {
            res.locals["l402"] = {
              paymentHash: result.paymentHash,
              priceSats: result.priceSats,
            };
          }
          next();
          return;
        }
      }

      try {
        const challenge = await this.issueChallenge(
          options.priceSats,
          options.memo,
        );
        res.setHeader("WWW-Authenticate", challenge.wwwAuthenticate);
        res.status(402).send("Payment Required");
      } catch (err) {
        next(err);
      }
    };
  }
}
