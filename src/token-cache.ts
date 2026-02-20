export interface CachedToken {
  macaroon: string;
  preimage: string;
  url: string;
  createdAt: number;
  expiresAt?: number;
}

export class TokenCache {
  private tokens = new Map<string, CachedToken>();

  get(url: string): CachedToken | undefined {
    const token = this.tokens.get(url);
    if (!token) return undefined;

    if (token.expiresAt && Date.now() > token.expiresAt) {
      this.tokens.delete(url);
      return undefined;
    }

    return token;
  }

  set(url: string, macaroon: string, preimage: string, ttlMs?: number): void {
    const token: CachedToken = {
      macaroon,
      preimage,
      url,
      createdAt: Date.now(),
    };

    if (ttlMs) {
      token.expiresAt = Date.now() + ttlMs;
    }

    this.tokens.set(url, token);
  }

  delete(url: string): boolean {
    return this.tokens.delete(url);
  }

  clear(): void {
    this.tokens.clear();
  }

  get size(): number {
    return this.tokens.size;
  }
}
