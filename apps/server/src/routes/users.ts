import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { body, HttpError, idParam } from "../lib/http.js";
import type { AppEnv } from "../lib/types.js";
import { adminCount, createUser, deleteUser, publicUser, resetPassword, type UserRow } from "../services/users.js";

export const userRoutes = new Hono<AppEnv>()
  .get("/", (c) => {
    const users = (db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[]).map(publicUser);
    return c.json({ users, me: c.get("user").id });
  })
  .post("/", async (c) => {
    const input = await body(c, z.object({ email: z.email().max(254), name: z.string().trim().min(1).max(100), role: z.enum(["admin", "member"]) }));
    const r = await createUser(input);
    return c.json({ id: r.id, temporaryPassword: r.password }, 201);
  })
  .patch("/:id", async (c) => {
    const id = idParam(c);
    const { role } = await body(c, z.object({ role: z.enum(["admin", "member"]) }));
    const u = db.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: string } | undefined;
    if (!u) throw new HttpError(404, "Kullanıcı bulunamadı");
    if (u.role === "admin" && role === "member" && adminCount() <= 1) throw new HttpError(409, "En az bir yönetici kalmalı");
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
    return c.json({ ok: true });
  })
  .post("/:id/reset-password", async (c) => {
    const id = idParam(c);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) throw new HttpError(404, "Kullanıcı bulunamadı");
    return c.json({ temporaryPassword: await resetPassword(id) });
  })
  .delete("/:id", (c) => {
    const id = idParam(c);
    if (id === c.get("user").id) throw new HttpError(409, "Kendi hesabını silemezsin");
    deleteUser(id);
    return c.json({ ok: true });
  });
