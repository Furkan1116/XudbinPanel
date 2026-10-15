import { EventEmitter } from "node:events";

/**
 * Süreç içi olay yolu: canlı deploy logları ve kurulum çıktıları SSE ile tarayıcıya buradan akar.
 * Kanal adları: "deploy:<id>", "server-setup:<id>".
 */
export const bus = new EventEmitter();
bus.setMaxListeners(200);
