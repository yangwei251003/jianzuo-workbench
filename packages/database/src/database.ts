import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActionRequest, ActionStatus, ContentBundle, DashboardSnapshot, DeliveryStatus, JobStatus, OrderStatus, Product, PublicationStatus
} from "@jianzuo/contracts";
import { PRODUCT_SEEDS, redact } from "@jianzuo/core";
import { MIGRATIONS } from "./schema.js";

type SqlRow = Record<string, unknown>;
const EXTENSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1_000;
const EXTENSION_HEARTBEAT_GRACE_MS = 2 * 60 * 1_000;

export type ExpiredJobRecovery = {
  recoverable: number;
  deadLettered: number;
};

export type ExpiredMockActionRecovery = {
  requeued: number;
  failed: number;
};

export type PlatformTargetBindingInput = {
  bindingType: "conversation" | "order";
  internalId: string;
  accountId: string;
  externalConversationId?: string;
  externalOrderId?: string;
  buyerPublicId: string;
  productExternalId?: string;
  amountCents?: number;
  pageUrl: string;
  tabId: string;
  accountFingerprint: string;
  domFingerprint: string;
  adapterVersion: string;
  observedAt: string;
  bindingFingerprint: string;
  status: "OBSERVED" | "CONFIRMED" | "TEST_VERIFIED" | "REVOKED";
  evidence?: unknown;
};

function now(): string { return new Date().toISOString(); }
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function defaultDatabasePath(): string {
  return resolve(process.env.JIANZUO_DATA_DIR ?? resolve(process.cwd(), "data"), "jianzuo.sqlite");
}

