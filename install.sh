#!/usr/bin/env bash
# Xudbin kurulum scripti — Ubuntu/Debian sunucular için.
#
#   curl -fsSL <adres>/install.sh | sudo bash
#
# Seçenekler (ortam değişkeni):
#   XUDBIN_DOMAIN  Panel için kendi domainin (boşsa <ip>.sslip.io adresi üretilir)
#   ACME_EMAIL     Let's Encrypt bildirimleri için e-posta (isteğe bağlı)
#   XUDBIN_REPO    Kaynak kodun git adresi (script repo içinden çalıştırılmıyorsa gerekli)
set -euo pipefail

INSTALL_DIR=/opt/xudbin
c_green=$'\e[32m'; c_red=$'\e[31m'; c_dim=$'\e[2m'; c_reset=$'\e[0m'
step() { echo "${c_green}==>${c_reset} $*"; }
fail() { echo "${c_red}Hata:${c_reset} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Bu script root olarak çalışmalı (sudo bash install.sh)."
[[ $(uname -s) == Linux ]] || fail "Xudbin yalnızca Linux sunucularda çalışır."

# --- Port kontrolü: 80 ve 443 boş olmalı ---
for port in 80 443; do
  if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^xudbin-caddy'; then
      fail "$port portu başka bir servis tarafından kullanılıyor (nginx/apache?). Önce onu durdur."
    fi
  fi
done

# --- Docker ---
if ! command -v docker >/dev/null 2>&1; then
  step "Docker kuruluyor..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || fail "Docker Compose eklentisi bulunamadı."

# --- Kaynak kod ---
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")
if [[ -n $SCRIPT_DIR && -f $SCRIPT_DIR/install.sh && -d $SCRIPT_DIR/apps/server && $SCRIPT_DIR != "$INSTALL_DIR" ]]; then
  step "Kaynak kod kopyalanıyor: $SCRIPT_DIR -> $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -C "$SCRIPT_DIR" --exclude=node_modules --exclude=dist --exclude=data --exclude=.git -cf - . | tar -C "$INSTALL_DIR" -xf -
elif [[ ! -f $INSTALL_DIR/docker-compose.yml ]]; then
  [[ -n ${XUDBIN_REPO:-} ]] || fail "Kaynak kod bulunamadı. XUDBIN_REPO=<git adresi> ile çalıştır."
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
  step "Kaynak kod indiriliyor: $XUDBIN_REPO"
  git clone --depth 1 "$XUDBIN_REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- Domain: yoksa sslip.io ile otomatik üret ---
# Komut satırında verilen değerler, önceki kurulumdan kalan .env'yi ezer.
CLI_DOMAIN=${XUDBIN_DOMAIN:-}; CLI_EMAIL=${ACME_EMAIL:-}
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi
XUDBIN_DOMAIN=${CLI_DOMAIN:-${XUDBIN_DOMAIN:-}}; ACME_EMAIL=${CLI_EMAIL:-${ACME_EMAIL:-}}
if [[ -z ${XUDBIN_DOMAIN:-} ]]; then
  step "Sunucunun dış IP adresi bulunuyor..."
  PUBLIC_IP=$(curl -4 -fsS --max-time 5 https://api.ipify.org || curl -4 -fsS --max-time 5 https://ifconfig.me || true)
  [[ $PUBLIC_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Dış IP bulunamadı. XUDBIN_DOMAIN=panel.ornek.com ile tekrar dene."
  XUDBIN_DOMAIN="xudbin.${PUBLIC_IP//./-}.sslip.io"
fi

cat > .env <<ENV
XUDBIN_DOMAIN=${XUDBIN_DOMAIN}
ACME_EMAIL=${ACME_EMAIL:-}
HOST_HOSTNAME=$(hostname)
ENV
chmod 600 .env

# --- Başlat ---
step "Xudbin derleniyor ve başlatılıyor (ilk seferde birkaç dakika sürebilir)..."
docker compose up -d --build

step "HTTPS sertifikası bekleniyor..."
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://${XUDBIN_DOMAIN}/api/auth/status" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 3
done

echo
if [[ ${READY:-0} == 1 ]]; then
  echo "${c_green}Xudbin hazır!${c_reset}"
else
  echo "Xudbin başlatıldı ama HTTPS henüz doğrulanamadı. 80/443 portlarının açık olduğundan emin ol."
  echo "${c_dim}Loglar: cd $INSTALL_DIR && docker compose logs caddy${c_reset}"
fi
SETUP_TOKEN=$(docker compose exec -T xudbin cat /data/setup-token 2>/dev/null || true)
echo
if [[ -n $SETUP_TOKEN ]]; then
  echo "  Kurulum linki:  https://${XUDBIN_DOMAIN}/?setup=${SETUP_TOKEN}"
  echo "  ${c_dim}Bu linkle yönetici hesabını oluştur. Linki kimseyle paylaşma.${c_reset}"
else
  echo "  Panel adresi:   https://${XUDBIN_DOMAIN}"
fi
echo
