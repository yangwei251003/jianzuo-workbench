import { randomBytes, randomUUID } from "node:crypto";
import type { WorkbenchDatabase } from "@jianzuo/database";
import { deriveEncryptionKey, hashPin, verifyPin } from "@jianzuo/core";

export type Session = {
  id: string;
  csrf: string;
  encryptionKey: Buffer;
  expiresAt: number;
};

const SESSION_TTL = 8 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 60 * 1000;

export class AuthService {
  private readonly sessions = new Map<string, Session>();
  private failedUnlocks: number[] = [];
  private lockedUntil = 0;
  constructor(private readonly db: WorkbenchDatabase) {}

  async setup(pin: string): Promise<{ token: string; session: Session }> {
    if (this.db.hasPin()) throw httpError("本地 PIN 已设置", 409);
    let pinHash: string;
    try { pinHash = await hashPin(pin); }
    catch (error) { throw httpError(error instanceof Error ? error.message : "PIN 格式无效", 400); }
    const salt = randomBytes(16).toString("base64");
    this.db.setSetting("pin_hash", pinHash);
    this.db.setSetting("encryption_salt", salt);
    this.db.audit("local-user", "AUTH_SETUP", "已设置本地 PIN");
    return this.createSession(pin, salt);
  }

  async unlock(pin: string): Promise<{ token: string; session: Session }> {
    await this.confirmPin(pin, "AUTH_UNLOCK_FAILED");
    const salt = this.db.getSetting("encryption_salt");
    if (!salt) throw httpError("加密配置缺失", 500);
    this.db.audit("local-user", "AUTH_UNLOCK", "工作台已解锁");
    return this.createSession(pin, salt);
  }

  async confirmSensitiveAction(pin: string): Promise<void> {
    try {
      await this.confirmPin(pin, "AUTH_SENSITIVE_CONFIRM_FAILED");
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 401) throw httpError("PIN 不正确", 403);
      throw error;
    }
  }

  private async confirmPin(pin: string, failureEvent: string): Promise<void> {
    const timestamp = Date.now();
    if (this.lockedUntil > timestamp) throw httpError(`尝试次数过多，请 ${Math.ceil((this.lockedUntil - timestamp) / 1000)} 秒后再试`, 429);
    this.failedUnlocks = this.failedUnlocks.filter((attempt) => attempt >= timestamp - FAILURE_WINDOW_MS);
    const stored = this.db.getSetting("pin_hash");
    if (!stored) throw httpError("尚未设置本地 PIN", 409);
    if (!(await verifyPin(pin, stored))) {
      this.failedUnlocks.push(timestamp);
      this.db.audit("local-user", failureEvent, "本地 PIN 校验失败", { attemptsInWindow: this.failedUnlocks.length });
      if (this.failedUnlocks.length >= FAILURE_LIMIT) {
        this.lockedUntil = timestamp + LOCKOUT_MS;
        throw httpError("尝试次数过多，请 60 秒后再试", 429);
      }
      throw httpError("PIN 不正确", 401);
    }
    this.failedUnlocks = [];
    this.lockedUntil = 0;
  }

  private async createSession(pin: string, salt: string): Promise<{ token: string; session: Session }> {
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      id: randomUUID(),
      csrf: randomBytes(24).toString("base64url"),
      encryptionKey: await deriveEncryptionKey(pin, salt),
      expiresAt: Date.now() + SESSION_TTL
    };
    this.sessions.set(token, session);
    return { token, session };
  }

  getSession(token: string | undefined): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (session) this.sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL;
    return session;
  }

  lock(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
