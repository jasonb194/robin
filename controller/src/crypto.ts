import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Decode a base64 encryption key; throw if the decoded value is not exactly 32 bytes. */
export function encryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be base64 for exactly 32 bytes");
  return key;
}

/**
 * Encrypt UTF-8 text with a 32-byte AES-256-GCM key and a fresh random IV.
 * Return dot-separated base64 IV, authentication tag, and ciphertext.
 * Randomness and cipher errors, including invalid key lengths, propagate.
 */
export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
}

/**
 * Decrypt the dot-separated base64 IV, tag, and ciphertext produced by encryptSecret.
 * Return UTF-8 plaintext. Throw for missing components; malformed cipher inputs,
 * invalid keys, and authentication failures propagate from Node crypto.
 */
export function decryptSecret(value: string, key: Buffer): string {
  const [iv, tag, data] = value.split(".").map((part) => Buffer.from(part, "base64"));
  if (!iv || !tag || !data) throw new Error("invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Return the hexadecimal HMAC-SHA256 of a UTF-8 value using the supplied secret key. */
export function hash(value: string, key: string): string { return createHmac("sha256", key).update(value).digest("hex"); }
/**
 * Compare a GitHub sha256= signature with the HMAC of the exact request bytes.
 * Return false for missing, malformed, or mismatched signatures; comparison requires
 * the lowercase prefix and digest emitted by the expected signature.
 */
export function verifySignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
/** Return 32 random bytes encoded as unpadded base64url; randomness errors propagate. */
export function randomToken(): string { return randomBytes(32).toString("base64url"); }