export class WorkbenchDatabase {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path = defaultDatabasePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = new Set((this.db.prepare("SELECT version FROM schema_migrations").all() as SqlRow[]).map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, now());
      });
    }
  }

  seed(): void {
    this.transaction(() => {
      const timestamp = now();
      this.db.prepare("INSERT OR IGNORE INTO accounts(id,label,status,connector,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .run("local-account", "我的闲鱼账号", "OFFLINE", "MOCK", timestamp, timestamp);
      this.setDefaultSettingUnsafe("automation_paused", "false");
      this.setDefaultSettingUnsafe("manual_hours", JSON.stringify({ start: "09:00", end: "22:00" }));
      this.setDefaultSettingUnsafe("urgent_orders_enabled", "false");
      this.setDefaultSettingUnsafe("retention_days", JSON.stringify({ sources: 30, deliverables: 90, chats: 180, audit: 365 }));

      const insertProduct = this.db.prepare(`
        INSERT OR IGNORE INTO products(
          id,account_id,slug,category,name,base_price,standard_price,advanced_price,release_day,readiness,remote_service,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      PRODUCT_SEEDS.forEach((seed) => {
        insertProduct.run(randomUUID(), "local-account", seed.slug, seed.category, seed.name, ...seed.prices, seed.releaseDay, "PLANNED", seed.remoteService ? 1 : 0, timestamp, timestamp);
      });

      this.db.prepare("INSERT OR IGNORE INTO browser_runtime(id,connector,status,updated_at) VALUES(?,?,?,?)")
        .run("primary", "MOCK", "offline", timestamp);
    });
    this.seedDemoData();
  }

  private seedDemoData(): void {
    const timestamp = now();
    const imageProduct = this.db.prepare("SELECT id FROM products WHERE slug='image-text-edit'").get() as SqlRow;
    const remoteProduct = this.db.prepare("SELECT id FROM products WHERE slug='remote-troubleshooting'").get() as SqlRow;
    const fixedDigitalProduct = this.db.prepare("SELECT id FROM products WHERE slug='local-pdf-toolkit'").get() as SqlRow;
    this.transaction(() => {
      let conversationA = this.db.prepare("SELECT id FROM conversations WHERE product_id=? AND buyer_alias=? LIMIT 1")
        .get(String(imageProduct.id), "买家 7***2") as SqlRow | undefined;
      if (!conversationA) {
        conversationA = { id: randomUUID() };
        this.db.prepare("INSERT INTO conversations(id,product_id,buyer_alias,ai_paused,last_message_at,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
          .run(String(conversationA.id), String(imageProduct.id), "买家 7***2", 0, timestamp, timestamp, "demo");
        this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), String(conversationA.id), "inbound", "buyer", "这张图里的字能换一下吗？今晚要。", timestamp, "demo");
      }

      let conversationB = this.db.prepare("SELECT id FROM conversations WHERE product_id=? AND buyer_alias=? LIMIT 1")
        .get(String(remoteProduct.id), "买家 L***9") as SqlRow | undefined;
      if (!conversationB) {
        conversationB = { id: randomUUID() };
        this.db.prepare("INSERT INTO conversations(id,product_id,buyer_alias,ai_paused,last_message_at,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
          .run(String(conversationB.id), String(remoteProduct.id), "买家 L***9", 0, timestamp, timestamp, "demo");
        this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), String(conversationB.id), "inbound", "buyer", "电脑装软件一直报错，可以远程看吗？", timestamp, "demo");
      }

      let conversationC = this.db.prepare("SELECT id FROM conversations WHERE product_id=? AND buyer_alias=? LIMIT 1")
        .get(String(fixedDigitalProduct.id), "买家 P***6") as SqlRow | undefined;
      if (!conversationC) {
        conversationC = { id: randomUUID() };
        this.db.prepare("INSERT INTO conversations(id,product_id,buyer_alias,ai_paused,last_message_at,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
          .run(String(conversationC.id), String(fixedDigitalProduct.id), "买家 P***6", 0, timestamp, timestamp, "demo");
        this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), String(conversationC.id), "inbound", "buyer", "本地 PDF 工具箱下单后怎么安装？", timestamp, "demo");
      }

      const existingDigital = this.db.prepare("SELECT id FROM orders WHERE id LIKE 'DEMO-%-001' LIMIT 1").get() as SqlRow | undefined;
      if (!existingDigital) {
        const orderId = `DEMO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-001`;
        this.db.prepare(`INSERT INTO orders(
        id,account_id,product_id,conversation_id,buyer_alias,order_type,status,tier,quoted_price,revision_limit,intake_json,created_at,updated_at,data_source
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orderId, "local-account", String(imageProduct.id), String(conversationA.id), "买家 7***2", "semi_custom", "NEEDS_INTAKE", "标准", 12.9, 2,
          JSON.stringify({ missing: ["原图", "替换文字", "期望完成时间"] }), timestamp, timestamp, "demo"
        );
      }

      const existingRemote = this.db.prepare("SELECT id FROM orders WHERE id LIKE 'DEMO-%-002' LIMIT 1").get() as SqlRow | undefined;
      if (!existingRemote) {
        const orderId = `DEMO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-002`;
        this.db.prepare(`INSERT INTO orders(
          id,account_id,product_id,conversation_id,buyer_alias,order_type,status,tier,quoted_price,revision_limit,intake_json,created_at,updated_at,data_source
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orderId, "local-account", String(remoteProduct.id), String(conversationB.id), "买家 L***9", "remote_service", "READY", "基础", 29.9, 1,
          JSON.stringify({ missing: [], authorizationRequired: true }), timestamp, timestamp, "demo"
        );
      }

      const existingFixedDigital = this.db.prepare("SELECT id FROM orders WHERE id LIKE 'DEMO-%-003' LIMIT 1").get() as SqlRow | undefined;
      if (!existingFixedDigital) {
        const orderId = `DEMO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-003`;
        this.db.prepare(`INSERT INTO orders(
          id,account_id,product_id,conversation_id,buyer_alias,order_type,status,tier,quoted_price,revision_limit,intake_json,created_at,updated_at,data_source
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orderId, "local-account", String(fixedDigitalProduct.id), String(conversationC.id), "买家 P***6", "fixed_digital", "READY", "基础", 19.9, 1,
          JSON.stringify({ missing: [], packageKind: "versioned_digital_product" }), timestamp, timestamp, "demo"
        );
      }
    });
  }

  private setSettingUnsafe(key: string, value: string, encrypted = false): void {
    this.db.prepare(`INSERT INTO settings(key,value,encrypted,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted, updated_at=excluded.updated_at`)
      .run(key, value, encrypted ? 1 : 0, now());
  }

  private setDefaultSettingUnsafe(key: string, value: string, encrypted = false): void {
    this.db.prepare("INSERT OR IGNORE INTO settings(key,value,encrypted,updated_at) VALUES(?,?,?,?)")
      .run(key, value, encrypted ? 1 : 0, now());
  }

  setSetting(key: string, value: string, encrypted = false): void { this.setSettingUnsafe(key, value, encrypted); }
  deleteSetting(key: string): void { this.db.prepare("DELETE FROM settings WHERE key=?").run(key); }
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as SqlRow | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }
  hasPin(): boolean { return Boolean(this.getSetting("pin_hash")); }

  getAccountStatus(): string {
    const row = this.db.prepare("SELECT status FROM accounts WHERE id='local-account'").get() as SqlRow | undefined;
    return String(row?.status ?? "OFFLINE");
  }

  setAccountStatus(status: string, connector = "MANAGED_BROWSER"): void {
    this.db.prepare("UPDATE accounts SET status=?,connector=?,updated_at=? WHERE id='local-account'")
      .run(status, connector, now());
  }

  listProducts(): Product[] {
    const rows = this.db.prepare("SELECT * FROM products ORDER BY release_day, category, name").all() as SqlRow[];
    return rows.map((row) => this.mapProduct(row));
  }

  getProduct(idOrSlug: string): Product | null {
    const row = this.db.prepare("SELECT * FROM products WHERE id=? OR slug=?").get(idOrSlug, idOrSlug) as SqlRow | undefined;
    return row ? this.mapProduct(row) : null;
  }

  private mapProduct(row: SqlRow): Product {
    return {
      id: String(row.id), accountId: String(row.account_id), slug: String(row.slug), category: row.category as Product["category"],
      name: String(row.name), prices: [Number(row.base_price), Number(row.standard_price), Number(row.advanced_price)],
      releaseDay: Number(row.release_day), readiness: row.readiness as Product["readiness"], remoteService: Boolean(row.remote_service),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  updateProductReadiness(id: string, readiness: Product["readiness"]): void {
    this.db.prepare("UPDATE products SET readiness=?, updated_at=? WHERE id=?").run(readiness, now(), id);
  }

  saveContentBundle(productId: string, bundle: ContentBundle, issues: string[]): { id: string; version: number } {
    const versionRow = this.db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM content_bundles WHERE product_id=?").get(productId) as SqlRow;
    const version = Number(versionRow.version);
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare("INSERT INTO content_bundles(id,product_id,version,status,bundle_json,validation_json,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, productId, version, issues.length ? "NEEDS_REVIEW" : "REVIEW_READY", JSON.stringify(bundle), JSON.stringify(issues), now());
      this.updateProductReadiness(productId, issues.length ? "PLANNED" : "CONTENT_READY");
    });
    return { id, version };
  }

  latestContentBundle(productId: string): { id: string; version: number; status: string; bundle: ContentBundle; issues: string[]; createdAt: string } | null {
    const row = this.db.prepare("SELECT * FROM content_bundles WHERE product_id=? ORDER BY version DESC LIMIT 1").get(productId) as SqlRow | undefined;
    return row ? {
      id: String(row.id), version: Number(row.version), status: String(row.status),
      bundle: parseJson(row.bundle_json, {} as ContentBundle), issues: parseJson(row.validation_json, []), createdAt: String(row.created_at)
    } : null;
  }

  listContentBundles(): Array<SqlRow & { bundle: ContentBundle; issues: string[] }> {
    const rows = this.db.prepare(`SELECT cb.*, p.name AS product_name, p.slug AS product_slug FROM content_bundles cb
      JOIN products p ON p.id=cb.product_id ORDER BY cb.created_at DESC`).all() as SqlRow[];
    return rows.map((row) => ({ ...row, bundle: parseJson(row.bundle_json, {} as ContentBundle), issues: parseJson(row.validation_json, []) }));
  }

  createPublication(
    productId: string,
    bundleId: string | null,
    connector: "MOCK" | "MANAGED_BROWSER",
    scheduledAt: string | null,
    initialStatus: PublicationStatus = "APPROVED"
  ): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO publications(id,product_id,content_bundle_id,connector,status,scheduled_at,created_at,updated_at,data_source)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, productId, bundleId, connector, initialStatus, scheduledAt, now(), now(), connector === "MOCK" ? "mock" : "real");
    return id;
  }

  getPublication(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT pub.*, p.name AS product_name, p.slug AS product_slug FROM publications pub
      JOIN products p ON p.id=pub.product_id WHERE pub.id=?`).get(id) as SqlRow | undefined) ?? null;
  }

  listPublications(): SqlRow[] {
    return this.db.prepare(`SELECT pub.*, p.name AS product_name, p.slug AS product_slug FROM publications pub
      JOIN products p ON p.id=pub.product_id ORDER BY COALESCE(pub.scheduled_at,pub.created_at)`).all() as SqlRow[];
  }

  setPublicationStatus(id: string, status: PublicationStatus, result?: unknown): void {
    this.db.prepare("UPDATE publications SET status=?, result_json=COALESCE(?,result_json), updated_at=? WHERE id=?")
      .run(status, result === undefined ? null : JSON.stringify(result), now(), id);
    if (status === "PUBLISHED") {
      this.db.prepare("UPDATE products SET readiness='PUBLISHED', updated_at=? WHERE id=(SELECT product_id FROM publications WHERE id=?)").run(now(), id);
    }
  }

  listConversations(): SqlRow[] {
    return this.db.prepare(`SELECT c.*, p.name AS product_name,
      (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_body,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND direction='inbound') AS inbound_count
      FROM conversations c LEFT JOIN products p ON p.id=c.product_id ORDER BY c.last_message_at DESC`).all() as SqlRow[];
  }

  listMessages(conversationId: string): SqlRow[] {
    return this.db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at").all(conversationId) as SqlRow[];
  }

  getLatestInboundMessage(conversationId: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND direction='inbound' ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .get(conversationId) as SqlRow | undefined) ?? null;
  }

  addMessage(conversationId: string, direction: "inbound" | "outbound", body: string, decision?: unknown): string {
    const id = randomUUID();
    this.transaction(() => {
      const conversation = this.db.prepare("SELECT data_source FROM conversations WHERE id=?").get(conversationId) as SqlRow | undefined;
      this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,decision_json,created_at,data_source) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, conversationId, direction, direction === "inbound" ? "buyer" : "assistant", body, decision ? JSON.stringify(decision) : null, now(), String(conversation?.data_source ?? "local"));
      this.db.prepare("UPDATE conversations SET last_message_at=? WHERE id=?").run(now(), conversationId);
    });
    return id;
  }

  setConversationHandoff(id: string, reason: string | null): void {
    this.db.prepare("UPDATE conversations SET ai_paused=?, handoff_reason=? WHERE id=?").run(reason ? 1 : 0, reason, id);
  }

  getConversation(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT c.*,p.name AS product_name,p.id AS product_id,p.base_price,p.standard_price,p.advanced_price,p.category,p.remote_service
      FROM conversations c LEFT JOIN products p ON p.id=c.product_id WHERE c.id=?`).get(id) as SqlRow | undefined) ?? null;
  }

  listOrders(): SqlRow[] {
    return this.db.prepare(`SELECT o.*,p.name AS product_name,p.category AS product_category,p.remote_service,
      (SELECT status FROM deliveries d WHERE d.order_id=o.id ORDER BY created_at DESC LIMIT 1) AS delivery_status
      FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.updated_at DESC`).all() as SqlRow[];
  }

  getOrder(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT o.*,p.name AS product_name,p.slug AS product_slug,p.category AS product_category,p.remote_service
      FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=?`).get(id) as SqlRow | undefined) ?? null;
  }

  updateOrderStatus(id: string, status: OrderStatus): void {
    this.db.prepare("UPDATE orders SET status=?, updated_at=? WHERE id=?").run(status, now(), id);
  }

  saveConsent(orderId: string, conversationId: string | null, status: "granted" | "withdrawn"): string {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO customer_consents(id,conversation_id,order_id,scope,notice_version,status,granted_at,withdrawn_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, conversationId, orderId, "send_identifiable_files_to_codex", "2026-08-30", status,
        status === "granted" ? timestamp : null, status === "withdrawn" ? timestamp : null, timestamp);
    return id;
  }

  hasActiveConsent(orderId: string): boolean {
    const row = this.db.prepare(`SELECT status FROM customer_consents WHERE order_id=? ORDER BY created_at DESC LIMIT 1`).get(orderId) as SqlRow | undefined;
    return row?.status === "granted";
  }

  upsertDelivery(orderId: string, status: string, mode: string, packagePath?: string): string {
    const existing = this.db.prepare("SELECT id FROM deliveries WHERE order_id=? ORDER BY created_at DESC LIMIT 1").get(orderId) as SqlRow | undefined;
    if (existing) {
      this.db.prepare("UPDATE deliveries SET status=?,mode=?,package_path=COALESCE(?,package_path),updated_at=? WHERE id=?")
        .run(status, mode, packagePath ?? null, now(), String(existing.id));
      return String(existing.id);
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO deliveries(id,order_id,status,mode,package_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, orderId, status, mode, packagePath ?? null, now(), now());
    return id;
  }

  listDeliveries(): SqlRow[] {
    return this.db.prepare(`SELECT d.*,o.buyer_alias,o.tier,p.name AS product_name FROM deliveries d
      JOIN orders o ON o.id=d.order_id JOIN products p ON p.id=o.product_id ORDER BY d.updated_at DESC`).all() as SqlRow[];
  }

  getDelivery(id: string): SqlRow | null {
    return (this.db.prepare(`SELECT d.*,o.buyer_alias,o.tier,p.name AS product_name FROM deliveries d
      JOIN orders o ON o.id=d.order_id JOIN products p ON p.id=o.product_id WHERE d.id=?`).get(id) as SqlRow | undefined) ?? null;
  }

  getDeliveryForOrder(orderId: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM deliveries WHERE order_id=? ORDER BY created_at DESC LIMIT 1")
      .get(orderId) as SqlRow | undefined) ?? null;
  }

  updateDeliveryStatus(id: string, status: DeliveryStatus, receipt?: unknown): void {
    this.db.prepare("UPDATE deliveries SET status=?,receipt_json=COALESCE(?,receipt_json),updated_at=? WHERE id=?")
      .run(status, receipt === undefined ? null : JSON.stringify(redact(receipt)), now(), id);
  }

  saveDeliveryLink(orderId: string, url: string): string {
    const id = this.upsertDelivery(orderId, "READY", "manual_link");
    this.db.prepare("UPDATE deliveries SET share_url=?,status='READY',mode='manual_link',updated_at=? WHERE id=?")
      .run(url, now(), id);
    return id;
  }

  saveRemoteServiceRecord(orderId: string, record: {
    consentSummary: string;
    startedAt?: string;
    endedAt?: string;
    actionSummary: string;
    resultSummary: string;
  }): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO remote_service_records(
      id,order_id,consent_summary,started_at,ended_at,action_summary,result_summary,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      id, orderId, record.consentSummary, record.startedAt ?? null, record.endedAt ?? null,
      record.actionSummary, record.resultSummary, now()
    );
    return id;
  }

  listRemoteServiceRecords(): SqlRow[] {
    return this.db.prepare("SELECT * FROM remote_service_records ORDER BY created_at DESC").all() as SqlRow[];
  }

  saveAsset(input: { productId?: string; orderId?: string; kind: string; path: string; sha256?: string; source: string; expiresAt?: string }): string {
    const existing = this.db.prepare("SELECT id FROM assets WHERE path=?").get(input.path) as SqlRow | undefined;
    if (existing) {
      this.db.prepare("UPDATE assets SET kind=?,source=?,sha256=COALESCE(?,sha256),expires_at=COALESCE(?,expires_at) WHERE id=?")
        .run(input.kind, input.source, input.sha256 ?? null, input.expiresAt ?? null, String(existing.id));
      return String(existing.id);
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO assets(id,product_id,order_id,kind,path,sha256,source,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, input.productId ?? null, input.orderId ?? null, input.kind, input.path, input.sha256 ?? null, input.source, input.expiresAt ?? null, now());
    return id;
  }

  listExpiredAssets(): SqlRow[] {
    return this.db.prepare("SELECT * FROM assets WHERE expires_at IS NOT NULL AND expires_at<? ORDER BY expires_at")
      .all(now()) as SqlRow[];
  }

  deleteAsset(id: string): void { this.db.prepare("DELETE FROM assets WHERE id=?").run(id); }

  listAssets(): SqlRow[] { return this.db.prepare("SELECT * FROM assets ORDER BY created_at").all() as SqlRow[]; }

  enqueueJob(type: string, payload: unknown, idempotencyKey: string, priority = 100): { id: string; inserted: boolean } {
    const id = randomUUID();
    const timestamp = now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO jobs(id,type,status,payload_json,idempotency_key,priority,available_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, type, "QUEUED", JSON.stringify(payload), idempotencyKey, priority, timestamp, timestamp, timestamp);
    if (Number(result.changes) === 0) {
      const existing = this.db.prepare("SELECT id FROM jobs WHERE idempotency_key=?").get(idempotencyKey) as SqlRow;
      return { id: String(existing.id), inserted: false };
    }
    return { id, inserted: true };
  }

  claimJob(workerId: string, leaseSeconds = 30): SqlRow | null {
    return this.transaction(() => {
      const timestamp = now();
      const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const row = this.db.prepare(`SELECT * FROM jobs WHERE
          ((status IN ('QUEUED','RETRY_SCHEDULED') AND available_at<=?) OR
           (status='RUNNING' AND (lease_until IS NULL OR lease_until<?)))
          AND attempt<max_attempts ORDER BY priority,created_at LIMIT 1`).get(timestamp, timestamp) as SqlRow | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE jobs SET status='RUNNING',locked_by=?,lease_until=?,attempt=attempt+1,updated_at=? WHERE id=?")
        .run(workerId, leaseUntil, timestamp, String(row.id));
      return { ...row, status: "RUNNING", locked_by: workerId, lease_until: leaseUntil, attempt: Number(row.attempt) + 1 };
    });
  }

  recoverExpiredJobs(): ExpiredJobRecovery {
    return this.transaction(() => {
      const timestamp = now();
      const recoverableRow = this.db.prepare(`SELECT COUNT(*) AS count FROM jobs
        WHERE status='RUNNING' AND (lease_until IS NULL OR lease_until<?) AND attempt<max_attempts`).get(timestamp) as SqlRow;
      const result = this.db.prepare(`UPDATE jobs SET status='DEAD_LETTER',
        last_error='任务执行租约过期且已达到最大尝试次数',locked_by=NULL,lease_until=NULL,updated_at=?
        WHERE status='RUNNING' AND (lease_until IS NULL OR lease_until<?) AND attempt>=max_attempts`).run(timestamp, timestamp);
      return { recoverable: Number(recoverableRow.count ?? 0), deadLettered: Number(result.changes) };
    });
  }

  finishJob(id: string, status: JobStatus, result?: unknown, error?: string): void {
    this.db.prepare("UPDATE jobs SET status=?,result_json=?,last_error=?,locked_by=NULL,lease_until=NULL,updated_at=? WHERE id=?")
      .run(status, result === undefined ? null : JSON.stringify(redact(result)), error ? String(redact(error)) : null, now(), id);
  }

  rescheduleJob(id: string, error: string, delaySeconds: number): void {
    const availableAt = new Date(Date.now() + Math.max(1, delaySeconds) * 1_000).toISOString();
    this.db.prepare(`UPDATE jobs SET status='RETRY_SCHEDULED',last_error=?,available_at=?,locked_by=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND status='RUNNING'`).run(String(redact(error)), availableAt, now(), id);
  }

  listJobs(limit = 100): SqlRow[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as SqlRow[];
  }

  enqueueAction(action: ActionRequest, connector: "MOCK" | "MANAGED_BROWSER", availableAt = now()): { id: string; inserted: boolean } {
    const timestamp = now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO action_outbox(
      action_id,action_type,target_id,connector,risk,idempotency_key,precondition_fingerprint,payload_json,status,available_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      action.actionId, action.actionType, action.targetId, connector, action.risk, action.idempotencyKey,
      action.preconditionFingerprint, JSON.stringify(action.payload), action.status, availableAt, timestamp, timestamp
    );
    if (Number(result.changes) > 0) return { id: action.actionId, inserted: true };
    const existing = this.db.prepare("SELECT action_id FROM action_outbox WHERE idempotency_key=?")
      .get(action.idempotencyKey) as SqlRow;
    return { id: String(existing.action_id), inserted: false };
  }

  claimMockAction(workerId: string, leaseSeconds = 30): SqlRow | null {
    return this.transaction(() => {
      const timestamp = now();
      const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const row = this.db.prepare(`SELECT * FROM action_outbox WHERE connector='MOCK' AND
        status='QUEUED' AND available_at<=? ORDER BY created_at LIMIT 1`).get(timestamp) as SqlRow | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE action_outbox SET status='EXECUTING',locked_by=?,lease_until=?,attempt=attempt+1,updated_at=? WHERE action_id=?")
        .run(workerId, leaseUntil, timestamp, String(row.action_id));
      return { ...row, status: "EXECUTING", locked_by: workerId, lease_until: leaseUntil, attempt: Number(row.attempt) + 1 };
    });
  }

  recoverExpiredMockActions(maxAttempts = 3): ExpiredMockActionRecovery {
    return this.transaction(() => {
      const timestamp = now();
      const retry = this.db.prepare(`UPDATE action_outbox SET status='QUEUED',available_at=?,locked_by=NULL,lease_until=NULL,
        result_json=?,updated_at=? WHERE connector='MOCK' AND status='EXECUTING'
        AND (lease_until IS NULL OR lease_until<?) AND attempt<?`).run(
          timestamp,
          JSON.stringify({ reason: "模拟动作执行租约过期，已安全放回本地队列", recoveredAt: timestamp }),
          timestamp,
          timestamp,
          Math.max(1, maxAttempts)
        );
      const exhausted = this.db.prepare(`SELECT * FROM action_outbox WHERE connector='MOCK' AND status='EXECUTING'
        AND (lease_until IS NULL OR lease_until<?) AND attempt>=?`).all(timestamp, Math.max(1, maxAttempts)) as SqlRow[];
      let failed = 0;
      for (const action of exhausted) {
        const result = { reason: `模拟动作连续 ${Math.max(1, maxAttempts)} 次执行租约过期，已停止重试`, recoveredAt: timestamp };
        const update = this.db.prepare(`UPDATE action_outbox SET status='FAILED',result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
          WHERE action_id=? AND connector='MOCK' AND status='EXECUTING'`).run(JSON.stringify(result), timestamp, String(action.action_id));
        if (Number(update.changes) !== 1) continue;
        this.markRelatedMockFailureUnsafe(action, result, timestamp);
        failed += 1;
      }
      return { requeued: Number(retry.changes), failed };
    });
  }

  quarantineStaleManagedBrowserActions(): number {
    return this.transaction(() => {
      const timestamp = now();
      const rows = this.db.prepare(`SELECT * FROM action_outbox WHERE connector='MANAGED_BROWSER' AND status='EXECUTING'
        AND (lease_until IS NULL OR lease_until<?)`)
        .all(timestamp) as SqlRow[];
      let count = 0;
      for (const action of rows) {
        const result = {
          reason: "真实浏览器动作执行租约过期，外部结果未知，禁止自动重放",
          recoveredAt: timestamp,
          previousLeaseUntil: action.lease_until ?? null,
          replayAllowed: false
        };
        const update = this.db.prepare(`UPDATE action_outbox SET status='RESULT_UNKNOWN',result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
          WHERE action_id=? AND connector='MANAGED_BROWSER' AND status='EXECUTING'
          AND (lease_until IS NULL OR lease_until<?)`).run(JSON.stringify(result), timestamp, String(action.action_id), timestamp);
        if (Number(update.changes) !== 1) continue;
        this.markRelatedActionUnknownUnsafe(action, result, timestamp);
        count += 1;
      }
      if (count > 0) {
        this.setSettingUnsafe("automation_paused", "true");
        this.db.prepare(`UPDATE browser_runtime SET status='paused',last_error=?,updated_at=? WHERE id='primary'`)
          .run("真实浏览器动作结果未知，自动化已暂停", timestamp);
      }
      return count;
    });
  }

  /** @deprecated Use quarantineStaleManagedBrowserActions for explicit connector semantics. */
  quarantineStaleActions(): number {
    return this.quarantineStaleManagedBrowserActions();
  }

  quarantineExecutingActions(connector: "MOCK" | "MANAGED_BROWSER"): number {
    return this.transaction(() => {
      const timestamp = now();
      const rows = this.db.prepare("SELECT * FROM action_outbox WHERE connector=? AND status='EXECUTING'").all(connector) as SqlRow[];
      let count = 0;
      for (const action of rows) {
        const result = { reason: "连接器进程或连接已中断，外部结果未知，禁止自动重放" };
        const update = this.db.prepare(`UPDATE action_outbox SET status='RESULT_UNKNOWN',result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
          WHERE action_id=? AND status='EXECUTING'`).run(JSON.stringify(result), timestamp, String(action.action_id));
        if (Number(update.changes) !== 1) continue;
        this.markRelatedActionUnknownUnsafe(action, result, timestamp);
        count += 1;
      }
      if (connector === "MANAGED_BROWSER" && count > 0) {
        this.setSettingUnsafe("automation_paused", "true");
        this.db.prepare(`UPDATE browser_runtime SET status='paused',last_error=?,updated_at=? WHERE id='primary'`)
          .run("真实浏览器连接中断，自动化已暂停", timestamp);
      }
      return count;
    });
  }

  sealManagedBrowserActions(reason: string): { cancelled: number; resultUnknown: number } {
    return this.transaction(() => {
      const timestamp = now();
      const sealedResult = { reason, sealedAt: timestamp, replayAllowed: false };
      const pending = this.db.prepare(`SELECT * FROM action_outbox WHERE connector='MANAGED_BROWSER'
        AND status IN ('PROPOSED','WAITING_APPROVAL','APPROVED','QUEUED')`).all() as SqlRow[];
      let cancelled = 0;
      for (const action of pending) {
        const update = this.db.prepare(`UPDATE action_outbox SET status='CANCELLED',result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
          WHERE action_id=? AND connector='MANAGED_BROWSER' AND status IN ('PROPOSED','WAITING_APPROVAL','APPROVED','QUEUED')`)
          .run(JSON.stringify(sealedResult), timestamp, String(action.action_id));
        if (Number(update.changes) !== 1) continue;
        this.restoreRelatedActionAfterSafeCancellationUnsafe(action, sealedResult, timestamp);
        cancelled += 1;
      }

      const executing = this.db.prepare(`SELECT * FROM action_outbox WHERE connector='MANAGED_BROWSER' AND status='EXECUTING'`).all() as SqlRow[];
      let resultUnknown = 0;
      for (const action of executing) {
        const unknownResult = { ...sealedResult, reason: `${reason}；动作已开始，外部结果未知` };
        const update = this.db.prepare(`UPDATE action_outbox SET status='RESULT_UNKNOWN',result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
          WHERE action_id=? AND connector='MANAGED_BROWSER' AND status='EXECUTING'`)
          .run(JSON.stringify(unknownResult), timestamp, String(action.action_id));
        if (Number(update.changes) !== 1) continue;
        this.markRelatedActionUnknownUnsafe(action, unknownResult, timestamp);
        resultUnknown += 1;
      }

      if (cancelled > 0 || resultUnknown > 0) this.setSettingUnsafe("automation_paused", "true");
      this.db.prepare(`UPDATE browser_runtime SET status='paused',last_error=?,updated_at=? WHERE id='primary'`)
        .run(reason, timestamp);
      return { cancelled, resultUnknown };
    });
  }

  peekBrowserAction(): SqlRow | null {
    const row = this.db.prepare(`SELECT * FROM action_outbox WHERE connector='MANAGED_BROWSER' AND status='QUEUED' AND available_at<=?
      ORDER BY available_at,created_at LIMIT 1`).get(now()) as SqlRow | undefined;
    return row ?? null;
  }

  claimBrowserAction(instanceId: string, leaseSeconds = 300, expectedActionId?: string): SqlRow | null {
    return this.transaction(() => {
      const timestamp = now();
      const row = expectedActionId
        ? this.db.prepare(`SELECT * FROM action_outbox WHERE action_id=? AND connector='MANAGED_BROWSER' AND status='QUEUED' AND available_at<=?`)
          .get(expectedActionId, timestamp) as SqlRow | undefined
        : this.db.prepare(`SELECT * FROM action_outbox WHERE connector='MANAGED_BROWSER' AND status='QUEUED' AND available_at<=?
          ORDER BY available_at,created_at LIMIT 1`).get(timestamp) as SqlRow | undefined;
      if (!row) return null;
      const leaseUntil = new Date(Date.now() + leaseSeconds * 1_000).toISOString();
      const claimed = this.db.prepare(`UPDATE action_outbox SET status='EXECUTING',attempt=attempt+1,locked_by=?,lease_until=?,updated_at=?
        WHERE action_id=? AND status='QUEUED'`).run(instanceId, leaseUntil, timestamp, String(row.action_id));
      if (Number(claimed.changes) !== 1) return null;
      const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
      if (row.action_type === "PUBLISH_LISTING") {
        this.db.prepare("UPDATE publications SET status='QUEUED',updated_at=? WHERE id=? AND status='APPROVED'").run(timestamp, String(payload.publicationId));
        this.db.prepare("UPDATE publications SET status='EXECUTING',updated_at=? WHERE id=? AND status='QUEUED'").run(timestamp, String(payload.publicationId));
      } else if (row.action_type === "SEND_DELIVERY") {
        this.db.prepare("UPDATE deliveries SET status='SENDING',updated_at=? WHERE id=? AND status='READY'").run(timestamp, String(payload.deliveryId));
        this.db.prepare("UPDATE orders SET status='DELIVERING',updated_at=? WHERE id=? AND status='READY_TO_DELIVER'").run(timestamp, String(payload.orderId));
      }
      return { ...row, status: "EXECUTING", locked_by: instanceId, lease_until: leaseUntil, attempt: Number(row.attempt) + 1 };
    });
  }

  cancelClaimedBrowserActionBeforeDispatch(id: string, reason: string): boolean {
    return this.transaction(() => {
      const action = this.db.prepare("SELECT * FROM action_outbox WHERE action_id=? AND connector='MANAGED_BROWSER' AND status='EXECUTING'")
        .get(id) as SqlRow | undefined;
      if (!action) return false;
      const timestamp = now();
      const result = { reason, cancelledAt: timestamp, dispatched: false, replayAllowed: false };
      const update = this.db.prepare(`UPDATE action_outbox SET status='CANCELLED',result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
        WHERE action_id=? AND connector='MANAGED_BROWSER' AND status='EXECUTING'`)
        .run(JSON.stringify(result), timestamp, id);
      if (Number(update.changes) !== 1) return false;
      this.restoreRelatedActionAfterSafeCancellationUnsafe(action, result, timestamp);
      return true;
    });
  }

  finishAction(id: string, status: ActionStatus, result?: unknown): boolean {
    const update = this.db.prepare(`UPDATE action_outbox SET status=?,result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
      WHERE action_id=? AND status='EXECUTING'`)
      .run(status, result === undefined ? null : JSON.stringify(redact(result)), now(), id);
    return Number(update.changes) === 1;
  }

  finishMockAction(id: string, status: "SUCCEEDED" | "FAILED" | "RESULT_UNKNOWN", result?: unknown): { completed: boolean; action?: SqlRow } {
    return this.transaction(() => {
      const action = this.db.prepare("SELECT * FROM action_outbox WHERE action_id=? AND connector='MOCK' AND status='EXECUTING'")
        .get(id) as SqlRow | undefined;
      if (!action) return { completed: false };
      const timestamp = now();
      const resultJson = result === undefined ? null : JSON.stringify(redact(result));
      const payload = parseJson<Record<string, unknown>>(action.payload_json, {});

      if (action.action_type === "PUBLISH_LISTING") {
        const publicationStatus = status === "SUCCEEDED" ? "PUBLISHED" : status === "RESULT_UNKNOWN" ? "RESULT_UNKNOWN" : "APPROVED";
        this.db.prepare("UPDATE publications SET status=?,result_json=COALESCE(?,result_json),updated_at=? WHERE id=?")
          .run(publicationStatus, resultJson, timestamp, String(payload.publicationId));
        if (status === "SUCCEEDED") {
          this.db.prepare("UPDATE products SET readiness='PUBLISHED',updated_at=? WHERE id=(SELECT product_id FROM publications WHERE id=?)")
            .run(timestamp, String(payload.publicationId));
        }
      } else if (action.action_type === "SEND_REPLY" && status === "SUCCEEDED") {
        const conversationId = String(payload.conversationId);
        const conversation = this.db.prepare("SELECT data_source FROM conversations WHERE id=?").get(conversationId) as SqlRow | undefined;
        this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,decision_json,created_at,data_source) VALUES(?,?,?,?,?,?,?,?)")
          .run(randomUUID(), conversationId, "outbound", "assistant", String(payload.body), JSON.stringify({ source: "mock-connector", actionId: id }), timestamp, String(conversation?.data_source ?? "mock"));
        this.db.prepare("UPDATE conversations SET last_message_at=? WHERE id=?").run(timestamp, conversationId);
      } else if (action.action_type === "SEND_REPLY" && status === "RESULT_UNKNOWN") {
        this.db.prepare("UPDATE conversations SET ai_paused=1,handoff_reason=?,last_message_at=? WHERE id=?")
          .run("模拟回复结果未知，需要人工核对", timestamp, String(payload.conversationId));
      } else if (action.action_type === "SEND_DELIVERY") {
        const deliveryStatus = status === "SUCCEEDED" ? "SENT" : status === "RESULT_UNKNOWN" ? "SENT_UNCONFIRMED" : "READY";
        const orderStatus = status === "SUCCEEDED" ? "DELIVERED" : status === "RESULT_UNKNOWN" ? "DELIVERING" : "READY_TO_DELIVER";
        this.db.prepare("UPDATE deliveries SET status=?,receipt_json=COALESCE(?,receipt_json),updated_at=? WHERE id=?")
          .run(deliveryStatus, resultJson, timestamp, String(payload.deliveryId));
        this.db.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=?")
          .run(orderStatus, timestamp, String(payload.orderId));
      }

      const update = this.db.prepare(`UPDATE action_outbox SET status=?,result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
        WHERE action_id=? AND connector='MOCK' AND status='EXECUTING'`).run(status, resultJson, timestamp, id);
      if (Number(update.changes) !== 1) throw new Error(`模拟动作状态提交冲突：${id}`);
      return { completed: true, action };
    });
  }

  finishBrowserAction(id: string, status: "SUCCEEDED" | "FAILED" | "RESULT_UNKNOWN", result?: unknown): { completed: boolean; action?: SqlRow } {
    return this.transaction(() => {
      const action = this.db.prepare("SELECT * FROM action_outbox WHERE action_id=? AND connector='MANAGED_BROWSER' AND status='EXECUTING'")
        .get(id) as SqlRow | undefined;
      if (!action) return { completed: false };
      const timestamp = now();
      const update = this.db.prepare(`UPDATE action_outbox SET status=?,result_json=?,locked_by=NULL,lease_until=NULL,updated_at=?
        WHERE action_id=? AND status='EXECUTING'`).run(status, result === undefined ? null : JSON.stringify(redact(result)), timestamp, id);
      if (Number(update.changes) !== 1) return { completed: false };
      const payload = parseJson<Record<string, unknown>>(action.payload_json, {});
      if (action.action_type === "FILL_LISTING") {
        this.db.prepare("UPDATE publications SET result_json=?,updated_at=? WHERE id=? AND status='REVIEW_READY'")
          .run(result === undefined ? null : JSON.stringify(redact(result)), timestamp, String(payload.publicationId));
      } else if (action.action_type === "PUBLISH_LISTING") {
        const publicationStatus = status === "SUCCEEDED" ? "PUBLISHED" : status === "RESULT_UNKNOWN" ? "RESULT_UNKNOWN" : "APPROVED";
        this.db.prepare("UPDATE publications SET status=?,result_json=?,updated_at=? WHERE id=? AND status='EXECUTING'")
          .run(publicationStatus, result === undefined ? null : JSON.stringify(redact(result)), timestamp, String(payload.publicationId));
        if (status === "SUCCEEDED") this.db.prepare("UPDATE products SET readiness='PUBLISHED',updated_at=? WHERE id=(SELECT product_id FROM publications WHERE id=?)")
          .run(timestamp, String(payload.publicationId));
      } else if (action.action_type === "SEND_REPLY" && status === "SUCCEEDED") {
        const conversation = this.db.prepare("SELECT data_source FROM conversations WHERE id=?").get(String(payload.conversationId)) as SqlRow | undefined;
        this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,decision_json,created_at,data_source) VALUES(?,?,?,?,?,?,?,?)")
          .run(randomUUID(), String(payload.conversationId), "outbound", "assistant", String(payload.body), JSON.stringify({ source: "managed-browser" }), timestamp, String(conversation?.data_source ?? "real"));
        this.db.prepare("UPDATE conversations SET last_message_at=? WHERE id=?").run(timestamp, String(payload.conversationId));
      } else if (action.action_type === "SEND_REPLY" && status === "RESULT_UNKNOWN") {
        this.db.prepare("UPDATE conversations SET ai_paused=1,handoff_reason=?,last_message_at=? WHERE id=?")
          .run("回复发送结果未知，需要人工核对页面", timestamp, String(payload.conversationId));
      } else if (action.action_type === "SEND_DELIVERY") {
        const deliveryStatus = status === "SUCCEEDED" ? "SENT" : status === "RESULT_UNKNOWN" ? "SENT_UNCONFIRMED" : "READY";
        const orderStatus = status === "SUCCEEDED" ? "DELIVERED" : status === "RESULT_UNKNOWN" ? "DELIVERING" : "READY_TO_DELIVER";
        this.db.prepare("UPDATE deliveries SET status=?,receipt_json=?,updated_at=? WHERE id=? AND status='SENDING'")
          .run(deliveryStatus, result === undefined ? null : JSON.stringify(redact(result)), timestamp, String(payload.deliveryId));
        this.db.prepare("UPDATE orders SET status=?,updated_at=? WHERE id=? AND status='DELIVERING'")
          .run(orderStatus, timestamp, String(payload.orderId));
      }
      return { completed: true, action };
    });
  }

  private markRelatedActionUnknownUnsafe(action: SqlRow, result: unknown, timestamp: string): void {
    const payload = parseJson<Record<string, unknown>>(action.payload_json, {});
    const resultJson = JSON.stringify(redact(result));
    if (action.action_type === "FILL_LISTING") {
      this.db.prepare("UPDATE publications SET status='RESULT_UNKNOWN',result_json=?,updated_at=? WHERE id=? AND status='REVIEW_READY'")
        .run(resultJson, timestamp, String(payload.publicationId));
    } else if (action.action_type === "PUBLISH_LISTING") {
      this.db.prepare("UPDATE publications SET status='RESULT_UNKNOWN',result_json=?,updated_at=? WHERE id=? AND status IN ('QUEUED','EXECUTING')")
        .run(resultJson, timestamp, String(payload.publicationId));
    } else if (action.action_type === "SEND_REPLY") {
      this.db.prepare("UPDATE conversations SET ai_paused=1,handoff_reason=?,last_message_at=? WHERE id=?")
        .run("回复发送结果未知，需要人工核对页面", timestamp, String(payload.conversationId));
    } else if (action.action_type === "SEND_DELIVERY") {
      this.db.prepare("UPDATE deliveries SET status='SENT_UNCONFIRMED',receipt_json=?,updated_at=? WHERE id=? AND status='SENDING'")
        .run(resultJson, timestamp, String(payload.deliveryId));
      this.db.prepare("UPDATE orders SET status='DELIVERING',updated_at=? WHERE id=? AND status='DELIVERING'")
        .run(timestamp, String(payload.orderId));
    }
  }

  private restoreRelatedActionAfterSafeCancellationUnsafe(action: SqlRow, result: unknown, timestamp: string): void {
    const payload = parseJson<Record<string, unknown>>(action.payload_json, {});
    const resultJson = JSON.stringify(redact(result));
    if (action.action_type === "PUBLISH_LISTING") {
      this.db.prepare("UPDATE publications SET status='REVIEW_READY',result_json=?,updated_at=? WHERE id=? AND status IN ('APPROVED','QUEUED','EXECUTING')")
        .run(resultJson, timestamp, String(payload.publicationId));
    } else if (action.action_type === "SEND_DELIVERY") {
      this.db.prepare("UPDATE deliveries SET status='READY',receipt_json=?,updated_at=? WHERE id=? AND status='SENDING'")
        .run(resultJson, timestamp, String(payload.deliveryId));
      this.db.prepare("UPDATE orders SET status='READY_TO_DELIVER',updated_at=? WHERE id=? AND status='DELIVERING'")
        .run(timestamp, String(payload.orderId));
    }
  }

  private markRelatedMockFailureUnsafe(action: SqlRow, result: unknown, timestamp: string): void {
    const payload = parseJson<Record<string, unknown>>(action.payload_json, {});
    const resultJson = JSON.stringify(redact(result));
    if (action.action_type === "PUBLISH_LISTING") {
      this.db.prepare("UPDATE publications SET status='APPROVED',result_json=?,updated_at=? WHERE id=? AND status='EXECUTING'")
        .run(resultJson, timestamp, String(payload.publicationId));
    } else if (action.action_type === "SEND_REPLY") {
      this.db.prepare("UPDATE conversations SET ai_paused=1,handoff_reason=?,last_message_at=? WHERE id=?")
        .run("模拟回复任务连续中断，需要人工检查", timestamp, String(payload.conversationId));
    } else if (action.action_type === "SEND_DELIVERY") {
      this.db.prepare("UPDATE deliveries SET status='READY',receipt_json=?,updated_at=? WHERE id=? AND status='SENDING'")
        .run(resultJson, timestamp, String(payload.deliveryId));
      this.db.prepare("UPDATE orders SET status='READY_TO_DELIVER',updated_at=? WHERE id=? AND status='DELIVERING'")
        .run(timestamp, String(payload.orderId));
    }
  }

  approveAction(id: string): boolean {
    const result = this.db.prepare("UPDATE action_outbox SET status='QUEUED',updated_at=? WHERE action_id=? AND status='WAITING_APPROVAL'")
      .run(now(), id);
    return Number(result.changes) > 0;
  }

  listActions(limit = 100): SqlRow[] {
    return this.db.prepare("SELECT * FROM action_outbox ORDER BY created_at DESC LIMIT ?").all(limit) as SqlRow[];
  }

  getLatestActionForTarget(targetId: string, actionType?: string): SqlRow | null {
    const row = actionType
      ? this.db.prepare("SELECT * FROM action_outbox WHERE target_id=? AND action_type=? ORDER BY created_at DESC LIMIT 1").get(targetId, actionType)
      : this.db.prepare("SELECT * FROM action_outbox WHERE target_id=? ORDER BY created_at DESC LIMIT 1").get(targetId);
    return (row as SqlRow | undefined) ?? null;
  }

  getAction(id: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM action_outbox WHERE action_id=?").get(id) as SqlRow | undefined) ?? null;
  }

  setBrowserRuntime(status: string, details: { connector?: string; pageType?: string; domFingerprint?: string; lastError?: string } = {}): void {
    this.db.prepare(`UPDATE browser_runtime SET status=?,connector=COALESCE(?,connector),page_type=COALESCE(?,page_type),
      dom_fingerprint=COALESCE(?,dom_fingerprint),last_error=?,last_heartbeat_at=?,updated_at=? WHERE id='primary'`)
      .run(status, details.connector ?? null, details.pageType ?? null, details.domFingerprint ?? null, details.lastError ?? null, now(), now());
  }

  getBrowserRuntime(): SqlRow {
    return (this.db.prepare("SELECT * FROM browser_runtime WHERE id='primary'").get() as SqlRow | undefined) ?? { status: "offline", connector: "MOCK" };
  }

  markBrowserRuntimeOfflineOnStartup(): void {
    this.transaction(() => {
      const timestamp = now();
      const runtime = this.getBrowserRuntime();
      const connector = String(runtime.connector ?? "MOCK");
      this.db.prepare(`UPDATE browser_runtime SET status='offline',page_type=NULL,dom_fingerprint=NULL,
        last_error=NULL,last_heartbeat_at=NULL,updated_at=? WHERE id='primary'`).run(timestamp);
      this.db.prepare("UPDATE accounts SET status='OFFLINE',connector=?,updated_at=? WHERE id='local-account'")
        .run(connector, timestamp);
      this.db.prepare("DELETE FROM settings WHERE key IN ('browser_page_meta','browser_visible_target')").run();
    });
  }

  createPairing(codeHash: string, expiresAt: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO extension_pairings(id,code_hash,status,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(id, codeHash, "pending", expiresAt, now());
    return id;
  }

  consumePairing(codeHash: string, tokenHash: string): boolean {
    return this.transaction(() => {
      const timestamp = now();
      const pairing = this.db.prepare(`SELECT id FROM extension_pairings
        WHERE code_hash=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1`).get(codeHash, timestamp) as SqlRow | undefined;
      if (!pairing) return false;
      this.db.prepare("UPDATE extension_pairings SET status='revoked',revoked_at=? WHERE status='paired' AND revoked_at IS NULL")
        .run(timestamp);
      const tokenExpiresAt = new Date(Date.now() + EXTENSION_TOKEN_TTL_MS).toISOString();
      const result = this.db.prepare(`UPDATE extension_pairings SET token_hash=?,status='paired',paired_at=?,token_expires_at=?,last_used_at=?,
        revoked_at=NULL,connection_id=? WHERE id=? AND status='pending'`)
        .run(tokenHash, timestamp, tokenExpiresAt, timestamp, randomUUID(), String(pairing.id));
      return Number(result.changes) === 1;
    });
  }

  validateExtensionToken(token: string): boolean {
    if (!token) return false;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const timestamp = now();
    const row = this.db.prepare(`SELECT id FROM extension_pairings WHERE token_hash=? AND status='paired' AND revoked_at IS NULL
      AND token_expires_at>?`).get(tokenHash, timestamp) as SqlRow | undefined;
    if (!row) return false;
    const tokenExpiresAt = new Date(Date.now() + EXTENSION_TOKEN_TTL_MS).toISOString();
    this.db.prepare("UPDATE extension_pairings SET last_used_at=?,token_expires_at=? WHERE id=?")
      .run(timestamp, tokenExpiresAt, String(row.id));
    return true;
  }

  touchExtensionTokenHash(tokenHash: string): boolean {
    if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return false;
    const timestamp = now();
    const activeSince = new Date(Date.now() - EXTENSION_HEARTBEAT_GRACE_MS).toISOString();
    const tokenExpiresAt = new Date(Date.now() + EXTENSION_TOKEN_TTL_MS).toISOString();
    const result = this.db.prepare(`UPDATE extension_pairings SET last_used_at=?,token_expires_at=?
      WHERE token_hash=? AND status='paired' AND revoked_at IS NULL AND token_expires_at>? AND last_used_at>?`)
      .run(timestamp, tokenExpiresAt, tokenHash, timestamp, activeSince);
    return Number(result.changes) === 1;
  }

  getExtensionPairingStatus(): { paired: boolean; tokenExpiresAt: string | null; lastUsedAt: string | null } {
    const row = this.db.prepare(`SELECT token_expires_at,last_used_at FROM extension_pairings
      WHERE status='paired' AND revoked_at IS NULL AND token_expires_at>? ORDER BY paired_at DESC LIMIT 1`).get(now()) as SqlRow | undefined;
    return {
      paired: Boolean(row),
      tokenExpiresAt: typeof row?.token_expires_at === "string" ? row.token_expires_at : null,
      lastUsedAt: typeof row?.last_used_at === "string" ? row.last_used_at : null
    };
  }

  upsertCodexThread(scopeType: string, scopeId: string, title: string, codexThreadId?: string, status = "ready"): string {
    const existing = this.db.prepare("SELECT id FROM codex_threads WHERE scope_type=? AND scope_id=?").get(scopeType, scopeId) as SqlRow | undefined;
    const id = existing ? String(existing.id) : randomUUID();
    this.db.prepare(`INSERT INTO codex_threads(id,scope_type,scope_id,codex_thread_id,status,title,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope_type,scope_id) DO UPDATE SET
      codex_thread_id=COALESCE(excluded.codex_thread_id,codex_threads.codex_thread_id),status=excluded.status,title=excluded.title,updated_at=excluded.updated_at`)
      .run(id, scopeType, scopeId, codexThreadId ?? null, status, title, now(), now());
    return id;
  }

  getCodexThread(scopeType: string, scopeId: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM codex_threads WHERE scope_type=? AND scope_id=?").get(scopeType, scopeId) as SqlRow | undefined) ?? null;
  }

  listCodexThreads(): SqlRow[] { return this.db.prepare("SELECT * FROM codex_threads ORDER BY updated_at DESC").all() as SqlRow[]; }

  recordCodexThreadEvent(codexThreadId: string, event: unknown, status?: string): void {
    this.db.prepare(`UPDATE codex_threads SET last_event_json=?,status=COALESCE(?,status),updated_at=? WHERE codex_thread_id=?`)
      .run(JSON.stringify(redact(event)), status ?? null, now(), codexThreadId);
  }

  saveCodexApproval(id: string, method: string, params: unknown, receivedAt: string): void {
    this.db.prepare(`INSERT INTO codex_approvals(id,method,params_json,status,received_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET method=excluded.method,params_json=excluded.params_json,status='pending',decision=NULL,
      received_at=excluded.received_at,resolved_at=NULL`)
      .run(id, method, JSON.stringify(redact(params)), "pending", receivedAt);
  }

  resolveCodexApproval(id: string, decision: string): void {
    this.db.prepare("UPDATE codex_approvals SET status='resolved',decision=?,resolved_at=? WHERE id=? AND status='pending'")
      .run(decision, now(), id);
  }

  expirePendingCodexApprovals(): number {
    return Number(this.db.prepare("UPDATE codex_approvals SET status='expired',resolved_at=? WHERE status='pending'").run(now()).changes);
  }

  listCodexApprovals(limit = 100): SqlRow[] {
    return this.db.prepare("SELECT * FROM codex_approvals ORDER BY received_at DESC LIMIT ?").all(limit) as SqlRow[];
  }

  savePermissionGrant(input: { codexThreadId?: string; turnId?: string; path: string; access: string; scope: string; expiresAt: string }): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO permission_grants(id,codex_thread_id,turn_id,path,access,scope,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      id, input.codexThreadId ?? null, input.turnId ?? null, input.path, input.access, input.scope, input.expiresAt, now()
    );
    return id;
  }

  audit(actor: string, eventType: string, summary: string, details: unknown = {}, targetType?: string, targetId?: string, correlationId = randomUUID()): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO audit_logs(id,actor,event_type,target_type,target_id,correlation_id,summary,details_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, actor, eventType, targetType ?? null, targetId ?? null, correlationId, summary, JSON.stringify(redact(details)), now());
    return id;
  }

  listAudit(limit = 100): SqlRow[] { return this.db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?").all(limit) as SqlRow[]; }

  recordBackup(kind: string, path: string, sha256: string, status = "ready"): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO backup_records(id,kind,path,sha256,status,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, kind, path, sha256, status, now());
    return id;
  }

  saveMetricSnapshot(input: {
    source: "real_visible" | "local";
    accountId?: string;
    pageType: string;
    pageUrl: string;
    adapterVersion?: string;
    domFingerprint?: string;
    metrics: Record<string, number>;
    capturedAt?: string;
  }): string | null {
    const metricsJson = JSON.stringify(redact(input.metrics));
    const latest = this.db.prepare(`SELECT metrics_json,captured_at FROM metric_snapshots
      WHERE source=? AND page_type=? AND page_url=? AND COALESCE(account_id,'')=COALESCE(?,'') ORDER BY captured_at DESC LIMIT 1`)
      .get(input.source, input.pageType, input.pageUrl, input.accountId ?? null) as SqlRow | undefined;
    if (latest?.metrics_json === metricsJson && Date.now() - Date.parse(String(latest.captured_at)) < 15 * 60 * 1_000) return null;
    const id = randomUUID();
    const capturedAt = input.capturedAt ?? now();
    const receivedAt = now();
    this.db.prepare(`INSERT INTO metric_snapshots(id,source,page_type,page_url,adapter_version,metrics_json,captured_at,created_at,account_id,dom_fingerprint,received_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.source, input.pageType, input.pageUrl, input.adapterVersion ?? null, metricsJson, capturedAt, receivedAt,
        input.accountId ?? null, input.domFingerprint ?? null, receivedAt);
    return id;
  }

  listMetricSnapshots(limit = 100): Array<SqlRow & { metrics: Record<string, number> }> {
    return (this.db.prepare("SELECT * FROM metric_snapshots ORDER BY captured_at DESC LIMIT ?").all(limit) as SqlRow[])
      .map((row) => ({ ...row, metrics: parseJson<Record<string, number>>(row.metrics_json, {}) }));
  }

  saveDailyReport(input: { reportDate: string; source: string; summary: string; metrics: unknown; suggestions: string[] }): string {
    const existing = this.db.prepare("SELECT id FROM daily_reports WHERE report_date=? AND source=?").get(input.reportDate, input.source) as SqlRow | undefined;
    const id = String(existing?.id ?? randomUUID());
    this.db.prepare(`INSERT INTO daily_reports(id,report_date,source,summary,metrics_json,suggestions_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(report_date,source) DO UPDATE SET
      summary=excluded.summary,metrics_json=excluded.metrics_json,suggestions_json=excluded.suggestions_json,updated_at=excluded.updated_at`)
      .run(id, input.reportDate, input.source, input.summary, JSON.stringify(redact(input.metrics)), JSON.stringify(input.suggestions), now(), now());
    return id;
  }

  listDailyReports(limit = 30): Array<SqlRow & { metrics: unknown; suggestions: string[] }> {
    return (this.db.prepare("SELECT * FROM daily_reports ORDER BY report_date DESC,updated_at DESC LIMIT ?").all(limit) as SqlRow[])
      .map((row) => ({ ...row, metrics: parseJson(row.metrics_json, {}), suggestions: parseJson<string[]>(row.suggestions_json, []) }));
  }

  saveDailyReportDraft(input: { reportDate: string; source: string; content: string; isCustom: boolean }): SqlRow {
    const existing = this.db.prepare("SELECT created_at FROM daily_report_drafts WHERE report_date=? AND source=?")
      .get(input.reportDate, input.source) as SqlRow | undefined;
    const timestamp = now();
    this.db.prepare(`INSERT INTO daily_report_drafts(report_date,source,content,is_custom,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(report_date,source) DO UPDATE SET
      content=excluded.content,is_custom=excluded.is_custom,updated_at=excluded.updated_at`)
      .run(input.reportDate, input.source, input.content, input.isCustom ? 1 : 0, String(existing?.created_at ?? timestamp), timestamp);
    return this.getDailyReportDraft(input.reportDate, input.source)!;
  }

  getDailyReportDraft(reportDate: string, source: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM daily_report_drafts WHERE report_date=? AND source=?")
      .get(reportDate, source) as SqlRow | undefined) ?? null;
  }

  upsertPlatformTargetBinding(input: PlatformTargetBindingInput): SqlRow {
    return this.upsertPlatformTargetBindingUnsafe(input);
  }

  private upsertPlatformTargetBindingUnsafe(input: PlatformTargetBindingInput): SqlRow {
    const timestamp = now();
    if (!input.externalConversationId || !input.productExternalId) throw new Error("目标绑定缺少外部会话或商品编号");
    if (input.bindingType === "order" && !input.externalOrderId) throw new Error("订单目标绑定缺少外部订单编号");
    const externalField = input.bindingType === "conversation" ? "external_conversation_id" : "external_order_id";
    const externalValue = input.bindingType === "conversation" ? input.externalConversationId : input.externalOrderId!;
    const duplicate = this.db.prepare(`SELECT internal_id FROM platform_target_bindings
      WHERE binding_type=? AND ${externalField}=? AND internal_id!=? AND status!='REVOKED' LIMIT 1`)
      .get(input.bindingType, externalValue, input.internalId) as SqlRow | undefined;
    if (duplicate) throw new Error("当前闲鱼目标已经绑定到另一条本地记录");
    const existing = this.db.prepare("SELECT id,created_at FROM platform_target_bindings WHERE binding_type=? AND internal_id=?")
      .get(input.bindingType, input.internalId) as SqlRow | undefined;
    const id = String(existing?.id ?? randomUUID());
    this.db.prepare(`INSERT INTO platform_target_bindings(
      id,binding_type,internal_id,account_id,external_conversation_id,external_order_id,buyer_public_id,product_external_id,amount_cents,
      page_url,tab_id,account_fingerprint,dom_fingerprint,adapter_version,observed_at,binding_fingerprint,status,evidence_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(binding_type,internal_id) DO UPDATE SET
      account_id=excluded.account_id,external_conversation_id=excluded.external_conversation_id,external_order_id=excluded.external_order_id,
      buyer_public_id=excluded.buyer_public_id,product_external_id=excluded.product_external_id,amount_cents=excluded.amount_cents,page_url=excluded.page_url,
      tab_id=excluded.tab_id,account_fingerprint=excluded.account_fingerprint,dom_fingerprint=excluded.dom_fingerprint,adapter_version=excluded.adapter_version,
      observed_at=excluded.observed_at,binding_fingerprint=excluded.binding_fingerprint,status=excluded.status,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
      .run(id, input.bindingType, input.internalId, input.accountId, input.externalConversationId ?? null, input.externalOrderId ?? null,
        input.buyerPublicId, input.productExternalId ?? null, input.amountCents ?? null, input.pageUrl, input.tabId, input.accountFingerprint,
        input.domFingerprint, input.adapterVersion, input.observedAt, input.bindingFingerprint, input.status, JSON.stringify(redact(input.evidence ?? {})),
        String(existing?.created_at ?? timestamp), timestamp);
    return this.getPlatformTargetBinding(input.bindingType, input.internalId)!;
  }

  getPlatformTargetBinding(bindingType: "conversation" | "order", internalId: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM platform_target_bindings WHERE binding_type=? AND internal_id=?")
      .get(bindingType, internalId) as SqlRow | undefined) ?? null;
  }

  getPlatformTargetBindingByExternal(bindingType: "conversation" | "order", externalId: string): SqlRow | null {
    const field = bindingType === "conversation" ? "external_conversation_id" : "external_order_id";
    return (this.db.prepare(`SELECT * FROM platform_target_bindings WHERE binding_type=? AND ${field}=? AND status!='REVOKED'
      ORDER BY updated_at DESC LIMIT 1`).get(bindingType, externalId) as SqlRow | undefined) ?? null;
  }

  setPlatformTargetBindingStatus(
    bindingType: "conversation" | "order",
    internalId: string,
    status: "CONFIRMED" | "TEST_VERIFIED" | "REVOKED"
  ): boolean {
    return Number(this.db.prepare("UPDATE platform_target_bindings SET status=?,updated_at=? WHERE binding_type=? AND internal_id=? AND status!='REVOKED'")
      .run(status, now(), bindingType, internalId).changes) === 1;
  }

  captureRealConversation(input: {
    productId: string;
    buyerAlias: string;
    initialInboundMessage?: string;
    binding: Omit<PlatformTargetBindingInput, "bindingType" | "internalId">;
  }): { id: string; created: boolean; binding: SqlRow } {
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT internal_id FROM platform_target_bindings
        WHERE binding_type='conversation' AND external_conversation_id=? AND status!='REVOKED' ORDER BY updated_at DESC LIMIT 1`)
        .get(input.binding.externalConversationId ?? "") as SqlRow | undefined;
      if (existing) {
        const conversation = this.getConversation(String(existing.internal_id));
        if (!conversation || String(conversation.product_id) !== input.productId || String(conversation.data_source) !== "real") {
          throw new Error("当前闲鱼会话已绑定到另一条本地记录或商品");
        }
        if (input.initialInboundMessage) {
          const latest = this.getLatestInboundMessage(String(existing.internal_id));
          if (!latest || String(latest.body) !== input.initialInboundMessage) {
            const timestamp = now();
            this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
              .run(randomUUID(), String(existing.internal_id), "inbound", "buyer", input.initialInboundMessage, timestamp, "real");
            this.db.prepare("UPDATE conversations SET last_message_at=? WHERE id=?").run(timestamp, String(existing.internal_id));
          }
        }
        const binding = this.upsertPlatformTargetBindingUnsafe({ ...input.binding, bindingType: "conversation", internalId: String(existing.internal_id) });
        return { id: String(existing.internal_id), created: false, binding };
      }
      const id = randomUUID();
      const timestamp = now();
      this.db.prepare("INSERT INTO conversations(id,product_id,buyer_alias,ai_paused,last_message_at,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
        .run(id, input.productId, input.buyerAlias, 0, timestamp, timestamp, "real");
      if (input.initialInboundMessage) {
        this.db.prepare("INSERT INTO messages(id,conversation_id,direction,sender,body,created_at,data_source) VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(), id, "inbound", "buyer", input.initialInboundMessage, timestamp, "real");
      }
      const binding = this.upsertPlatformTargetBindingUnsafe({ ...input.binding, bindingType: "conversation", internalId: id });
      return { id, created: true, binding };
    });
  }

  captureRealOrder(input: {
    productId: string;
    conversationId: string;
    buyerAlias: string;
    orderType: "fixed_digital" | "semi_custom" | "remote_service";
    tier: "基础" | "标准" | "进阶";
    paidPrice: number;
    revisionLimit: 1 | 2 | 3;
    binding: Omit<PlatformTargetBindingInput, "bindingType" | "internalId">;
  }): { id: string; created: boolean; binding: SqlRow } {
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT internal_id FROM platform_target_bindings
        WHERE binding_type='order' AND external_order_id=? AND status!='REVOKED' ORDER BY updated_at DESC LIMIT 1`)
        .get(input.binding.externalOrderId ?? "") as SqlRow | undefined;
      if (existing) {
        const order = this.getOrder(String(existing.internal_id));
        if (!order || String(order.product_id) !== input.productId || String(order.conversation_id) !== input.conversationId || String(order.data_source) !== "real") {
          throw new Error("当前闲鱼订单已绑定到另一条本地记录、会话或商品");
        }
        const binding = this.upsertPlatformTargetBindingUnsafe({ ...input.binding, bindingType: "order", internalId: String(existing.internal_id) });
        return { id: String(existing.internal_id), created: false, binding };
      }
      const id = randomUUID();
      const timestamp = now();
      this.db.prepare(`INSERT INTO orders(
        id,account_id,product_id,conversation_id,buyer_alias,order_type,status,tier,quoted_price,paid_price,revision_limit,intake_json,created_at,updated_at,data_source
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, "local-account", input.productId, input.conversationId, input.buyerAlias, input.orderType, "NEW", input.tier,
        input.paidPrice, input.paidPrice, input.revisionLimit, JSON.stringify({ source: "visible_order_capture", missing: [] }), timestamp, timestamp, "real"
      );
      const binding = this.upsertPlatformTargetBindingUnsafe({ ...input.binding, bindingType: "order", internalId: id });
      return { id, created: true, binding };
    });
  }

  revokePlatformTargetBinding(bindingType: "conversation" | "order", internalId: string): boolean {
    return Number(this.db.prepare("UPDATE platform_target_bindings SET status='REVOKED',updated_at=? WHERE binding_type=? AND internal_id=? AND status!='REVOKED'")
      .run(now(), bindingType, internalId).changes) === 1;
  }

  createImageGenTask(input: {
    productId: string;
    contentVersion: number;
    codexThreadId: string;
    codexTurnId?: string;
    beforePath: string;
    beforeSha256: string;
    candidatePath: string;
  }): SqlRow {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO imagegen_tasks(
      id,product_id,content_version,codex_thread_id,codex_turn_id,before_path,before_sha256,candidate_path,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.productId, input.contentVersion, input.codexThreadId, input.codexTurnId ?? null,
      input.beforePath, input.beforeSha256, input.candidatePath, "RUNNING", timestamp, timestamp);
    return this.getImageGenTask(id)!;
  }

  getImageGenTask(id: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM imagegen_tasks WHERE id=?").get(id) as SqlRow | undefined) ?? null;
  }

  latestImageGenTask(productId: string): SqlRow | null {
    return (this.db.prepare("SELECT * FROM imagegen_tasks WHERE product_id=? ORDER BY created_at DESC LIMIT 1")
      .get(productId) as SqlRow | undefined) ?? null;
  }

  finishImageGenTask(id: string, status: "SUCCEEDED" | "WAITING_USER" | "FAILED", resultValue: unknown): boolean {
    return Number(this.db.prepare(`UPDATE imagegen_tasks SET status=?,result_json=?,updated_at=?
      WHERE id=? AND status IN ('RUNNING','VERIFYING','WAITING_USER')`).run(status, JSON.stringify(redact(resultValue)), now(), id).changes) === 1;
  }

  markImageGenTaskVerifying(id: string): boolean {
    return Number(this.db.prepare("UPDATE imagegen_tasks SET status='VERIFYING',updated_at=? WHERE id=? AND status IN ('RUNNING','WAITING_USER')")
      .run(now(), id).changes) === 1;
  }

  dashboard(): DashboardSnapshot {
    const products = this.listProducts();
    const counts: DashboardSnapshot["productCounts"] = { PLANNED: 0, CONTENT_READY: 0, READY_TO_PUBLISH: 0, PUBLISHED: 0 };
    products.forEach((product) => { counts[product.readiness] += 1; });
    const scalar = (sql: string) => Number((this.db.prepare(sql).get() as SqlRow)?.count ?? 0);
    const account = this.db.prepare("SELECT status FROM accounts WHERE id='local-account'").get() as SqlRow;
    const browser = this.getBrowserRuntime();
    const attention: DashboardSnapshot["attention"] = [];
    const risky = this.db.prepare(`SELECT action_id,action_type,status,updated_at FROM action_outbox
      WHERE status IN ('WAITING_APPROVAL','RESULT_UNKNOWN','FAILED') ORDER BY updated_at DESC LIMIT 5`).all() as SqlRow[];
    risky.forEach((row) => attention.push({
      id: String(row.action_id), kind: String(row.status), title: String(row.action_type),
      reason: row.status === "RESULT_UNKNOWN" ? "外部结果不明，禁止自动重试" : row.status === "FAILED" ? "外部动作失败，需要人工检查" : "需要人工审批", createdAt: String(row.updated_at)
    }));
    const waitingOrders = this.db.prepare(`SELECT id,status,updated_at FROM orders WHERE data_source!='demo' AND status IN ('NEEDS_INTAKE','REFUND_REVIEW') ORDER BY updated_at DESC LIMIT 5`).all() as SqlRow[];
    waitingOrders.forEach((row) => attention.push({
      id: String(row.id), kind: String(row.status), title: `订单 ${row.id}`,
      reason: row.status === "REFUND_REVIEW" ? "退款必须人工执行" : "等待补齐材料", createdAt: String(row.updated_at)
    }));
    return {
      automationPaused: this.getSetting("automation_paused") === "true",
      accountStatus: String(account.status ?? "OFFLINE") as DashboardSnapshot["accountStatus"],
      codexStatus: "unavailable",
      browserStatus: String(browser.status ?? "offline") as DashboardSnapshot["browserStatus"],
      productCounts: counts,
      pendingApprovals: scalar("SELECT COUNT(*) AS count FROM action_outbox WHERE status='WAITING_APPROVAL'"),
      resultUnknownActions: scalar("SELECT COUNT(*) AS count FROM action_outbox WHERE status='RESULT_UNKNOWN'"),
      pendingJobs: scalar("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('QUEUED','RUNNING','WAITING_USER','WAITING_APPROVAL','RETRY_SCHEDULED')"),
      activeOrders: scalar("SELECT COUNT(*) AS count FROM orders WHERE data_source!='demo' AND status NOT IN ('DELIVERED','REFUND_REVIEW')"),
      todayRevenue: Number((this.db.prepare("SELECT COALESCE(SUM(paid_price),0) AS total FROM orders WHERE data_source!='demo' AND status='DELIVERED' AND date(updated_at)=date('now','localtime')").get() as SqlRow).total ?? 0),
      attention: attention.slice(0, 8)
    };
  }

  cleanupExpired(): {
    assets: number;
    messages: number;
    orders: number;
    conversations: number;
    audit: number;
    grants: number;
    outboxRedacted: number;
    targetBindingsDeleted: number;
  } {
    const retention = parseJson(this.getSetting("retention_days"), { sources: 30, deliverables: 90, chats: 180, audit: 365 });
    return this.transaction(() => {
      const activeActionReferences = new Set<string>();
      const activeActions = this.db.prepare(`SELECT target_id,payload_json FROM action_outbox
        WHERE status NOT IN ('SUCCEEDED','FAILED','RESULT_UNKNOWN','CANCELLED')`).all() as SqlRow[];
      const referenceKeys = new Set(["conversationId", "orderId", "deliveryId", "publicationId", "internalId", "internal_id", "targetId"]);
      const collectReferences = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach(collectReferences);
          return;
        }
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          if (referenceKeys.has(key) && typeof nested === "string" && nested) activeActionReferences.add(nested);
          collectReferences(nested);
        }
      };
      for (const action of activeActions) {
        if (typeof action.target_id === "string" && action.target_id) activeActionReferences.add(action.target_id);
        collectReferences(parseJson(action.payload_json, {}));
      }

      const protectedConversationIds = new Set<string>();
      for (const reference of activeActionReferences) {
        const conversation = this.db.prepare("SELECT id FROM conversations WHERE id=?").get(reference) as SqlRow | undefined;
        if (conversation) protectedConversationIds.add(String(conversation.id));
        const order = this.db.prepare("SELECT conversation_id FROM orders WHERE id=?").get(reference) as SqlRow | undefined;
        if (typeof order?.conversation_id === "string") protectedConversationIds.add(order.conversation_id);
        const deliveryOrder = this.db.prepare(`SELECT orders.conversation_id FROM deliveries
          JOIN orders ON orders.id=deliveries.order_id WHERE deliveries.id=?`).get(reference) as SqlRow | undefined;
        if (typeof deliveryOrder?.conversation_id === "string") protectedConversationIds.add(deliveryOrder.conversation_id);
      }

      const expiredMessages = this.db.prepare(`SELECT id,conversation_id FROM messages WHERE created_at<datetime('now', ?)`)
        .all(`-${retention.chats} days`) as SqlRow[];
      let deletedMessages = 0;
      for (const message of expiredMessages) {
        if (protectedConversationIds.has(String(message.conversation_id))) continue;
        deletedMessages += Number(this.db.prepare("DELETE FROM messages WHERE id=?").run(String(message.id)).changes);
      }
      const terminalOrders = this.db.prepare(`SELECT id FROM orders WHERE status IN ('DELIVERED','REFUND_REVIEW') AND updated_at<datetime('now', ?)`)
        .all(`-${retention.chats} days`) as SqlRow[];
      let deletedOrders = 0;
      for (const row of terminalOrders) {
        const id = String(row.id);
        const deliveryIds = (this.db.prepare("SELECT id FROM deliveries WHERE order_id=?").all(id) as SqlRow[]).map((delivery) => String(delivery.id));
        if (activeActionReferences.has(id) || deliveryIds.some((deliveryId) => activeActionReferences.has(deliveryId))) continue;
        this.db.prepare("DELETE FROM remote_service_records WHERE order_id=?").run(id);
        this.db.prepare("DELETE FROM deliveries WHERE order_id=?").run(id);
        this.db.prepare("DELETE FROM customer_consents WHERE order_id=?").run(id);
        this.db.prepare("DELETE FROM orders WHERE id=?").run(id);
        deletedOrders += 1;
      }
      const expiredConversations = this.db.prepare(`SELECT id FROM conversations WHERE last_message_at<datetime('now', ?)
        AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.conversation_id=conversations.id)`)
        .all(`-${retention.chats} days`) as SqlRow[];
      let deletedConversations = 0;
      for (const row of expiredConversations) {
        const id = String(row.id);
        if (activeActionReferences.has(id)) continue;
        deletedConversations += Number(this.db.prepare("DELETE FROM conversations WHERE id=?").run(id).changes);
      }

      const retentionTombstone = JSON.stringify({ retentionRedacted: true });
      const outboxRedacted = this.db.prepare(`UPDATE action_outbox SET payload_json=?,
        result_json=CASE WHEN result_json IS NULL THEN NULL ELSE ? END
        WHERE status IN ('SUCCEEDED','FAILED','RESULT_UNKNOWN','CANCELLED')
          AND updated_at<datetime('now', ?)
          AND (payload_json!=? OR (result_json IS NOT NULL AND result_json!=?))`)
        .run(retentionTombstone, retentionTombstone, `-${retention.chats} days`, retentionTombstone, retentionTombstone).changes;

      const orphanBindings = this.db.prepare(`SELECT id,binding_type,internal_id FROM platform_target_bindings
        WHERE (binding_type='conversation' AND NOT EXISTS (
          SELECT 1 FROM conversations WHERE conversations.id=platform_target_bindings.internal_id
        )) OR (binding_type='order' AND NOT EXISTS (
          SELECT 1 FROM orders WHERE orders.id=platform_target_bindings.internal_id
        ))`).all() as SqlRow[];
      let targetBindingsDeleted = 0;
      for (const binding of orphanBindings) {
        if (activeActionReferences.has(String(binding.internal_id))) continue;
        targetBindingsDeleted += Number(this.db.prepare("DELETE FROM platform_target_bindings WHERE id=?").run(String(binding.id)).changes);
      }

      const audit = this.db.prepare(`DELETE FROM audit_logs WHERE created_at<datetime('now', ?)`).run(`-${retention.audit} days`).changes;
      const grants = this.db.prepare("UPDATE permission_grants SET revoked_at=? WHERE revoked_at IS NULL AND expires_at<?").run(now(), now()).changes;
      return {
        assets: 0,
        messages: deletedMessages,
        orders: deletedOrders,
        conversations: deletedConversations,
        audit: Number(audit),
        grants: Number(grants),
        outboxRedacted: Number(outboxRedacted),
        targetBindingsDeleted
      };
    });
  }
}
