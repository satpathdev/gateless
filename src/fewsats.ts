import { L402ProtocolError } from "./errors.js";

/** A single offer from the Fewsats v0.2 402 JSON body */
export interface FewsatsOffer {
  offer_id: string;
  title: string;
  description: string;
  amount: number;
  balance: number;
  currency: string;
  payment_methods: string[];
  type: string;
}

/** The JSON body of a Fewsats v0.2 402 response */
export interface FewsatsPaymentRequired {
  offers: FewsatsOffer[];
  payment_context_token: string;
  payment_request_url: string;
  version: string;
}

/** The response from POSTing to the payment_request_url */
export interface FewsatsPaymentRequestResponse {
  payment_request: { lightning_invoice: string };
  expires_at: string;
  offer_id: string;
  version: string;
}

/** Strategy function for selecting an offer from the array */
export type OfferStrategy = (offers: FewsatsOffer[]) => FewsatsOffer;

/**
 * Attempts to parse an unknown value as a Fewsats v0.2 payment-required payload.
 * Returns the parsed payload if valid, or undefined if the shape doesn't match.
 * Does not throw.
 */
export function parseFewsatsPaymentRequired(
  body: unknown,
): FewsatsPaymentRequired | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("offers" in body) ||
    !("payment_context_token" in body) ||
    !("payment_request_url" in body) ||
    !("version" in body)
  ) {
    return undefined;
  }

  const obj = body as Record<string, unknown>;

  if (
    !Array.isArray(obj["offers"]) ||
    obj["offers"].length === 0 ||
    typeof obj["payment_context_token"] !== "string" ||
    typeof obj["payment_request_url"] !== "string" ||
    typeof obj["version"] !== "string"
  ) {
    return undefined;
  }

  for (const offer of obj["offers"] as unknown[]) {
    if (
      typeof offer !== "object" ||
      offer === null ||
      typeof (offer as Record<string, unknown>)["offer_id"] !== "string" ||
      typeof (offer as Record<string, unknown>)["amount"] !== "number" ||
      !Array.isArray((offer as Record<string, unknown>)["payment_methods"])
    ) {
      return undefined;
    }
  }

  return body as FewsatsPaymentRequired;
}

/**
 * Default offer strategy: selects the cheapest offer that supports lightning.
 * Throws L402ProtocolError if no lightning-compatible offer exists.
 */
export function selectCheapestLightningOffer(
  offers: FewsatsOffer[],
): FewsatsOffer {
  const lightningOffers = offers.filter((o) =>
    o.payment_methods.includes("lightning"),
  );

  if (lightningOffers.length === 0) {
    throw new L402ProtocolError(
      "No offers support lightning payment method",
    );
  }

  lightningOffers.sort((a, b) => a.amount - b.amount);
  return lightningOffers[0]!;
}
