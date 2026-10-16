/**
 * Hazır uygulamalar: tek tıkla kurulan Docker Compose şablonları. Şablondaki ${AD} değişkenleri uygulamanın
 * ortam değişkenlerinden gelir; şifreler kurulumda rastgele üretilir, {{XUDBIN_URL}} / {{XUDBIN_HOST}} her
 * deploy'da uygulamanın alan adıyla doldurulur. İmajlar ana sürüme sabitlenmiştir.
 */
export type TemplateVar = { key: string; label: string; generate?: "password" | "secret"; value?: string; secret?: boolean };
export type Template = {
  id: string;
  name: string;
  description: string;
  category: "Web sitesi" | "Otomasyon" | "İzleme" | "Geliştirici" | "Veri" | "Güvenlik" | "İletişim";
  /** simple-icons kısa adı (logo) */
  icon?: string;
  service: string;
  port: number;
  compose: string;
  vars: TemplateVar[];
  /** Kurulumdan sonra kullanıcıya gösterilecek not ({AD} yerine değişkenin değeri yazılır). */
  notes?: string;
};

const URL_VARS: TemplateVar[] = [
  { key: "SITE_URL", label: "Site adresi", value: "{{XUDBIN_URL}}" },
  { key: "SITE_HOST", label: "Alan adı", value: "{{XUDBIN_HOST}}" },
];

