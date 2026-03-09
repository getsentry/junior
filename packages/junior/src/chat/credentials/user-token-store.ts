export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}

export interface UserTokenStore {
  get(userId: string, provider: string): Promise<StoredTokens | undefined>;
  set(userId: string, provider: string, tokens: StoredTokens): Promise<void>;
  delete(userId: string, provider: string): Promise<void>;
}
