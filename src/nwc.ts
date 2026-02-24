import { createHash } from "node:crypto";

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { encrypt, decrypt } from "nostr-tools/nip04";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import type { Event } from "nostr-tools/core";

import type { PaymentProvider, PaymentResult } from "./payment-provider.js";
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
 * NWC (Nostr Wallet Connect / NIP-47) payment provider.
 * Connects to any NWC-compatible wallet (Alby Hub, etc.) to pay Lightning invoices
 * via the Nostr relay specified in the connection string.
 *
 * Uses NIP-04 encryption as required by the NIP-47 specification.
 */
export class NwcClient implements PaymentProvider {
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
    const relay = await this.ensureRelay();

    const requestContent = JSON.stringify({
      method: "pay_invoice",
      params: { invoice: paymentRequest },
    });

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

    return responsePromise;
  }

  private async waitForResponse(
    relay: Relay,
    requestEventId: string,
  ): Promise<PaymentResult> {
    return new Promise<PaymentResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.close();
        reject(
          new L402PaymentError(
            `NWC payment timed out after ${this.timeoutMs}ms`,
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
              const result = await this.handleResponse(event);
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
        },
      );
    });
  }

  private async handleResponse(event: Event): Promise<PaymentResult> {
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

    let response: {
      result_type: string;
      error?: { code: string; message: string };
      result?: { preimage: string };
    };
    try {
      response = JSON.parse(decrypted) as typeof response;
    } catch {
      throw new L402PaymentError("NWC response is not valid JSON");
    }

    if (response.error) {
      throw new L402PaymentError(
        `NWC payment failed: ${response.error.message} (${response.error.code})`,
      );
    }

    const preimage = response.result?.preimage;
    if (!preimage) {
      throw new L402PaymentError("NWC response missing preimage");
    }

    // Derive payment hash from preimage via SHA-256
    const preimageBytes = hexToBytes(preimage);
    const paymentHash = createHash("sha256")
      .update(preimageBytes)
      .digest("hex");

    return {
      preimage,
      paymentHash,
      status: "SUCCEEDED",
    };
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
