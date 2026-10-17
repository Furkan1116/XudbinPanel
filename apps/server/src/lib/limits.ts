/**
 * Uygulama konteynerlerinin kaynak sınırları (bağımsız inceleme O9).
 * PidsLimit her zaman konur: fork bombası tek bir uygulamanın tüm sunucuyu (panel dahil) kilitlemesine yol açabilir;
 * 512 süreç/iş parçacığı sıradan web uygulamaları, işçiler ve Node/JVM için bol bol yeter.
 * Bellek için varsayılan KONMAZ: doğru değer uygulamaya göre çok değişir (derleme sonrası çalışan JVM, ML modeli...),
 * yanlış bir varsayılan çalışan uygulamaları sessizce OOM-kill ederdi. Kullanıcı uygulama ayarlarından belirler;
 * güvenlik puanı sınırsız uygulamaları zaten uyarır.
 */
export const DEFAULT_PIDS_LIMIT = 512;

export function resourceLimits(app: { memory_limit: number | null; cpu_limit: number | null }, opts: { swap?: boolean } = { swap: true }) {
  const bytes = app.memory_limit ? app.memory_limit * 1024 * 1024 : 0;
  return {
    PidsLimit: DEFAULT_PIDS_LIMIT,
    ...(bytes ? { Memory: bytes, ...(opts.swap === false ? {} : { MemorySwap: bytes }) } : {}),
    ...(app.cpu_limit ? { NanoCpus: Math.round(app.cpu_limit * 1e9) } : {}),
  };
}
