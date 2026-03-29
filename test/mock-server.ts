import http from "node:http";

const MOCK_MACAROON =
  "0200000000000000000000000000000000000000000000000000000000000000";
const EXPECTED_PREIMAGE =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const MOCK_INVOICE = "lnbc10u1fakeinvoice";

// Fewsats v0.2 state
const paidBearerTokens = new Set<string>();
let contextTokenCounter = 0;
let lastOfferId: string | undefined;
/** Tracks how many retry attempts hit `/v02/data-delayed` per bearer token */
const delayedRetryCount = new Map<string, number>();
/** Number of 402s to return before granting access on `/v02/data-delayed` */
let delayedRequiredRetries = 3;

export function resetV02State(): void {
  paidBearerTokens.clear();
  contextTokenCounter = 0;
  lastOfferId = undefined;
  delayedRetryCount.clear();
  delayedRequiredRetries = 3;
}

export function setDelayedRequiredRetries(n: number): void {
  delayedRequiredRetries = n;
}

export function getLastOfferId(): string | undefined {
  return lastOfferId;
}

export function startMockServer(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const auth = req.headers["authorization"];

    // ---- Classic L402 (existing behavior) ----
    if (url.pathname === "/api/data") {
      if (auth) {
        const match = auth.match(/^L402 (.+):(.+)$/);
        if (match?.[1] && match[2] === EXPECTED_PREIMAGE) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: "You paid! Here is your secret content.",
            }),
          );
          return;
        }
      }

      res.writeHead(402, {
        "WWW-Authenticate": `L402 macaroon="${MOCK_MACAROON}", invoice="${MOCK_INVOICE}"`,
      });
      res.end("Payment Required");
      return;
    }

    // ---- Fewsats v0.2: protected resources ----
    // ---- Fewsats v0.2: delayed crediting (for retry config tests) ----
    if (url.pathname === "/v02/data-delayed") {
      if (auth) {
        const bearerMatch = auth.match(/^Bearer (.+)$/);
        if (bearerMatch?.[1] && paidBearerTokens.has(bearerMatch[1])) {
          const count = (delayedRetryCount.get(bearerMatch[1]) ?? 0) + 1;
          delayedRetryCount.set(bearerMatch[1], count);
          if (count > delayedRequiredRetries) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: "delayed content" }));
            return;
          }
        }
      }

      const contextToken = `ctx_${++contextTokenCounter}`;
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          offers: [
            {
              offer_id: "offer_delayed",
              title: "Delayed",
              description: "Delayed crediting",
              amount: 100,
              balance: 1,
              currency: "USD",
              payment_methods: ["lightning"],
              type: "top-up",
            },
          ],
          payment_context_token: contextToken,
          payment_request_url: `http://localhost:${port}/v02/payment-request`,
          version: "0.2.1",
        }),
      );
      return;
    }

    if (
      url.pathname === "/v02/data" ||
      url.pathname === "/v02/data-multi" ||
      url.pathname === "/v02/data-no-lightning"
    ) {
      // Check if bearer token has been credited
      if (auth) {
        const bearerMatch = auth.match(/^Bearer (.+)$/);
        if (bearerMatch?.[1] && paidBearerTokens.has(bearerMatch[1])) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ data: "Fewsats v0.2 premium content" }),
          );
          return;
        }
      }

      const contextToken = `ctx_${++contextTokenCounter}`;

      let offers;
      if (url.pathname === "/v02/data-no-lightning") {
        offers = [
          {
            offer_id: "offer_onchain",
            title: "On-chain Only",
            description: "On-chain payment",
            amount: 100,
            balance: 1,
            currency: "USD",
            payment_methods: ["onchain"],
            type: "top-up",
          },
        ];
      } else if (url.pathname === "/v02/data-multi") {
        offers = [
          {
            offer_id: "offer_expensive",
            title: "Premium",
            description: "Expensive lightning",
            amount: 500,
            balance: 5,
            currency: "USD",
            payment_methods: ["lightning", "onchain"],
            type: "top-up",
          },
          {
            offer_id: "offer_cheap",
            title: "Basic",
            description: "Cheap lightning",
            amount: 100,
            balance: 1,
            currency: "USD",
            payment_methods: ["lightning"],
            type: "top-up",
          },
          {
            offer_id: "offer_onchain",
            title: "On-chain",
            description: "On-chain only",
            amount: 50,
            balance: 1,
            currency: "USD",
            payment_methods: ["onchain"],
            type: "top-up",
          },
        ];
      } else {
        offers = [
          {
            offer_id: "offer_1",
            title: "Access Pass",
            description: "1 query",
            amount: 100,
            balance: 1,
            currency: "USD",
            payment_methods: ["lightning"],
            type: "top-up",
          },
        ];
      }

      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          offers,
          payment_context_token: contextToken,
          payment_request_url: `http://localhost:${port}/v02/payment-request`,
          version: "0.2.1",
        }),
      );
      return;
    }

    // ---- Fewsats v0.2: payment request endpoint ----
    if (url.pathname === "/v02/payment-request" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as {
            offer_id?: string;
            payment_method?: string;
            payment_context_token?: string;
          };

          if (parsed.payment_method !== "lightning") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "Unsupported payment method" }),
            );
            return;
          }

          lastOfferId = parsed.offer_id;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              payment_request: {
                lightning_invoice: MOCK_INVOICE,
              },
              expires_at: new Date(Date.now() + 600_000).toISOString(),
              offer_id: parsed.offer_id,
              version: "0.2.1",
            }),
          );
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    // Fallback 404
    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Mock L402 server running on port ${port}`);
      resolve(server);
    });
  });
}

export {
  MOCK_MACAROON,
  EXPECTED_PREIMAGE,
  MOCK_INVOICE,
  paidBearerTokens,
};
