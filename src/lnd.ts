import fs from "node:fs";
import https from "node:https";

import type { PaymentProvider, PaymentResult } from "./payment-provider.js";

export type { PaymentResult } from "./payment-provider.js";

export interface LndConfig {
  /** Hostname or IP of the LND REST API */
  host: string;
  /** REST API port (default LND: 8080) */
  port: number;
  /** Path to LND's TLS certificate (tls.cert) */
  tlsCertPath: string;
  /** Path to a macaroon file for authentication (e.g. admin.macaroon) */
  macaroonPath: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Connects to an LND node via its REST API.
 * Reads the TLS cert and macaroon from disk once at construction.
 * The macaroon is sent as a hex-encoded header on every request.
 */
export class LndClient implements PaymentProvider {
  private tlsCert: Buffer;
  private macaroon: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(private config: LndConfig) {
    this.tlsCert = fs.readFileSync(config.tlsCertPath);
    this.macaroon = fs.readFileSync(config.macaroonPath).toString("hex");
    this.baseUrl = `https://${config.host}:${config.port}`;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /**
   * Makes an authenticated HTTPS request to the LND REST API.
   * The TLS cert is used as a CA to verify the self-signed certificate.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);

    const options: https.RequestOptions = {
      method,
      ca: this.tlsCert,
      headers: {
        "Grpc-Metadata-macaroon": this.macaroon,
        "Content-Type": "application/json",
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data) as T);
          } else {
            reject(new Error(`LND API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new Error(`LND request timed out after ${this.timeoutMs}ms`));
      });

      req.on("error", reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /** Returns general information about the node (alias, sync status, block height, etc.) */
  async getInfo(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/getinfo");
  }

  /**
   * Pays a BOLT11 Lightning invoice.
   * LND returns the preimage as base64 - we convert it to hex
   * because the L402 Authorization header requires hex encoding.
   */
  async payInvoice(paymentRequest: string): Promise<PaymentResult> {
    const response = await this.request<{
      payment_preimage: string;
      payment_hash: string;
      payment_error?: string;
    }>("POST", "/v1/channels/transactions", {
      payment_request: paymentRequest,
    });

    if (response.payment_error) {
      throw new Error(`Payment failed: ${response.payment_error}`);
    }

    if (
      typeof response.payment_preimage !== "string" ||
      !response.payment_preimage
    ) {
      throw new Error("LND response missing payment_preimage");
    }

    return {
      preimage: Buffer.from(response.payment_preimage, "base64").toString(
        "hex",
      ),
      paymentHash: Buffer.from(response.payment_hash, "base64").toString("hex"),
      status: "SUCCEEDED",
    };
  }

  /** Returns the invoice amount in satoshis by decoding via LND's REST API */
  async getInvoiceAmountSats(paymentRequest: string): Promise<number> {
    const result = await this.request<{ num_satoshis: string }>(
      "GET",
      `/v1/payreq/${paymentRequest}`,
    );
    return parseInt(result.num_satoshis, 10);
  }

  /** Decodes a BOLT11 invoice without paying it. Returns amount, destination, description, etc. */
  async decodeInvoice(
    paymentRequest: string,
  ): Promise<Record<string, unknown>> {
    return this.request("GET", `/v1/payreq/${paymentRequest}`);
  }
}
