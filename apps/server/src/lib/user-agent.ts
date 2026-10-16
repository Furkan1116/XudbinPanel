/** Kaba ama hızlı tarayıcı / işletim sistemi / cihaz ayrıştırması (analitik için yeterli). */
export type UaInfo = { browser: string; os: string; device: "Masaüstü" | "Mobil" | "Tablet"; bot: boolean };

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|bingpreview|headless|python-|curl\/|wget|go-http-client|java\/|okhttp|axios|node-fetch|undici|httpclient|scrapy|lighthouse|pingdom|uptime|monitor|xudbin|preview|feedfetcher|semrush|ahrefs|mj12|dotbot|petalbot|yandex|baidu/i;

export function parseUserAgent(ua: string | undefined): UaInfo {
  const s = ua ?? "";
  const bot = !s || BOT.test(s);
  const browser =
    /Edg(?:e|A|iOS)?\//.test(s) ? "Edge"
    : /OPR\/|Opera/.test(s) ? "Opera"
    : /SamsungBrowser/.test(s) ? "Samsung Internet"
    : /YaBrowser/.test(s) ? "Yandex"
    : /Firefox\/|FxiOS/.test(s) ? "Firefox"
    : /Chrome\/|CriOS/.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari"
    : bot ? "Bot"
    : "Diğer";
  const os =
    /Windows/.test(s) ? "Windows"
    : /iPhone|iPad|iPod/.test(s) ? "iOS"
    : /Mac OS X|Macintosh/.test(s) ? "macOS"
    : /Android/.test(s) ? "Android"
    : /CrOS/.test(s) ? "ChromeOS"
    : /Linux/.test(s) ? "Linux"
    : "Diğer";
  const device = /iPad|Tablet|Android(?!.*Mobile)/.test(s) ? "Tablet" : /Mobi|iPhone|iPod|Android/.test(s) ? "Mobil" : "Masaüstü";
  return { browser, os, device, bot };
}
