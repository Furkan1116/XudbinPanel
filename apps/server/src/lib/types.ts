import type { SessionUser } from "../auth/session.js";

/** auditAction: işlem kaydında yolun varsayılan etiketi yerine yazılacak metin (ör. yayın kontrolü bilerek geçildi). */
export type AppEnv = { Variables: { user: SessionUser; viaToken?: boolean; tokenReadOnly?: boolean; auditAction?: string } };
