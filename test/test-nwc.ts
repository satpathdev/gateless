import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, WebSocket } from "ws";
import {
  finalizeEvent,
  getPublicKey,
  generateSecretKey,
} from "nostr-tools/pure";
import { encrypt } from "nostr-tools/nip04";

import { NwcClient, parseConnectionString } from "../src/nwc.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function assertThrows(
  fn: () => Promise<unknown>,
  errorName: string,
  messageIncludes?: string,
): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected ${errorName} but no error was thrown`);
  } catch (error) {
    if (error instanceof Error && error.name === errorName) {
      if (messageIncludes && !error.message.includes(messageIncludes)) {
        throw new Error(
          `Expected error message to include "${messageIncludes}" but got "${error.message}"`,
        );
      }
      return;
    }
    throw error;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// Connection string parsing tests
// ============================================================

console.log("--- NWC: Parse valid connection string ---");
{
  const walletKey = bytesToHex(generateSecretKey());
  const walletPubkey = getPublicKey(
    Uint8Array.from(Buffer.from(walletKey, "hex")),
  );
  const secret = bytesToHex(generateSecretKey());
  const relay = "wss://relay.example.com";
  const uri = `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(relay)}&secret=${secret}`;

  const parsed = parseConnectionString(uri);
  assert(
    parsed.walletPubkey === walletPubkey.toLowerCase(),
    `wallet pubkey mismatch: ${parsed.walletPubkey}`,
  );
  assert(parsed.relay === relay, `relay mismatch: ${parsed.relay}`);
  assert(
    bytesToHex(parsed.secret) === secret.toLowerCase(),
    "secret mismatch",
  );
}
console.log("PASS");

console.log("\n--- NWC: Reject invalid scheme ---");
{
  let threw = false;
  try {
    parseConnectionString("https://example.com");
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("nostr+walletconnect://"),
      `Wrong error: ${(e as Error).message}`,
    );
  }
  assert(threw, "Should have thrown for invalid scheme");
}
console.log("PASS");

console.log("\n--- NWC: Reject missing relay ---");
{
  const secret = bytesToHex(generateSecretKey());
  const pubkey = bytesToHex(generateSecretKey()).slice(0, 64);
  let threw = false;
  try {
    parseConnectionString(
      `nostr+walletconnect://${pubkey}?secret=${secret}`,
    );
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("relay"),
      `Wrong error: ${(e as Error).message}`,
    );
  }
  assert(threw, "Should have thrown for missing relay");
}
console.log("PASS");

console.log("\n--- NWC: Reject missing secret ---");
{
  const pubkey = bytesToHex(generateSecretKey()).slice(0, 64);
  let threw = false;
  try {
    parseConnectionString(
      `nostr+walletconnect://${pubkey}?relay=wss://relay.example.com`,
    );
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("secret"),
      `Wrong error: ${(e as Error).message}`,
    );
  }
  assert(threw, "Should have thrown for missing secret");
}
console.log("PASS");

console.log("\n--- NWC: Reject invalid pubkey ---");
{
  const secret = bytesToHex(generateSecretKey());
  let threw = false;
  try {
    parseConnectionString(
      `nostr+walletconnect://not-a-hex-key?relay=wss://relay.example.com&secret=${secret}`,
    );
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("pubkey"),
      `Wrong error: ${(e as Error).message}`,
    );
  }
  assert(threw, "Should have thrown for invalid pubkey");
}
console.log("PASS");

// ============================================================
// Mock relay for integration-style tests
// ============================================================

