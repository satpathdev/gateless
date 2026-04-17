import { createHash } from "node:crypto";

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { encrypt, decrypt } from "nostr-tools/nip04";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import type { Event } from "nostr-tools/core";

import type { PaymentProvider, PaymentResult } from "./payment-provider.js";
import type {
  CreateInvoiceOptions,
  Invoice,
  InvoiceProvider,
} from "./server/invoice-provider.js";
import { L402PaymentError } from "./errors.js";

export interface NwcConfig {
  /** nostr+walletconnect:// URI from your NWC-compatible wallet */
  connectionString: string;
  /** How long to wait for a payment response in ms (default: 60000) */
  timeoutMs?: number;
}

interface ParsedConnection {
  walletPubkey: string;
  relay: string;
  secret: Uint8Array;
}

interface Nip47Response {
  result_type: string;
  error?: { code: string; message: string };
  result?: unknown;
}

/** NIP-47 request event kind */
const NIP47_REQUEST_KIND = 23194;
/** NIP-47 response event kind */
const NIP47_RESPONSE_KIND = 23195;

/**
 * Parses a nostr+walletconnect:// URI into its components.
 * Format: nostr+walletconnect://<walletPubkey>?relay=<relayUrl>&secret=<hexSecret>
 */
export function parseConnectionString(uri: string): ParsedConnection {
  if (
    !uri.startsWith("nostr+walletconnect://") &&
    !uri.startsWith("nostr+walletconnect:")
  ) {
    throw new Error(
      "Invalid NWC connection string: must start with nostr+walletconnect://",
    );
  }

  // Handle both nostr+walletconnect://pubkey and nostr+walletconnect:pubkey (some wallets omit //)
  const withoutScheme = uri.replace(/^nostr\+walletconnect:\/\//, "");
  const [walletPubkey, queryString] = withoutScheme.split("?") as [
    string,
    string | undefined,
  ];

  if (!walletPubkey || !/^[0-9a-f]{64}$/i.test(walletPubkey)) {
    throw new Error(
      "Invalid NWC connection string: wallet pubkey must be a 64-char hex string",
    );
  }

  if (!queryString) {
    throw new Error(
      "Invalid NWC connection string: missing query parameters (relay, secret)",
    );
  }

  const params = new URLSearchParams(queryString);
  const relay = params.get("relay");
  const secret = params.get("secret");

  if (!relay) {
    throw new Error("Invalid NWC connection string: missing relay parameter");
  }

  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error(
      "Invalid NWC connection string: secret must be a 64-char hex string",
    );
  }

  return {
    walletPubkey: walletPubkey.toLowerCase(),
    relay,
    secret: hexToBytes(secret),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * NWC (Nostr Wallet Connect / NIP-47) client.
 * Connects to any NWC-compatible wallet (Alby Hub, etc.) via a Nostr relay.
 * Implements both PaymentProvider (payInvoice) and InvoiceProvider (createInvoice)
 * - the same wallet is used for sending and receiving.
 *
 * Uses NIP-04 encryption as required by NIP-47.
 */
export class NwcClient implements PaymentProvider, InvoiceProvider {
  private connection: ParsedConnection;
  private timeoutMs: number;
  private relay: Relay | undefined;
  private clientPubkey: string;
  private secretHex: string;

  constructor(config: NwcConfig) {
    this.connection = parseConnectionString(config.connectionString);
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.clientPubkey = getPublicKey(this.connection.secret);
    this.secretHex = bytesToHex(this.connection.secret);
  }

  async payInvoice(paymentRequest: string): Promise<PaymentResult> {
    const result = (await this.sendNip47Request("pay_invoice", {
      invoice: paymentRequest,
    })) as { preimage?: string };

    const preimage = result.preimage;
    if (!preimage) {
      throw new L402PaymentError("NWC response missing preimage");
    }

    const paymentHash = createHash("sha256")
      .update(hexToBytes(preimage))
      .digest("hex");

    return {
      preimage,
      paymentHash,
      status: "SUCCEEDED",
    };
  }

  async createInvoice(options: CreateInvoiceOptions): Promise<Invoice> {
    const params: Record<string, unknown> = {
      amount: options.amountSats * 1000, // NIP-47 make_invoice expects msats
    };
    if (options.memo !== undefined) params["description"] = options.memo;
    if (options.expirySeconds !== undefined) {
      params["expiry"] = options.expirySeconds;
    }

    const result = (await this.sendNip47Request("make_invoice", params)) as {
      invoice?: string;
      payment_hash?: string;
      expires_at?: number;
    };

    if (!result.invoice || !result.payment_hash) {
      throw new L402PaymentError(
        "NWC make_invoice response missing invoice or payment_hash",
      );
    }

    const invoice: Invoice = {
      paymentRequest: result.invoice,
      paymentHash: result.payment_hash,
      amountSats: options.amountSats,
    };
    if (typeof result.expires_at === "number") {
      invoice.expiresAt = result.expires_at;
    }
    return invoice;
  }

  private async sendNip47Request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const relay = await this.ensureRelay();

    const requestContent = JSON.stringify({ method, params });
    const encryptedContent = await encrypt(
      this.secretHex,
      this.connection.walletPubkey,
      requestContent,
    );

    const requestEvent = finalizeEvent(
      {
        kind: NIP47_REQUEST_KIND,
        content: encryptedContent,
        tags: [["p", this.connection.walletPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.connection.secret,
    );

    const responsePromise = this.waitForResponse(relay, requestEvent.id);
    await relay.publish(requestEvent);
    const response = await responsePromise;

    if (response.error) {
      throw new L402PaymentError(
        `NWC ${method} failed: ${response.error.message} (${response.error.code})`,
      );
    }
    if (response.result === undefined) {
      throw new L402PaymentError(`NWC ${method} response missing result`);
    }
    return response.result;
  }

  private async waitForResponse(
    relay: Relay,
    requestEventId: string,
  ): Promise<Nip47Response> {
    return new Promise<Nip47Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.close();
        reject(
          new L402PaymentError(
            `NWC request timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      const sub = relay.subscribe(
        [
          {
            kinds: [NIP47_RESPONSE_KIND],
            "#p": [this.clientPubkey],
            "#e": [requestEventId],
          },
        ],
        {
          onevent: async (event: Event) => {
            clearTimeout(timeout);
            sub.close();
            try {
              const parsed = await this.decryptResponse(event);
              resolve(parsed);
            } catch (error) {
              reject(error);
            }
          },
        },
      );
    });
  }

  private async decryptResponse(event: Event): Promise<Nip47Response> {
    let decrypted: string;
    try {
      decrypted = await decrypt(
        this.secretHex,
        this.connection.walletPubkey,
        event.content,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new L402PaymentError(`Failed to decrypt NWC response: ${msg}`);
    }

    try {
      return JSON.parse(decrypted) as Nip47Response;
    } catch {
      throw new L402PaymentError("NWC response is not valid JSON");
    }
  }

  private async ensureRelay(): Promise<Relay> {
    if (this.relay?.connected) {
      return this.relay;
    }
    // Register Node.js WebSocket for nostr-tools (no-op if already set)
    const WebSocket = (await import("ws")).default;
    useWebSocketImplementation(WebSocket);
    this.relay = await Relay.connect(this.connection.relay);
    return this.relay;
  }

  /** Disconnect from the relay */
  close(): void {
    this.relay?.close();
    this.relay = undefined;
  }
}
