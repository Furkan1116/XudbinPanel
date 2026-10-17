import type { Context } from "hono";
import type { z } from "zod";

import { TooBusyError } from "../auth/password.js";

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503 | 507, message: string) {
    super(message);
  }
}

/** İstek gövdesini şemaya göre doğrular; hata varsa ilk hatanın mesajıyla 400 döner. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new HttpError(400, issue ? `${field ? `${field}: ` : ""}${issue.message}` : "Geçersiz istek");
  }
  return parsed.data;
}

/**
 * Yol parametresindeki kimlik. Yalnız düz ondalık rakam kabul edilir: `Number()` tek başına
 * "1e0", "0x1", "+1", " 1" gibi yazımları da 1 sayar; proje yetkisi yolu düz rakam diye
 * denetlediği için bu yazımlar denetimi atlatabiliyordu.
 */
export function idParam(c: Context, name = "id") {
  const raw = c.req.param(name) ?? "";
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw new HttpError(400, "Geçersiz kimlik");
  return Number(raw);
}

export function must<T>(value: T | undefined | null, message = "Bulunamadı"): T {
  if (value === undefined || value === null) throw new HttpError(404, message);
  return value;
}

/**
 * Hono onError işleyicisi. Kasıtlı kullanıcı mesajları (HttpError, TooBusyError) aynen döner; beklenmeyen hatalarda
 * ayrıntı (iç yol, Docker/SQL hata metni) yalnız sunucu loguna yazılır, istemciye genel mesaj gider.
 */
export function errorResponse(err: Error, c: Context) {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof TooBusyError) return c.json({ error: err.message }, 503);
  console.error(err);
  return c.json({ error: "Sunucu hatası. Ayrıntı sunucu loglarında." }, 500);
}
