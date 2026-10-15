import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "xudbin.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

/**
 * Sıralı migration listesi. Yeni bir şema değişikliği gerektiğinde sona ekle,
 * mevcut olanları asla değiştirme. Hangisinin uygulandığını PRAGMA user_version tutar.
 */
const migrations: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    ip          TEXT,
    user_agent  TEXT
  );
  CREATE INDEX sessions_user_id ON sessions(user_id);
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE ssh_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    public_key   TEXT NOT NULL,
    private_key  TEXT NOT NULL,           -- şifreli
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE servers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
    host         TEXT,
    port         INTEGER NOT NULL DEFAULT 22,
    username     TEXT NOT NULL DEFAULT 'root',
    ssh_key_id   INTEGER REFERENCES ssh_keys(id) ON DELETE SET NULL,
    public_ip    TEXT,
    https_mode   TEXT NOT NULL DEFAULT 'auto' CHECK (https_mode IN ('auto', 'internal', 'off')),
    acme_email   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',   -- pending | setting_up | ready | error
    status_detail TEXT,
    setup_log    TEXT NOT NULL DEFAULT '',
    log_offset   INTEGER NOT NULL DEFAULT 0,        -- Caddy erişim logunda okunan son bayt
    created_at   INTEGER NOT NULL
  );
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE apps (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    server_id       INTEGER NOT NULL REFERENCES servers(id),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    source_type     TEXT NOT NULL CHECK (source_type IN ('git', 'image', 'compose')),
    git_url         TEXT,
    git_branch      TEXT NOT NULL DEFAULT 'main',
    git_token       TEXT,                    -- şifreli
    build_type      TEXT NOT NULL DEFAULT 'auto' CHECK (build_type IN ('auto', 'dockerfile', 'static')),
    dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
    build_context   TEXT NOT NULL DEFAULT '.',
    image           TEXT,
    compose_file    TEXT,
    compose_service TEXT,                    -- domain yönlendirilecek compose servisi
    port            INTEGER NOT NULL DEFAULT 3000,
    command         TEXT,
    env             TEXT,                    -- şifreli, KEY=VALUE satırları
    volumes         TEXT NOT NULL DEFAULT '[]',   -- [{name, path}]
    security        TEXT NOT NULL DEFAULT '{}',   -- {waf, rateLimit, basicAuth, allowIps, denyIps}
    webhook_token   TEXT NOT NULL,
    auto_deploy     INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'idle', -- idle | deploying | running | stopped | failed
    container       TEXT,                    -- çalışan konteynerin adı
    current_image   TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE domains (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    host       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    https      INTEGER NOT NULL DEFAULT 1,
    generated  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE deployments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'queued', -- queued | running | success | failed | cancelled
    trigger     TEXT NOT NULL,                  -- manual | webhook | rollback
    title       TEXT NOT NULL DEFAULT '',
    commit_sha  TEXT,
    image       TEXT,
    log         TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX deployments_app ON deployments(app_id, id DESC);
  CREATE TABLE databases (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    server_id          INTEGER NOT NULL REFERENCES servers(id),
    name               TEXT NOT NULL,
    slug               TEXT NOT NULL UNIQUE,
    engine             TEXT NOT NULL CHECK (engine IN ('postgres', 'mysql', 'mariadb', 'mongo', 'redis')),
    version            TEXT NOT NULL,
    db_name            TEXT NOT NULL,
    db_user            TEXT NOT NULL,
    db_password        TEXT NOT NULL,          -- şifreli
    external_port      INTEGER,
    status             TEXT NOT NULL DEFAULT 'idle',
    backup_interval_h  INTEGER NOT NULL DEFAULT 0,  -- 0: otomatik yedek kapalı
    backup_keep        INTEGER NOT NULL DEFAULT 7,
    last_backup_at     INTEGER,
    created_at         INTEGER NOT NULL
  );
  CREATE TABLE backups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    database_id INTEGER NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
    file        TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL,               -- running | success | failed
    error       TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('discord', 'telegram', 'slack', 'webhook')),
    config     TEXT NOT NULL,                -- şifreli JSON
    events     TEXT NOT NULL,                -- JSON dizi
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE blocked_ips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT NOT NULL UNIQUE,
    reason     TEXT NOT NULL,
    auto       INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE security_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
    host       TEXT,
    ip         TEXT NOT NULL,
    kind       TEXT NOT NULL,                -- waf | ratelimit | blocked | auth | panel_login
    method     TEXT,
    path       TEXT,
    status     INTEGER,
    user_agent TEXT,
    country    TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX security_events_time ON security_events(created_at DESC);
  CREATE INDEX security_events_ip ON security_events(ip, created_at);
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  `,
];

function migrate() {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = current; v < migrations.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

migrate();
