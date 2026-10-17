import type { Context } from "hono";
import type { z } from "zod";

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503, message: string) {
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
