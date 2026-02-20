/** The invoice amount or total spend would exceed configured limits */
export class L402BudgetError extends Error {
  override name = "L402BudgetError" as const;
}

/** The Lightning payment failed (routing failure, insufficient funds, etc.) */
export class L402PaymentError extends Error {
  override name = "L402PaymentError" as const;
}

/** The server's L402 challenge was malformed or the invoice could not be parsed */
export class L402ProtocolError extends Error {
  override name = "L402ProtocolError" as const;
}
