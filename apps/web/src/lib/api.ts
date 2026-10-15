export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `İstek başarısız (${res.status})`, body);
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(data) }),
  put: <T>(path: string, data: unknown = {}) => request<T>(path, { method: "PUT", body: JSON.stringify(data) }),
  patch: <T>(path: string, data: unknown = {}) => request<T>(path, { method: "PATCH", body: JSON.stringify(data) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE", body: "{}" }),
};

export type User = { id: number; email: string; name: string };
export type AuthStatus = { setupRequired: boolean; user: User | null };

export type ServerStats = {
  cpu: { usage: number; cores: number; load: number[]; model: string };
  memory: { total: number; used: number };
  disk: { total: number; used: number } | null;
  uptime: number;
  platform: string;
  hostname: string;
  history?: { t: number; cpu: number; mem: number }[];
};

export type DockerInfo =
  | { available: true; version: string; containers: { total: number; running: number }; images: number }
  | { available: false; error: string };

export type Server = {
  id: number;
  name: string;
  kind: "local" | "ssh";
  host: string | null;
  port: number;
  username: string;
  publicIp: string | null;
  httpsMode: "auto" | "internal" | "off";
  acmeEmail: string | null;
  status: "pending" | "setting_up" | "ready" | "error";
  statusDetail: string | null;
  setupRunning: boolean;
  sshKey: { id: number; name: string; publicKey: string } | null;
  apps: number;
  databases: number;
  createdAt: number;
};

export type ServerOverview = Server & { stats: ServerStats | null; statsError: string | null; docker: DockerInfo };

export type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  createdAt: number;
  ports: string[];
  managed: boolean;
};

export type Project = { id: number; name: string; description: string; createdAt: number; apps: number; databases: number; running: number };

export type Domain = { id: number; host: string; https: boolean; generated: boolean; url: string };

export type AppSecurity = {
  waf: boolean;
  rateLimit: number | null;
  headers: boolean;
  allowIps: string[];
  denyIps: string[];
  basicAuth: { username: string } | null;
};

export type App = {
  id: number;
  projectId: number;
  server: { id: number; name: string; status: string };
  name: string;
  slug: string;
  sourceType: "git" | "image" | "compose";
  gitUrl: string | null;
  gitBranch: string;
  hasGitToken: boolean;
  buildType: "auto" | "dockerfile" | "static";
  dockerfilePath: string;
  buildContext: string;
  image: string | null;
  composeFile: string | null;
  composeService: string | null;
  port: number;
  command: string | null;
  volumes: { name: string; path: string }[];
  autoDeploy: boolean;
  status: "idle" | "deploying" | "running" | "stopped" | "failed";
  container: string | null;
  currentImage: string | null;
  internalHost: string;
  webhookPath: string;
  domains: Domain[];
  security: AppSecurity;
  createdAt: number;
};

export type Deployment = {
  id: number;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  trigger: "manual" | "webhook" | "rollback";
  title: string;
  commitSha: string | null;
  image: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type Database = {
  id: number;
  projectId: number;
  server: { id: number; name: string };
  name: string;
  slug: string;
  engine: "postgres" | "mysql" | "mariadb" | "mongo" | "redis";
  engineLabel: string;
  version: string;
  dbName: string;
  dbUser: string;
  password: string;
  internalHost: string;
  internalPort: number;
  internalUrl: string;
  externalPort: number | null;
  externalUrl: string | null;
  status: string;
  backupIntervalH: number;
  backupKeep: number;
  lastBackupAt: number | null;
  createdAt: number;
};

export type Backup = { id: number; file: string; size: number; status: "running" | "success" | "failed"; error: string | null; createdAt: number };
