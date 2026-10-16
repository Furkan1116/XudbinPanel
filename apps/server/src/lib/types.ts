import type { SessionUser } from "../auth/session.js";

export type AppEnv = { Variables: { user: SessionUser; viaToken?: boolean; tokenReadOnly?: boolean } };
