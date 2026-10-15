/**
 * Bellek içi, sabit pencereli basit hız sınırlayıcı.
 * Tek süreçli panel için yeterli; uygulamalara gelen trafiği değil panelin kendisini korur.
 */
export function createRateLimiter(opts: { windowMs: number; max: number }) {
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
    reset(key: string) {
      hits.delete(key);
    },
  };
}
