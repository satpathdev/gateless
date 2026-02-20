export interface PaymentResult {
  /** Hex-encoded preimage proving payment was made */
  preimage: string;
  /** Hex-encoded payment hash identifying this payment */
  paymentHash: string;
  status: string;
}

/**
 * Interface for any Lightning payment backend.
 * Implement this to add support for payment methods beyond LND,
 * such as Nostr Wallet Connect (NWC) or Lightning Node Connect (LNC).
 */
export interface PaymentProvider {
  /** Pays a BOLT11 Lightning invoice and returns the preimage as proof of payment */
  payInvoice(paymentRequest: string): Promise<PaymentResult>;

  /**
   * Returns the invoice amount in satoshis by decoding the BOLT11 invoice.
   * Used for pre-payment amount validation. If not implemented, the client
   * falls back to local BOLT11 parsing (less reliable).
   */
  getInvoiceAmountSats?(paymentRequest: string): Promise<number>;
}