/** A fake NWC wallet service that responds to pay_invoice requests via a mock relay */
function createMockNwcRelay(opts: {
  walletSecret: Uint8Array;
  preimage: string;
  shouldError?: boolean;
  errorMessage?: string;
  delayMs?: number;
}): { port: number; close: () => void; startPromise: Promise<void> } {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  const walletPubkey = getPublicKey(opts.walletSecret);

  httpServer.on(
    "upgrade",
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },
  );

  wss.on("connection", (ws: WebSocket) => {
    let subscriptionId: string | undefined;

    ws.on("message", async (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as unknown[];
      const msgType = msg[0] as string;

      if (msgType === "REQ") {
        // Subscription request: ["REQ", subId, filter...]
        subscriptionId = msg[1] as string;
        // Send EOSE
        ws.send(JSON.stringify(["EOSE", subscriptionId]));
      } else if (msgType === "EVENT") {
        // Published event: ["EVENT", event]
        const event = msg[1] as Event;

        // Send OK for the published event
        ws.send(JSON.stringify(["OK", event.id, true, ""]));

        const clientPubkey = event.pubkey;
        const walletSecretHex = bytesToHex(opts.walletSecret);

        // Build the NIP-47 response
        const responseContent = opts.shouldError
          ? JSON.stringify({
              result_type: "pay_invoice",
              error: {
                code: "INSUFFICIENT_BALANCE",
                message: opts.errorMessage ?? "Not enough funds",
              },
            })
          : JSON.stringify({
              result_type: "pay_invoice",
              result: { preimage: opts.preimage },
            });

        // NIP-04 encrypt: wallet encrypts with its secret + client pubkey
        const encryptedResponse = await encrypt(
          walletSecretHex,
          clientPubkey,
          responseContent,
        );

        const responseEvent = finalizeEvent(
          {
            kind: 23195,
            content: encryptedResponse,
            tags: [
              ["p", clientPubkey],
              ["e", event.id],
            ],
            created_at: Math.floor(Date.now() / 1000),
          },
          opts.walletSecret,
        );

        const sendResponse = () => {
          if (subscriptionId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(["EVENT", subscriptionId, responseEvent]));
          }
        };

        if (opts.delayMs) {
          setTimeout(sendResponse, opts.delayMs);
        } else {
          // Small delay to ensure subscription is set up
          setTimeout(sendResponse, 50);
        }
      } else if (msgType === "CLOSE") {
        // Subscription close - no action needed
      }
    });
  });

  let resolveStart: () => void;
  const startPromise = new Promise<void>((r) => {
    resolveStart = r;
  });

  // Listen on random port
  httpServer.listen(0, () => {
    resolveStart();
  });

  return {
    get port() {
      const addr = httpServer.address();
      return typeof addr === "object" && addr ? addr.port : 0;
    },
    close: () => {
      wss.clients.forEach((ws) => ws.close());
      wss.close();
      httpServer.close();
    },
    startPromise,
  };
}

type Event = {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
};

// ============================================================
// payInvoice tests with mock relay
// ============================================================

const FAKE_PREIMAGE =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const walletSecret = generateSecretKey();
const walletPubkey = getPublicKey(walletSecret);
const clientSecret = generateSecretKey();
const clientSecretHex = bytesToHex(clientSecret);

console.log("\n--- NWC: payInvoice happy path ---");
{
  const mockRelay = createMockNwcRelay({
    walletSecret,
    preimage: FAKE_PREIMAGE,
  });
  await mockRelay.startPromise;

  const connectionString = `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(`ws://localhost:${mockRelay.port}`)}&secret=${clientSecretHex}`;

  const client = new NwcClient({ connectionString });

  const result = await client.payInvoice("lnbc10u1fakeinvoice");

  assert(result.preimage === FAKE_PREIMAGE, `Wrong preimage: ${result.preimage}`);
  assert(result.status === "SUCCEEDED", `Wrong status: ${result.status}`);

  // Verify paymentHash is SHA-256 of preimage
  const expectedHash = createHash("sha256")
    .update(Buffer.from(FAKE_PREIMAGE, "hex"))
    .digest("hex");
  assert(
    result.paymentHash === expectedHash,
    `Wrong paymentHash: ${result.paymentHash}`,
  );

  client.close();
  mockRelay.close();
}
console.log("PASS");

console.log("\n--- NWC: payInvoice error response ---");
{
  const mockRelay = createMockNwcRelay({
    walletSecret,
    preimage: FAKE_PREIMAGE,
    shouldError: true,
    errorMessage: "Insufficient balance",
  });
  await mockRelay.startPromise;

  const connectionString = `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(`ws://localhost:${mockRelay.port}`)}&secret=${clientSecretHex}`;

  const client = new NwcClient({ connectionString });

  await assertThrows(
    () => client.payInvoice("lnbc10u1fakeinvoice"),
    "L402PaymentError",
    "Insufficient balance",
  );

  client.close();
  mockRelay.close();
}
console.log("PASS");

console.log("\n--- NWC: payInvoice timeout ---");
{
  const mockRelay = createMockNwcRelay({
    walletSecret,
    preimage: FAKE_PREIMAGE,
    delayMs: 5000, // Delay longer than timeout
  });
  await mockRelay.startPromise;

  const connectionString = `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(`ws://localhost:${mockRelay.port}`)}&secret=${clientSecretHex}`;

  const client = new NwcClient({
    connectionString,
    timeoutMs: 500, // Very short timeout
  });

  await assertThrows(
    () => client.payInvoice("lnbc10u1fakeinvoice"),
    "L402PaymentError",
    "timed out",
  );

  client.close();
  mockRelay.close();
}
console.log("PASS");

console.log("\nAll NWC tests passed!");
process.exit(0);
