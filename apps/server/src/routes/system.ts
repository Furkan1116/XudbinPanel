import { Hono } from "hono";
import { getDockerInfo, listContainers } from "../services/docker.js";
import { getSystemStats } from "../services/system.js";

export const systemRoutes = new Hono()
  .get("/stats", async (c) => c.json({ system: getSystemStats(), docker: await getDockerInfo() }))
  .get("/containers", async (c) => {
    try {
      return c.json({ containers: await listContainers() });
    } catch (err) {
      return c.json({ error: `Docker'a bağlanılamadı: ${(err as Error).message}` }, 503);
    }
  });
