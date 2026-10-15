import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../lib/types.js";
import { validateSession } from "./session.js";

export const SESSION_COOKIE = "xudbin_session";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? validateSession(token) : null;
  if (!user) return c.json({ error: "Oturum açmanız gerekiyor" }, 401);
  c.set("user", user);
  await next();
});
