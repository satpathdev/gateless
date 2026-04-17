export interface Invoice {
  /** BOLT11 payment request */
  paymentRequest: string;
  /** Hex-encoded payment hash */
  paymentHash: string;
  /** Amount in satoshis */
  amountSats: number;
  /** Unix timestamp (seconds) when the invoice expires, if known */
  expiresAt?: number;
}

export interface CreateInvoiceOptions {
  amountSats: number;
  memo?: string;
  /** Invoice expiry in seconds from now */
  expirySeconds?: number;
}

/**
 * Mirror of PaymentProvider for the merchant side.
 * Implementations generate invoices that payers settle against.
 */
export interface InvoiceProvider {
  createInvoice(options: CreateInvoiceOptions): Promise<Invoice>;
}
