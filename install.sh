#!/usr/bin/env bash
# Xudbin kurulum scripti — Ubuntu/Debian ve AlmaLinux/Rocky/RHEL sunucular için.
#
#   sudo ./install.sh
#
# Seçenekler (ortam değişkeni):
#   XUDBIN_DOMAIN  Panel için kendi domainin (boşsa <ip>.sslip.io adresi üretilir)
#   ACME_EMAIL     Let's Encrypt bildirimleri için e-posta (isteğe bağlı)
#   XUDBIN_REPO    Kaynak kodun git adresi (script repo içinden çalıştırılmıyorsa gerekli)
#   XUDBIN_HARDEN  0 yapılırsa güvenlik duvarı ve fail2ban kurulmaz (varsayılan 1)
#   XUDBIN_HTTPS   0 yapılırsa HTTPS kapalı kurulur (dış IP'si olmayan yerel ağ/test sunucuları için)
set -euo pipefail

INSTALL_DIR=/opt/xudbin
c_green=$'\e[32m'; c_red=$'\e[31m'; c_dim=$'\e[2m'; c_reset=$'\e[0m'
step() { echo "${c_green}==>${c_reset} $*"; }
fail() { echo "${c_red}Hata:${c_reset} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Bu script root olarak çalışmalı (sudo ./install.sh)."
[[ $(uname -s) == Linux ]] || fail "Xudbin yalnızca Linux sunucularda çalışır."

# --- Port kontrolü: 80 ve 443 boş olmalı (Xudbin'in kendi Caddy'si hariç) ---
for port in 80 443; do
  if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'xudbin-caddy'; then
      fail "$port portu başka bir servis tarafından kullanılıyor (nginx/apache/CloudPanel?). Önce onu durdur."
    fi
  fi
done

# --- Swap: düşük RAM'li sunucularda derlemeler (Caddy, Node) bellek yetersizliğinden çökmesin ---
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [[ $MEM_MB -lt 3000 ]] && ! swapon --show --noheadings | grep -q . && [[ ! -e /swapfile ]]; then
  step "RAM ${MEM_MB} MB; 2 GB swap oluşturuluyor..."
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

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
  command -v git >/dev/null || { command -v apt-get >/dev/null && { apt-get update -qq && apt-get install -y -qq git; } || dnf install -y -q git; }
  step "Kaynak kod indiriliyor: $XUDBIN_REPO"
  git clone --depth 1 "$XUDBIN_REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- Domain: yoksa sslip.io ile otomatik üret ---
# Komut satırında verilen değerler, önceki kurulumdan kalan .env'yi ezer.
CLI_DOMAIN=${XUDBIN_DOMAIN:-}; CLI_EMAIL=${ACME_EMAIL:-}; CLI_HTTPS=${XUDBIN_HTTPS:-}
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi
XUDBIN_DOMAIN=${CLI_DOMAIN:-${XUDBIN_DOMAIN:-}}; ACME_EMAIL=${CLI_EMAIL:-${ACME_EMAIL:-}}; XUDBIN_HTTPS=${CLI_HTTPS:-${XUDBIN_HTTPS:-1}}
if [[ $XUDBIN_HTTPS == 0 ]]; then SCHEME=http; SECURE_COOKIES=false; else SCHEME=https; SECURE_COOKIES=true; fi
if [[ -z ${XUDBIN_DOMAIN:-} ]]; then
  if [[ $XUDBIN_HTTPS == 0 ]]; then
    PUBLIC_IP=$(hostname -I | awk '{print $1}')
  else
    step "Sunucunun dış IP adresi bulunuyor..."
    PUBLIC_IP=$(curl -4 -fsS --max-time 5 https://api.ipify.org || curl -4 -fsS --max-time 5 https://ifconfig.me || true)
  fi
  [[ $PUBLIC_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "IP adresi bulunamadı. XUDBIN_DOMAIN=panel.ornek.com ile tekrar dene."
  XUDBIN_DOMAIN="xudbin.${PUBLIC_IP//./-}.sslip.io"
fi

cat > .env <<ENV
XUDBIN_DOMAIN=${XUDBIN_DOMAIN}
ACME_EMAIL=${ACME_EMAIL:-}
XUDBIN_HTTPS=${XUDBIN_HTTPS}
XUDBIN_PUBLIC_IP=${PUBLIC_IP:-}
SECURE_COOKIES=${SECURE_COOKIES}
HOST_HOSTNAME=$(hostname)
ENV
chmod 600 .env

# --- Sunucu güvenliği: güvenlik duvarı + SSH kaba kuvvet koruması ---
# Debian/Ubuntu'da UFW, AlmaLinux/Rocky/RHEL'de firewalld kullanılır; fail2ban ikisinde de var.
if [[ ${XUDBIN_HARDEN:-1} == 1 ]]; then
  SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)
  SSH_PORT=${SSH_PORT:-22}
  if command -v apt-get >/dev/null; then
    step "Güvenlik duvarı (UFW) ve fail2ban kuruluyor..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw fail2ban >/dev/null
    ufw allow "$SSH_PORT"/tcp >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
    ufw --force enable >/dev/null
    F2B_BACKEND=auto
  elif command -v dnf >/dev/null; then
    step "Güvenlik duvarı (firewalld) ve fail2ban kuruluyor..."
    dnf install -y -q epel-release >/dev/null
    dnf install -y -q firewalld fail2ban >/dev/null
    systemctl enable --now firewalld >/dev/null 2>&1
    firewall-cmd -q --permanent --add-port="$SSH_PORT"/tcp
    firewall-cmd -q --permanent --add-port=80/tcp
    firewall-cmd -q --permanent --add-port=443/tcp
    firewall-cmd -q --permanent --add-port=443/udp
    firewall-cmd -q --reload
    F2B_BACKEND=systemd
  fi
  if [[ -d /etc/fail2ban ]]; then
    printf '[sshd]\nenabled = true\nport = %s\nbackend = %s\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' "$SSH_PORT" "$F2B_BACKEND" > /etc/fail2ban/jail.d/xudbin.local
    systemctl enable --now fail2ban >/dev/null 2>&1 || true
    systemctl restart fail2ban || true
    echo "   Açık portlar: $SSH_PORT (SSH), 80, 443"
  fi
fi

# --- Başlat ---
step "Xudbin derleniyor ve başlatılıyor (ilk seferde birkaç dakika sürebilir)..."
docker compose up -d --build

if [[ $SCHEME == https ]]; then
  step "Panel, Caddy'yi WAF modülleriyle derliyor ve HTTPS sertifikası alıyor (3-6 dakika)..."
else
  step "Panel, Caddy'yi WAF modülleriyle derliyor (3-6 dakika)..."
fi
for _ in $(seq 1 120); do
  if curl -fsS --max-time 5 "${SCHEME}://${XUDBIN_DOMAIN}/api/auth/status" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 5
done

SETUP_TOKEN=$(docker compose exec -T xudbin cat /data/setup-token 2>/dev/null || true)
echo
if [[ ${READY:-0} == 1 ]]; then
  echo "${c_green}Xudbin hazır!${c_reset}"
else
  echo "Xudbin başlatıldı ama HTTPS henüz doğrulanamadı. 80/443 portlarının dışarıya açık olduğundan emin ol."
  echo "${c_dim}Loglar: docker logs xudbin  |  docker logs xudbin-caddy${c_reset}"
fi
echo
if [[ -n $SETUP_TOKEN ]]; then
  echo "  Kurulum linki:  ${SCHEME}://${XUDBIN_DOMAIN}/?setup=${SETUP_TOKEN}"
  echo "  ${c_dim}Bu linkle yönetici hesabını oluştur. Linki kimseyle paylaşma.${c_reset}"
else
  echo "  Panel adresi:   ${SCHEME}://${XUDBIN_DOMAIN}"
fi
echo
