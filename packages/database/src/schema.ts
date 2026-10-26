export const MIGRATIONS = [
  {
    version: 1,
    name: "initial_local_workbench",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OFFLINE',
        connector TEXT NOT NULL DEFAULT 'MOCK',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        slug TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        base_price REAL NOT NULL,
        standard_price REAL NOT NULL,
        advanced_price REAL NOT NULL,
        release_day INTEGER NOT NULL,
        readiness TEXT NOT NULL DEFAULT 'PLANNED',
        remote_service INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_bundles (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        bundle_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(product_id, version)
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        product_id TEXT REFERENCES products(id),
        order_id TEXT,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT,
        source TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        content_bundle_id TEXT REFERENCES content_bundles(id),
        connector TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_at TEXT,
        external_id TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        product_id TEXT REFERENCES products(id),
        buyer_alias TEXT NOT NULL,
        ai_paused INTEGER NOT NULL DEFAULT 0,
        handoff_reason TEXT,
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        direction TEXT NOT NULL,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        decision_json TEXT,
        external_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customer_consents (
        id TEXT PRIMARY KEY,
        conversation_id TEXT REFERENCES conversations(id),
        order_id TEXT,
        scope TEXT NOT NULL,
        notice_version TEXT NOT NULL,
        status TEXT NOT NULL,
        granted_at TEXT,
        withdrawn_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        product_id TEXT NOT NULL REFERENCES products(id),
        conversation_id TEXT REFERENCES conversations(id),
        buyer_alias TEXT NOT NULL,
        order_type TEXT NOT NULL,
        status TEXT NOT NULL,
        tier TEXT NOT NULL,
        quoted_price REAL NOT NULL,
        paid_price REAL,
        revision_limit INTEGER NOT NULL,
        revision_used INTEGER NOT NULL DEFAULT 0,
        deadline_at TEXT,
        intake_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id),
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        package_path TEXT,
        share_url TEXT,
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remote_service_records (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES orders(id),
        consent_summary TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        action_summary TEXT,
        result_summary TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS codex_threads (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        codex_thread_id TEXT,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        last_event_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_type, scope_id)
      );

      CREATE TABLE IF NOT EXISTS permission_grants (
        id TEXT PRIMARY KEY,
        codex_thread_id TEXT,
        turn_id TEXT,
        path TEXT NOT NULL,
        access TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        priority INTEGER NOT NULL DEFAULT 100,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        locked_by TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS action_outbox (
        action_id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        risk TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        precondition_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        locked_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_runtime (
        id TEXT PRIMARY KEY,
        connector TEXT NOT NULL,
        status TEXT NOT NULL,
        page_type TEXT,
        dom_fingerprint TEXT,
        last_heartbeat_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extension_pairings (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        token_hash TEXT,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        paired_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        correlation_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backup_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_products_release_day ON products(release_day);
      CREATE INDEX IF NOT EXISTS idx_content_product ON content_bundles(product_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_publications_status ON publications(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, available_at, priority);
      CREATE INDEX IF NOT EXISTS idx_outbox_claim ON action_outbox(status, available_at);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    `
  },
  {
    version: 2,
    name: "phase_a_hardening",
    sql: `
      UPDATE products
      SET readiness='PLANNED', updated_at=datetime('now')
      WHERE readiness='CONTENT_READY'
        AND NOT EXISTS (SELECT 1 FROM content_bundles cb WHERE cb.product_id=products.id);

      CREATE INDEX IF NOT EXISTS idx_assets_expiry ON assets(expires_at);
      CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(order_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_remote_records_order ON remote_service_records(order_id, created_at DESC);
    `
  },
  {
    version: 3,
    name: "extension_token_lifecycle",
    sql: `
      ALTER TABLE extension_pairings ADD COLUMN token_expires_at TEXT;
      ALTER TABLE extension_pairings ADD COLUMN last_used_at TEXT;
      ALTER TABLE extension_pairings ADD COLUMN revoked_at TEXT;
      ALTER TABLE extension_pairings ADD COLUMN connection_id TEXT;
      UPDATE extension_pairings
      SET token_expires_at=datetime('now','+8 hours'), last_used_at=COALESCE(last_used_at,paired_at)
      WHERE status='paired' AND token_hash IS NOT NULL AND token_expires_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_extension_token ON extension_pairings(token_hash,status,token_expires_at);
    `
  },
  {
    version: 4,
    name: "codex_approval_journal",
    sql: `
      CREATE TABLE IF NOT EXISTS codex_approvals (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        params_json TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT,
        received_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_codex_approvals_status ON codex_approvals(status,received_at DESC);
    `
  },
  {
    version: 5,
    name: "data_provenance_and_metrics",
    sql: `
      ALTER TABLE publications ADD COLUMN data_source TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE conversations ADD COLUMN data_source TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE messages ADD COLUMN data_source TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE orders ADD COLUMN data_source TEXT NOT NULL DEFAULT 'local';

      UPDATE publications SET data_source=CASE WHEN connector='MOCK' THEN 'mock' ELSE 'real' END;
      UPDATE conversations SET data_source='demo' WHERE buyer_alias IN ('买家 7***2','买家 L***9');
      UPDATE messages SET data_source='demo' WHERE conversation_id IN (SELECT id FROM conversations WHERE data_source='demo');
      UPDATE orders SET data_source='demo' WHERE id LIKE 'DEMO-%';

      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        page_type TEXT NOT NULL,
        page_url TEXT NOT NULL,
        adapter_version TEXT,
        metrics_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_reports (
        id TEXT PRIMARY KEY,
        report_date TEXT NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        suggestions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(report_date, source)
      );

      CREATE INDEX IF NOT EXISTS idx_publications_source ON publications(data_source,status,updated_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(data_source,last_message_at);
      CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(data_source,status,updated_at);
      CREATE INDEX IF NOT EXISTS idx_metric_snapshots_time ON metric_snapshots(source,captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_daily_reports_date ON daily_reports(report_date DESC,source);
    `
  },
  {
    version: 6,
    name: "metric_snapshot_evidence",
    sql: `
      ALTER TABLE metric_snapshots ADD COLUMN account_id TEXT;
      ALTER TABLE metric_snapshots ADD COLUMN dom_fingerprint TEXT;
      ALTER TABLE metric_snapshots ADD COLUMN received_at TEXT;
      UPDATE metric_snapshots SET received_at=created_at WHERE received_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_metric_snapshots_account_time ON metric_snapshots(account_id,source,captured_at DESC);
    `
  },
  {
    version: 7,
    name: "platform_target_bindings_and_report_drafts",
    sql: `
      CREATE TABLE IF NOT EXISTS platform_target_bindings (
        id TEXT PRIMARY KEY,
        binding_type TEXT NOT NULL,
        internal_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        external_conversation_id TEXT,
        external_order_id TEXT,
        buyer_public_id TEXT NOT NULL,
        product_external_id TEXT,
        amount_cents INTEGER,
        page_url TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        account_fingerprint TEXT NOT NULL,
        dom_fingerprint TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        binding_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(binding_type, internal_id)
      );

      CREATE TABLE IF NOT EXISTS daily_report_drafts (
        report_date TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        is_custom INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(report_date, source)
      );

      CREATE INDEX IF NOT EXISTS idx_platform_binding_external_conversation ON platform_target_bindings(external_conversation_id,status);
      CREATE INDEX IF NOT EXISTS idx_platform_binding_external_order ON platform_target_bindings(external_order_id,status);
      CREATE INDEX IF NOT EXISTS idx_platform_binding_account ON platform_target_bindings(account_id,binding_type,status);
      CREATE INDEX IF NOT EXISTS idx_report_drafts_date ON daily_report_drafts(report_date DESC,source);
    `
  },
  {
    version: 8,
    name: "imagegen_task_journal",
    sql: `
      CREATE TABLE IF NOT EXISTS imagegen_tasks (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        content_version INTEGER NOT NULL,
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT,
        before_path TEXT NOT NULL,
        before_sha256 TEXT NOT NULL,
        candidate_path TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_imagegen_product_version ON imagegen_tasks(product_id,content_version,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_imagegen_status ON imagegen_tasks(status,updated_at);
    `
  }
] as const;
