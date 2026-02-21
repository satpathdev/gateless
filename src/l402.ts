import { TokenCache } from "./token-cache.js";
import { SpendingTracker, type SpendingLimit } from "./spending.js";
import type { PaymentProvider } from "./payment-provider.js";
import {
  L402BudgetError,
  L402PaymentError,
  L402ProtocolError,
} from "./errors.js";
import {
  type FewsatsPaymentRequired,
  type FewsatsPaymentRequestResponse,
  type OfferStrategy,
  parseFewsatsPaymentRequired,
  selectCheapestLightningOffer,
} from "./fewsats.js";

export interface L402ClientConfig {
  paymentProvider: PaymentProvider;
  /**
   * Maximum sats allowed per individual payment (default: 1000).
   * This is a simple safety cap. For full budget control, use spendingLimits
   * which provides per-payment, total budget, and rate limiting together.
   */
  maxPaymentSats?: number;
  /** Optional spending limits for budget and rate control */
  spendingLimits?: SpendingLimit;
  /** Strategy for selecting from Fewsats v0.2 offers (default: cheapest lightning-compatible) */
  offerStrategy?: OfferStrategy;
}

export class L402Client {
  private paymentProvider: PaymentProvider;
  private maxPaymentSats: number;
  private cache: TokenCache;
  private spending: SpendingTracker | undefined;
  private inflightPayments = new Map<string, Promise<void>>();
  private offerStrategy: OfferStrategy;

  constructor(config: L402ClientConfig) {
    this.paymentProvider = config.paymentProvider;
    this.maxPaymentSats = config.maxPaymentSats ?? 1000;
    this.cache = new TokenCache();
    this.offerStrategy = config.offerStrategy ?? selectCheapestLightningOffer;
    if (config.spendingLimits) {
      this.spending = new SpendingTracker(config.spendingLimits);
    }
  }

  /** Remove all cached tokens */
  clearCache(): void {
    this.cache.clear();
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const cached = this.cache.get(url);
    if (cached) {
      const headers = new Headers(init?.headers);
      headers.set(
        "Authorization",
        `L402 ${cached.macaroon}:${cached.preimage}`,
      );
      const cachedResponse = await fetch(url, { ...init, headers });

      if (cachedResponse.status !== 402) {
        return cachedResponse;
      }

      // Token expired server-side - discard and fall through to payment flow
      this.cache.delete(url);
    }

    // If another call is already paying for this URL, wait for it then use the cache
    const inflight = this.inflightPayments.get(url);
    if (inflight) {
      await inflight;
      const token = this.cache.get(url);
      if (token) {
        const headers = new Headers(init?.headers);
        headers.set(
          "Authorization",
          `L402 ${token.macaroon}:${token.preimage}`,
        );
        return fetch(url, { ...init, headers });
      }
    }

    const response = await fetch(url, init);

    if (response.status !== 402) {
      return response;
    }

    // Detect which L402 flavor was returned
    const wwwAuth = response.headers.get("www-authenticate");

    if (wwwAuth) {
      // Classic L402: WWW-Authenticate header present
      await response.body?.cancel();
      return this.handleClassicL402(url, init, wwwAuth);
    }

    // Try Fewsats v0.2: parse JSON body
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new L402ProtocolError(
        "402 response has no WWW-Authenticate header and body is not valid JSON",
      );
    }

    const fewsatsPayload = parseFewsatsPaymentRequired(body);
    if (!fewsatsPayload) {
      throw new L402ProtocolError(
        "402 response has no WWW-Authenticate header and body does not match Fewsats v0.2 format",
      );
    }

