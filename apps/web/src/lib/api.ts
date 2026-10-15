export class ApiError extends Error {
  constructor(public status: number, message: string) {
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
  if (!res.ok) throw new ApiError(res.status, body.error ?? `İstek başarısız (${res.status})`);
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(data) }),
};

export type User = { id: number; email: string; name: string };
export type AuthStatus = { setupRequired: boolean; user: User | null };

export type SystemStats = {
  system: {
    hostname: string;
    platform: string;
    arch: string;
    uptime: number;
    cpu: { model: string; cores: number; usage: number; load: number[] };
    memory: { total: number; used: number };
    disk: { total: number; used: number } | null;
    history: { t: number; cpu: number; mem: number }[];
  };
  docker:
    | { available: true; version: string; containers: { total: number; running: number }; images: number }
    | { available: false; error: string };
};

export type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  createdAt: number;
  ports: string[];
};
