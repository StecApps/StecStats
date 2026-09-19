import { createHmac, timingSafeEqual } from "node:crypto";

const BROADCASTER_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not configured");
  return value;
}

export function createBroadcasterToken(code: string, ownerId: number): string {
  const expiresAt = Math.floor(Date.now() / 1000) + BROADCASTER_TOKEN_TTL_SECONDS;
  const payload = `${code.toUpperCase()}.${ownerId}.${expiresAt}`;
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyBroadcasterToken(token: string, code: string, ownerId: number): boolean {
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [tokenCode, tokenOwner, expiry, signature] = parts;
  const payload = `${tokenCode}.${tokenOwner}.${expiry}`;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  if (tokenCode !== code.toUpperCase() || tokenOwner !== String(ownerId)) return false;
  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}