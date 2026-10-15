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

export function idParam(c: Context, name = "id") {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Geçersiz kimlik");
  return id;
}

export function must<T>(value: T | undefined | null, message = "Bulunamadı"): T {
  if (value === undefined || value === null) throw new HttpError(404, message);
  return value;
}
