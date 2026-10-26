import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPin(pin: string): Promise<string> {
  if (!/^\d{6,12}$/.test(pin)) throw new Error("PIN 需为 6–12 位数字");
  const salt = randomBytes(16);
  const derived = (await scrypt(pin, salt, 32)) as Buffer;
  return `scrypt:${salt.toString("base64")}:${derived.toString("base64")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [kind, saltB64, hashB64] = stored.split(":");
  if (kind !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = (await scrypt(pin, Buffer.from(saltB64, "base64"), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function deriveEncryptionKey(pin: string, saltB64: string): Promise<Buffer> {
  return (await scrypt(pin, Buffer.from(saltB64, "base64"), 32)) as Buffer;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64")).join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [iv, tag, ciphertext] = payload.split(".").map((part) => Buffer.from(part!, "base64"));
  if (!iv || !tag || !ciphertext) throw new Error("密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const SECRET_KEY_FRAGMENTS = ["cookie", "token", "password", "authorization", "verificationcode", "remotecode"];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return normalized === "pin" || normalized.endsWith("pin") || SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSecretKey(key) ? "[REDACTED]" : redact(entry);
    }
    return output as T;
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:access_token|refresh_token|token|api_key|key|secret|code)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/\b\d{6}\b/g, "[CODE]") as T;
  }
  return value;
}
