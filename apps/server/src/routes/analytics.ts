import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { HttpError } from "../lib/http.js";
import type { AppEnv } from "../lib/types.js";
import { accessibleAppIds } from "../services/access.js";
import { analyticsReport, type Range } from "../services/analytics.js";

export const analyticsRoutes = new Hono<AppEnv>()
  .get("/sites", (c) => {
    const ids = accessibleAppIds(c.get("user"));
    if (!ids.length) return c.json({ sites: [] });
    const sites = db
      .prepare(
        `SELECT a.id, a.name, p.name AS project,
                (SELECT host FROM domains d WHERE d.app_id = a.id ORDER BY d.generated, d.id LIMIT 1) AS host
         FROM apps a JOIN projects p ON p.id = a.project_id WHERE a.id IN (${ids.map(() => "?").join(",")}) ORDER BY p.name, a.name`,
      )
      .all(...ids);
    return c.json({ sites });
  })
  .get("/report", (c) => {
    const range = z.enum(["24h", "7d", "30d", "90d", "365d"]).catch("7d").parse(c.req.query("range")) as Range;
    const site = c.req.query("site") ?? "all";
    const allowed = accessibleAppIds(c.get("user"));
    let ids: number[];
    if (site === "all") ids = allowed;
    else {
      const id = Number(site);
      if (!allowed.includes(id)) throw new HttpError(404, "Site bulunamadı");
      ids = [id];
    }
    return c.json(analyticsReport(ids, range));
  });
