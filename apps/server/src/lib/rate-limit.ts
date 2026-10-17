/**
 * Bellek içi, sabit pencereli basit hız sınırlayıcı.
 * Tek süreçli panel için yeterli; uygulamalara gelen trafiği değil panelin kendisini korur.
 */
export function createRateLimiter(opts: { windowMs: number; max: number; maxKeys?: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, opts.windowMs).unref();

  return {
    /** İzin verildiyse null, aksi halde kaç saniye sonra tekrar denenebileceğini döner. */
    hit(key: string): number | null {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + opts.windowMs });
        return null;
      }
      entry.count++;
      return entry.count > opts.max ? Math.ceil((entry.resetAt - now) / 1000) : null;
    },
    /** Sayacı artırmadan: engelliyse kaç saniye sonra denenebileceğini, değilse null döner. */
    check(key: string): number | null {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= Date.now()) return null;
      return entry.count >= opts.max ? Math.ceil((entry.resetAt - Date.now()) / 1000) : null;
    },
    /** Başarısız bir denemeyi sayar (yalnız başarısızlıkları saymak isteyenler için). */
    fail(key: string) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        // Sahte anahtarlarla belleği şişirmeyi engelle: sınır dolunca en eskiyi at.
        if (opts.maxKeys && hits.size >= opts.maxKeys) {
          const oldest = hits.keys().next().value;
          if (oldest !== undefined) hits.delete(oldest);
        }
        hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      } else entry.count++;
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}