export const TEMPLATES: Template[] = [
  {
    id: "wordpress",
    name: "WordPress",
    description: "Dünyanın en çok kullanılan site ve blog yazılımı, MariaDB ile.",
    category: "Web sitesi",
    icon: "wordpress",
    service: "wordpress",
    port: 80,
    vars: [
      { key: "DB_PASSWORD", label: "Veritabanı şifresi", generate: "password", secret: true },
      { key: "DB_ROOT_PASSWORD", label: "Veritabanı root şifresi", generate: "password", secret: true },
    ],
    notes: "Siteyi açınca WordPress kurulum sihirbazı başlar; yönetici hesabını orada oluştur.",
    compose: `services:
  wordpress:
    image: wordpress:6-apache
    restart: unless-stopped
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_CONFIG_EXTRA: |
        if (isset($$_SERVER['HTTP_X_FORWARDED_PROTO']) && $$_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $$_SERVER['HTTPS'] = 'on'; }
    volumes:
      - wp-data:/var/www/html
    depends_on:
      db:
        condition: service_healthy
  db:
    image: mariadb:11
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      retries: 30
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db-data:/var/lib/mysql
volumes:
  wp-data: {}
  db-data: {}
`,
  },
  {
    id: "ghost",
    name: "Ghost",
    description: "Modern blog ve bülten platformu (üyelik, e-posta bülteni), MySQL ile.",
    category: "Web sitesi",
    icon: "ghost",
    service: "ghost",
    port: 2368,
    vars: [...URL_VARS, { key: "DB_PASSWORD", label: "Veritabanı şifresi", generate: "password", secret: true }],
    notes: "Yönetim paneli: {SITE_URL}/ghost — ilk açılışta yönetici hesabını oluştur.",
    compose: `services:
  ghost:
    image: ghost:5-alpine
    restart: unless-stopped
    environment:
      url: \${SITE_URL}
      database__client: mysql
      database__connection__host: db
      database__connection__user: ghost
      database__connection__password: \${DB_PASSWORD}
      database__connection__database: ghost
    volumes:
      - ghost-content:/var/lib/ghost/content
    depends_on:
      db:
        condition: service_healthy
  db:
    image: mysql:8.4
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 --silent"]
      interval: 5s
      retries: 30
    environment:
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost
      MYSQL_PASSWORD: \${DB_PASSWORD}
      MYSQL_RANDOM_ROOT_PASSWORD: "1"
    volumes:
      - db-data:/var/lib/mysql
volumes:
  ghost-content: {}
  db-data: {}
`,
  },
  {
    id: "n8n",
    name: "n8n",
    description: "Görsel iş akışı otomasyonu (Zapier benzeri): uygulamaları birbirine bağla.",
    category: "Otomasyon",
    icon: "n8n",
    service: "n8n",
    port: 5678,
    vars: [...URL_VARS, { key: "N8N_ENCRYPTION_KEY", label: "Şifreleme anahtarı", generate: "secret", secret: true }],
    notes: "İlk açılışta sahip hesabını oluştur. Webhook adresleri {SITE_URL}/webhook/... biçimindedir.",
    compose: `services:
  n8n:
    image: n8nio/n8n:stable
    restart: unless-stopped
    environment:
      N8N_HOST: \${SITE_HOST}
      N8N_PROTOCOL: https
      WEBHOOK_URL: \${SITE_URL}/
      N8N_PROXY_HOPS: "1"
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      GENERIC_TIMEZONE: Europe/Istanbul
      N8N_DIAGNOSTICS_ENABLED: "false"
    volumes:
      - n8n-data:/home/node/.n8n
volumes:
  n8n-data: {}
`,
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    description: "Kendi sitelerin ve servislerin için durum sayfası ve kesinti izleme.",
    category: "İzleme",
    icon: "uptimekuma",
    service: "uptime-kuma",
    port: 3001,
    vars: [],
    notes: "İlk açılışta yönetici hesabını oluştur.",
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    volumes:
      - kuma-data:/app/data
volumes:
  kuma-data: {}
`,
  },
  {
    id: "vaultwarden",
    name: "Vaultwarden",
    description: "Bitwarden uyumlu, kendi sunucunda şifre yöneticisi.",
    category: "Güvenlik",
    icon: "vaultwarden",
    service: "vaultwarden",
    port: 80,
    vars: [...URL_VARS, { key: "ADMIN_TOKEN", label: "Yönetim paneli anahtarı", generate: "secret", secret: true }],
    notes: "HTTPS gerektirir. Hesabını oluşturduktan sonra yönetim panelinden ({SITE_URL}/admin, anahtar: ADMIN_TOKEN) yeni kayıtları kapat.",
    compose: `services:
  vaultwarden:
    image: vaultwarden/server:1.34.3
    restart: unless-stopped
    environment:
      DOMAIN: \${SITE_URL}
      ADMIN_TOKEN: \${ADMIN_TOKEN}
      SIGNUPS_ALLOWED: "true"
    volumes:
      - vw-data:/data
volumes:
  vw-data: {}
`,
  },
  {
    id: "gitea",
    name: "Gitea",
    description: "Hafif, kendi sunucunda Git servisi (GitHub benzeri arayüz).",
    category: "Geliştirici",
    icon: "gitea",
    service: "gitea",
    port: 3000,
    vars: URL_VARS,
    notes: "İlk açılışta kurulum sayfası gelir; veritabanı olarak SQLite3 seç ve yönetici hesabını oluştur.",
    compose: `services:
  gitea:
    image: gitea/gitea:1.24
    restart: unless-stopped
    environment:
      GITEA__server__ROOT_URL: \${SITE_URL}/
      GITEA__server__DOMAIN: \${SITE_HOST}
      GITEA__server__DISABLE_SSH: "true"
    volumes:
      - gitea-data:/data
volumes:
  gitea-data: {}
`,
  },
  {
    id: "metabase",
    name: "Metabase",
    description: "Veritabanlarından grafik ve rapor hazırlama (iş zekâsı).",
    category: "Veri",
    icon: "metabase",
    service: "metabase",
    port: 3000,
    vars: [],
    notes: "İlk açılış birkaç dakika sürebilir. Xudbin veritabanlarını iç adresleriyle (xb-db-...) bağlayabilirsin.",
    compose: `services:
  metabase:
    image: metabase/metabase:v0.56.x
    restart: unless-stopped
    environment:
      MB_DB_FILE: /metabase-data/metabase.db
    volumes:
      - mb-data:/metabase-data
volumes:
  mb-data: {}
`,
  },
  {
    id: "nocodb",
    name: "NocoDB",
    description: "Airtable benzeri: veritabanını tablo arayüzüyle yönet, form ve API üret.",
    category: "Veri",
    icon: "nocodb",
    service: "nocodb",
    port: 8080,
    vars: [{ key: "NC_AUTH_JWT_SECRET", label: "JWT anahtarı", generate: "secret", secret: true }],
    compose: `services:
  nocodb:
    image: nocodb/nocodb:latest
    restart: unless-stopped
    environment:
      NC_AUTH_JWT_SECRET: \${NC_AUTH_JWT_SECRET}
      NC_DISABLE_TELE: "true"
    volumes:
      - nc-data:/usr/app/data
volumes:
  nc-data: {}
`,
  },
  {
    id: "adminer",
    name: "Adminer",
    description: "Tarayıcıdan veritabanı yönetimi (PostgreSQL, MySQL, MariaDB). Tek dosyalık, hafif.",
    category: "Veri",
    icon: "adminer",
    service: "adminer",
    port: 8080,
    vars: [],
    notes: "Sunucu alanına veritabanının iç adresini (xb-db-...) yaz. Uygulamaya şifre koruması eklemeni öneririz (Güvenlik sekmesi).",
    compose: `services:
  adminer:
    image: adminer:5
    restart: unless-stopped
`,
  },
  {
    id: "nextcloud",
    name: "Nextcloud",
    description: "Kendi bulut depolaman: dosya, takvim, kişiler, paylaşım. MariaDB ile.",
    category: "İletişim",
    icon: "nextcloud",
    service: "nextcloud",
    port: 80,
    vars: [
      ...URL_VARS,
      { key: "DB_PASSWORD", label: "Veritabanı şifresi", generate: "password", secret: true },
      { key: "DB_ROOT_PASSWORD", label: "Veritabanı root şifresi", generate: "password", secret: true },
      { key: "ADMIN_PASSWORD", label: "Yönetici şifresi (kullanıcı: admin)", generate: "password", secret: true },
    ],
    notes: "Giriş: admin / ADMIN_PASSWORD (ortam değişkenleri sekmesinde). İlk açılış birkaç dakika sürer.",
    compose: `services:
  nextcloud:
    image: nextcloud:31-apache
    restart: unless-stopped
    environment:
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: \${DB_PASSWORD}
      NEXTCLOUD_ADMIN_USER: admin
      NEXTCLOUD_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      NEXTCLOUD_TRUSTED_DOMAINS: \${SITE_HOST}
      OVERWRITEPROTOCOL: https
      TRUSTED_PROXIES: 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
    volumes:
      - nc-html:/var/www/html
    depends_on:
      db:
        condition: service_healthy
  db:
    image: mariadb:11
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      retries: 30
    command: --transaction-isolation=READ-COMMITTED
    environment:
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db-data:/var/lib/mysql
volumes:
  nc-html: {}
  db-data: {}
`,
  },
  {
    id: "matomo",
    name: "Matomo",
    description: "Google Analytics alternatifi, ayrıntılı web analitiği (izleme kodu ile). MariaDB ile.",
    category: "İzleme",
    icon: "matomo",
    service: "matomo",
    port: 80,
    vars: [
      { key: "DB_PASSWORD", label: "Veritabanı şifresi", generate: "password", secret: true },
      { key: "DB_ROOT_PASSWORD", label: "Veritabanı root şifresi", generate: "password", secret: true },
    ],
    notes: "Kurulum sihirbazında veritabanı sunucusu: db, kullanıcı: matomo, şifre: DB_PASSWORD (ortam değişkenleri sekmesinde).",
    compose: `services:
  matomo:
    image: matomo:5
    restart: unless-stopped
    environment:
      MATOMO_DATABASE_HOST: db
      MATOMO_DATABASE_USERNAME: matomo
      MATOMO_DATABASE_PASSWORD: \${DB_PASSWORD}
      MATOMO_DATABASE_DBNAME: matomo
    volumes:
      - matomo-data:/var/www/html
    depends_on:
      db:
        condition: service_healthy
  db:
    image: mariadb:11
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      retries: 30
    environment:
      MARIADB_DATABASE: matomo
      MARIADB_USER: matomo
      MARIADB_PASSWORD: \${DB_PASSWORD}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
    volumes:
      - db-data:/var/lib/mysql
volumes:
  matomo-data: {}
  db-data: {}
`,
  },
  {
    id: "directus",
    name: "Directus",
    description: "Başsız (headless) CMS ve veri platformu: içerik yönetimi + hazır REST/GraphQL API. PostgreSQL ile.",
    category: "Geliştirici",
    icon: "directus",
    service: "directus",
    port: 8055,
    vars: [
      ...URL_VARS,
      { key: "SECRET", label: "Gizli anahtar", generate: "secret", secret: true },
      { key: "DB_PASSWORD", label: "Veritabanı şifresi", generate: "password", secret: true },
      { key: "ADMIN_EMAIL", label: "Yönetici e-postası", value: "admin@example.com" },
      { key: "ADMIN_PASSWORD", label: "Yönetici şifresi", generate: "password", secret: true },
    ],
    notes: "Giriş: ADMIN_EMAIL / ADMIN_PASSWORD (ortam değişkenleri sekmesinde). Girişten sonra e-postanı değiştir.",
    compose: `services:
  directus:
    image: directus/directus:11
    restart: unless-stopped
    environment:
      SECRET: \${SECRET}
      PUBLIC_URL: \${SITE_URL}
      DB_CLIENT: pg
      DB_HOST: db
      DB_PORT: "5432"
      DB_DATABASE: directus
      DB_USER: directus
      DB_PASSWORD: \${DB_PASSWORD}
      ADMIN_EMAIL: \${ADMIN_EMAIL}
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      TELEMETRY: "false"
    volumes:
      - uploads:/directus/uploads
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"]
      interval: 5s
      retries: 30
    environment:
      POSTGRES_DB: directus
      POSTGRES_USER: directus
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  uploads: {}
  db-data: {}
`,
  },
  {
    id: "grafana",
    name: "Grafana",
    description: "Ölçüm ve log panoları; Prometheus, PostgreSQL, MySQL ve daha fazlasından grafik.",
    category: "İzleme",
    icon: "grafana",
    service: "grafana",
    port: 3000,
    vars: [...URL_VARS, { key: "ADMIN_PASSWORD", label: "Yönetici şifresi (kullanıcı: admin)", generate: "password", secret: true }],
    notes: "Giriş: admin / ADMIN_PASSWORD (ortam değişkenleri sekmesinde).",
    compose: `services:
  grafana:
    image: grafana/grafana-oss:12.0.0
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      GF_SERVER_ROOT_URL: \${SITE_URL}
      GF_ANALYTICS_REPORTING_ENABLED: "false"
    volumes:
      - grafana-data:/var/lib/grafana
volumes:
  grafana-data: {}
`,
  },
  {
    id: "listmonk",
    name: "listmonk",
    description: "E-posta bülteni ve liste yönetimi; kendi SMTP sunucunla toplu e-posta. PostgreSQL ile.",
    category: "İletişim",
    icon: "listmonk",
    service: "app",
    port: 9000,
    vars: [
      { key: "DB_PASSWORD", label: "Veritabanı şifresi", generate: "password", secret: true },
      { key: "ADMIN_PASSWORD", label: "Yönetici şifresi (kullanıcı: admin)", generate: "password", secret: true },
    ],
    notes: "Giriş: admin / ADMIN_PASSWORD (ortam değişkenleri sekmesinde). Ayarlar > SMTP'den e-posta sunucunu tanımla.",
    compose: `services:
  app:
    image: listmonk/listmonk:v5.0.0
    restart: unless-stopped
    command: [sh, -c, "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"]
    environment:
      LISTMONK_app__address: 0.0.0.0:9000
      LISTMONK_db__host: db
      LISTMONK_db__port: "5432"
      LISTMONK_db__user: listmonk
      LISTMONK_db__password: \${DB_PASSWORD}
      LISTMONK_db__database: listmonk
      LISTMONK_db__ssl_mode: disable
      LISTMONK_ADMIN_USER: admin
      LISTMONK_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
    volumes:
      - uploads:/listmonk/uploads
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: listmonk
      POSTGRES_USER: listmonk
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U listmonk"]
      interval: 5s
      retries: 20
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  uploads: {}
  db-data: {}
`,
  },
];

export const getTemplate = (id: string) => TEMPLATES.find((t) => t.id === id);

/** Şablon değişkenlerinin ilk değerleri (şifreler üretilir). */
export function templateEnv(t: Template, random: (n: number) => string) {
  return Object.fromEntries(t.vars.map((v) => [v.key, v.generate === "password" ? random(24) : v.generate === "secret" ? random(48) : (v.value ?? "")]));
}