    return this.handleFewsatsV02(url, init, fewsatsPayload);
  }

  private async handleClassicL402(
    url: string,
    init: RequestInit | undefined,
    wwwAuth: string,
  ): Promise<Response> {
    const { macaroon, invoice } = this.parseWwwAuthenticate(wwwAuth);

    const amountSats = this.paymentProvider.getInvoiceAmountSats
      ? await this.paymentProvider.getInvoiceAmountSats(invoice)
      : this.decodeInvoiceAmountLocal(invoice);

    if (amountSats > this.maxPaymentSats) {
      throw new L402BudgetError(
        `Invoice amount ${amountSats} sats exceeds limit of ${this.maxPaymentSats} sats`,
      );
    }

    this.spending?.check(amountSats);

    let resolveInflight: () => void;
    const paymentPromise = new Promise<void>((r) => {
      resolveInflight = r;
    });
    this.inflightPayments.set(url, paymentPromise);

    try {
      const payment = await this.paymentProvider.payInvoice(invoice);

      this.spending?.record(amountSats, url);
      this.cache.set(url, macaroon, payment.preimage);

      const headers = new Headers(init?.headers);
      headers.set("Authorization", `L402 ${macaroon}:${payment.preimage}`);

      return fetch(url, { ...init, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new L402PaymentError(`Payment failed: ${message}`);
    } finally {
      this.inflightPayments.delete(url);
      resolveInflight!();
    }
  }

  private async handleFewsatsV02(
    url: string,
    init: RequestInit | undefined,
    payload: FewsatsPaymentRequired,
  ): Promise<Response> {
    const selectedOffer = this.offerStrategy(payload.offers);

    // POST to payment_request_url to get a lightning invoice
    let paymentRequestResponse: Response;
    try {
      paymentRequestResponse = await fetch(payload.payment_request_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offer_id: selectedOffer.offer_id,
          payment_method: "lightning" as const,
          payment_context_token: payload.payment_context_token,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new L402PaymentError(`Failed to fetch payment request: ${message}`);
    }

    if (!paymentRequestResponse.ok) {
      const errorText = await paymentRequestResponse
        .text()
        .catch(() => "unknown error");
      throw new L402PaymentError(
        `Payment request endpoint returned ${paymentRequestResponse.status}: ${errorText}`,
      );
    }

    let paymentRequestData: FewsatsPaymentRequestResponse;
    try {
      paymentRequestData =
        (await paymentRequestResponse.json()) as FewsatsPaymentRequestResponse;
    } catch {
      throw new L402ProtocolError("Payment request response is not valid JSON");
    }

    const invoice = paymentRequestData.payment_request?.lightning_invoice;
    if (!invoice) {
      throw new L402ProtocolError(
        "Payment request response missing lightning_invoice",
      );
    }

    // Validate invoice amount against spending limits
    const amountSats = this.paymentProvider.getInvoiceAmountSats
      ? await this.paymentProvider.getInvoiceAmountSats(invoice)
      : this.decodeInvoiceAmountLocal(invoice);

    if (amountSats > this.maxPaymentSats) {
      throw new L402BudgetError(
        `Invoice amount ${amountSats} sats exceeds limit of ${this.maxPaymentSats} sats`,
      );
    }

    this.spending?.check(amountSats);

    try {
      await this.paymentProvider.payInvoice(invoice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new L402PaymentError(`Payment failed: ${message}`);
    }

    this.spending?.record(amountSats, url);

    // Retry with original headers - Bearer token is the credential in v0.2
    return fetch(url, init);
  }

  private parseWwwAuthenticate(header: string): {
    macaroon: string;
    invoice: string;
  } {
    const macaroonMatch = header.match(/macaroon="([^"]+)"/);
    const invoiceMatch = header.match(/invoice="([^"]+)"/);

    if (!macaroonMatch?.[1] || !invoiceMatch?.[1]) {
      throw new L402ProtocolError(`Invalid WWW-Authenticate header: ${header}`);
    }

    return {
      macaroon: macaroonMatch[1],
      invoice: invoiceMatch[1],
    };
  }

  /**
   * Local BOLT11 amount parser. Used only as a fallback when the payment
   * provider does not implement getInvoiceAmountSats(). Supports mainnet
   * (lnbc), testnet (lntb), and regtest (lnbcrt) invoices.
   */
  private decodeInvoiceAmountLocal(invoice: string): number {
    const lower = invoice.toLowerCase();

    // Find amount start after the network prefix
    let amountStart: number;
    if (lower.startsWith("lnbcrt")) {
      amountStart = 6;
    } else if (lower.startsWith("lntb") || lower.startsWith("lnbc")) {
      amountStart = 4;
    } else {
      throw new L402ProtocolError(
        "Cannot decode invoice: unrecognized network prefix",
      );
    }

    // The human-readable part ends at the last '1' before the data section
    const separatorIndex = lower.lastIndexOf("1");
    if (separatorIndex <= amountStart) {
      throw new L402ProtocolError(
        "Cannot decode invoice amount: no amount specified",
      );
    }

    const amountPart = lower.slice(amountStart, separatorIndex);
    const match = amountPart.match(/^(\d+)([munp])$/);
    if (!match?.[1] || !match[2]) {
      throw new L402ProtocolError(
        "Cannot decode invoice amount: invalid format",
      );
    }

    const amount = parseInt(match[1], 10);
    const multipliers: Record<string, number> = {
      m: 100_000,
      u: 100,
      n: 0.1,
      p: 0.0001,
    };

    const mult = multipliers[match[2]];
    if (mult === undefined) {
      throw new L402ProtocolError("Cannot decode invoice amount");
    }

    return Math.round(amount * mult);
  }
}
