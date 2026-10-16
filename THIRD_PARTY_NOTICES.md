# Üçüncü taraf bildirimleri

Xudbin MIT lisanslıdır (bkz. [LICENSE](LICENSE)). Xudbin'in kullandığı ve yayınlanan Docker imajlarına giren
üçüncü taraf yazılımlar kendi lisanslarıyla dağıtılır. Bu dosya, bu lisansların istediği bildirimleri toplar.

## Caddy imajı (`ghcr.io/furkan1116/xudbin-caddy`)

| Yazılım | Lisans | Telif |
|---|---|---|
| [Caddy](https://github.com/caddyserver/caddy) | Apache License 2.0 | Copyright 2015 Matthew Holt and The Caddy Authors |
| [Coraza WAF ve coraza-caddy](https://github.com/corazawaf/coraza-caddy) | Apache License 2.0 | Copyright OWASP Coraza contributors |
| [OWASP Core Rule Set](https://github.com/coreruleset/coreruleset) | Apache License 2.0 | Copyright (c) 2006-2020 Trustwave and contributors; Copyright (c) 2021-2026 CRS project |
| [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit) | Apache License 2.0 | Copyright Matthew Holt |

Apache License 2.0 metni: https://www.apache.org/licenses/LICENSE-2.0

## Panel imajı (`ghcr.io/furkan1116/xudbin`)

- Node.js bağımlılıkları MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, CC0-1.0 ve Unlicense lisanslıdır; her paketin lisansı imajdaki `node_modules/<paket>/LICENSE` dosyasındadır.
- Arayüz fontları **IBM Plex Sans** ve **IBM Plex Mono**, SIL Open Font License 1.1 ile dağıtılır (Copyright © 2017 IBM Corp.). Lisans: https://openfontlicense.org
- Framework logoları [Simple Icons](https://simpleicons.org) (CC0-1.0) verisinden alınır. **Logolar ve adlar ilgili markaların sahiplerine aittir**; Xudbin yalnız hangi framework'ün kullanıldığını göstermek için kullanır, bu markalarla bir bağlantısı yoktur.
- İmajın tabanı Alpine Linux'tur; içindeki `git`, `docker-cli`, `openssh-client`, `unzip` ve `tini` paketleri kendi lisanslarıyla (bazıları GPL) gelir. Kaynak kodları Alpine paket deposundan edinilebilir: https://pkgs.alpinelinux.org

## Çalışırken indirilenler

Bunlar Xudbin ile dağıtılmaz; panel gerektiğinde ilgili yerden indirir:

- **Trivy** (Apache-2.0, Aqua Security) ve güvenlik açığı veritabanı: imaj taraması için.
- **DB-IP Lite** ülke veritabanı (CC BY 4.0): trafik analitiğinde ülke bilgisi için. [IP Geolocation by DB-IP](https://db-ip.com)
- Uygulamaların derlenmesinde kullanılan resmi Docker imajları (Node.js, Python, PHP/FrankenPHP, Go, Rust, .NET, Java, Ruby, Caddy...).
