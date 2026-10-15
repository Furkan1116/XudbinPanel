import type { SessionUser } from "../auth/session.js";

export type AppEnv = { Variables: { user: SessionUser } };
