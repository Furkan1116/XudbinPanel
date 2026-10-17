#!/usr/bin/env bash
# Xudbin kurulum betiği — Ubuntu/Debian ve AlmaLinux/Rocky/RHEL sunucular için.
#
#   curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo bash
#   (veya repo içinden)  sudo ./install.sh
#   Güncelleme:          sudo xudbin update
#
# Seçenekler (ortam değişkeni):
#   XUDBIN_DOMAIN  Panel için kendi alan adın (boşsa <ip>.sslip.io adresi üretilir)
#   ACME_EMAIL     Let's Encrypt bildirimleri için e-posta (isteğe bağlı)
#   XUDBIN_REPO    Kaynak kodun git adresi (varsayılan: resmi repo)
#   XUDBIN_IMAGE   Hazır panel imajı (varsayılan: son sürüm etiketi, ör. ghcr.io/furkan1116/xudbin:1.3.1)
#   XUDBIN_REF     Kurulacak sürüm etiketi (varsayılan: GitHub'daki en yeni v* etiketi)
#   XUDBIN_VERIFY  0 yapılırsa imaj imzası doğrulanmaz (önerilmez; kendi imajın/çatalın için)
#   XUDBIN_HARDEN  0 yapılırsa güvenlik duvarı ve fail2ban kurulmaz (varsayılan 1)
#   XUDBIN_HTTPS   0 yapılırsa HTTPS kapalı kurulur (dış IP'si olmayan yerel ağ/test sunucuları için)
# Betiğin tamamı bir fonksiyonun içinde ve en sonda çağrılıyor: "curl | bash" sırasında bağlantı kesilirse
# yarım inmiş betiğin hiçbir satırı çalışmaz.
xudbin_install() {
set -euo pipefail

INSTALL_DIR=/opt/xudbin
DEFAULT_REPO=https://github.com/Furkan1116/XudbinPanel
IMAGE_REPO=ghcr.io/furkan1116/xudbin
CADDY_IMAGE_REPO=ghcr.io/furkan1116/xudbin-caddy
CADDY_IMAGE_TAG=1
# İmza doğrulaması: imaj yalnız resmi reponun GitHub Actions iş akışında imzalanmışsa kabul edilir.
# cosign sunucuda kurulu olmayabilir; sürümü ve özeti sabit resmi konteyneri kullanılır.
COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign:v2.4.1@sha256:b03690aa52bfe94054187142fba24dc54137650682810633901767d8a3e15b31
SIGNER_IDENTITY='^https://github\.com/Furkan1116/XudbinPanel/\.github/workflows/'
SIGNER_ISSUER=https://token.actions.githubusercontent.com
MODE=install
[[ ${1:-} == --update ]] && MODE=update

R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; D=$'\e[2m'; B=$'\e[1m'; X=$'\e[0m'
TOTAL=7; N=0
step() { N=$((N + 1)); echo; echo "${R}[$N/$TOTAL]${X} ${B}$*${X}"; }
ok() { echo "   ${G}✓${X} $*"; }
info() { echo "   ${D}$*${X}"; }
fail() { echo; echo "   ${R}✗ Hata:${X} $*" >&2; exit 1; }

# Güncelleme sonucu panelde gösterilir (Ayarlar > Panel).
STATUS_FILE=/opt/xudbin/.update-status
status() { mkdir -p /opt/xudbin && printf '%s\n' "$*" > "$STATUS_FILE" 2>/dev/null || true; }

# En yeni sürüm etiketi (v1.2.3). main dalı panellere inmez; yalnız etiketlenmiş sürümler kurulur.
latest_tag() {
  git ls-remote --tags --refs "$1" 'v*' 2>/dev/null | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}

# İmajı indirir, imzasını doğrular ve değişmez özet adresini (repo@sha256:...) yazdırır.
# Dönüş: 0 doğrulandı, 1 imaj indirilemedi, 2 imza doğrulanamadı.
verify_image() {
  local ref=$1 digest
  docker pull -q "$ref" >/dev/null 2>&1 || return 1
  digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" 2>/dev/null | grep -F "${ref%%[:@]*}@" | head -1)
  [[ -n $digest ]] || return 1
  if [[ ${XUDBIN_VERIFY:-1} == 0 ]]; then echo "$digest"; return 0; fi
  docker run --rm "$COSIGN_IMAGE" verify \
    --certificate-identity-regexp "$SIGNER_IDENTITY" \
    --certificate-oidc-issuer "$SIGNER_ISSUER" "$digest" >/dev/null 2>&1 || return 2
  echo "$digest"
}

banner() {
  echo
  echo "${R}   ██╗  ██╗██╗   ██╗██████╗ ██████╗ ██╗███╗   ██╗${X}"
  echo "${R}   ╚██╗██╔╝██║   ██║██╔══██╗██╔══██╗██║████╗  ██║${X}"
  echo "${R}    ╚███╔╝ ██║   ██║██║  ██║██████╔╝██║██╔██╗ ██║${X}"
  echo "${R}    ██╔██╗ ██║   ██║██║  ██║██╔══██╗██║██║╚██╗██║${X}"
  echo "${R}   ██╔╝ ██╗╚██████╔╝██████╔╝██████╔╝██║██║ ╚████║${X}"
  echo "${R}   ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝${X}"
  echo "   ${D}Sunucularını tek panelden yönet: otomatik domain, ücretsiz HTTPS, saldırı koruması${X}"
}

banner
[[ $MODE == update ]] && TOTAL=5

# --- 1. Sistem ---------------------------------------------------------------
step "Sistem kontrol ediliyor"
[[ $EUID -eq 0 ]] || fail "Root olarak çalıştır: sudo bash install.sh"
[[ $(uname -s) == Linux ]] || fail "Xudbin yalnızca Linux sunucularda çalışır."
OS_NAME=$( (. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null || echo Linux)
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
ok "$OS_NAME, $(nproc) çekirdek, ${MEM_MB} MB RAM"
if [[ $MODE == install ]]; then
  for port in 80 443; do
    if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
      docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'xudbin-caddy' || fail "$port portu kullanımda (nginx/apache/CloudPanel?). Önce o servisi durdur."
    fi
  done
  ok "80 ve 443 portları boş"
  # Düşük RAM'li sunucularda derlemeler (Caddy, Node) bellek yetersizliğinden çökmesin.
  if [[ $MEM_MB -lt 3000 ]] && ! swapon --show --noheadings | grep -q . && [[ ! -e /swapfile ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "Düşük RAM için 2 GB swap oluşturuldu"
  fi
fi

# --- 2. Docker ---------------------------------------------------------------
if [[ $MODE == install ]]; then
  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    info "Docker kuruluyor (get.docker.com)..."
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || fail "Docker kurulamadı."
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || fail "Docker Compose eklentisi bulunamadı."
  ok "$(docker --version | sed 's/,.*//')"
fi

# --- 3. Kaynak kod -------------------------------------------------------------
step "Xudbin indiriliyor"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")
REPO=${XUDBIN_REPO:-$DEFAULT_REPO}
ensure_git() { command -v git >/dev/null || { command -v apt-get >/dev/null && { apt-get update -qq && apt-get install -y -qq git >/dev/null; } || dnf install -y -q git >/dev/null; }; }
LOCAL_SOURCE=0
[[ -n $SCRIPT_DIR && -f $SCRIPT_DIR/install.sh && -d $SCRIPT_DIR/apps/server && $SCRIPT_DIR != "$INSTALL_DIR" ]] && LOCAL_SOURCE=1

# Önceki kurulumun imajı kendi imajınsa (resmi repo dışı) korunur; resmi imaj her güncellemede yeni sürüme geçer.
OLD_IMAGE=$( [[ -f $INSTALL_DIR/.env ]] && sed -n 's/^XUDBIN_IMAGE=//p' "$INSTALL_DIR/.env" | tail -1 || true)
CUSTOM_IMAGE=${XUDBIN_IMAGE:-}
if [[ -z $CUSTOM_IMAGE && -n $OLD_IMAGE && $OLD_IMAGE != "$IMAGE_REPO"* && $OLD_IMAGE != xudbin:local ]]; then CUSTOM_IMAGE=$OLD_IMAGE; fi

TAG=${XUDBIN_REF:-}
PANEL_IMAGE=""
if [[ $LOCAL_SOURCE == 0 ]]; then
  ensure_git
  [[ -n $TAG ]] || TAG=$(latest_tag "$REPO")
  [[ -n $TAG ]] || fail "Sürüm etiketi bulunamadı ($REPO). İnternet bağlantısını kontrol et."
  info "Sürüm: $TAG"
fi

# İmaj, kod değiştirilmeden ÖNCE doğrulanır: doğrulama başarısızsa sunucuda hiçbir şey değişmez.
if [[ -n $CUSTOM_IMAGE ]]; then
  PANEL_IMAGE=$CUSTOM_IMAGE
  info "Kendi imajın kullanılıyor: $PANEL_IMAGE"
  if [[ ${XUDBIN_VERIFY:-1} != 0 ]]; then
    echo "   ${Y}!${X} Kendi imajının imzası resmi repoyla doğrulanamaz; XUDBIN_VERIFY=0 ile çalıştırıyorsan bunu bilerek yap."
  fi
elif [[ -n $TAG ]]; then
  set +e
  PANEL_IMAGE=$(verify_image "$IMAGE_REPO:${TAG#v}")
  rc=$?
  set -e
  if [[ $rc == 0 ]]; then
    ok "İmaj imzası doğrulandı: ${PANEL_IMAGE#*@}"
  elif [[ $rc == 2 ]]; then
    status "verify-failed $TAG"
    fail "İmzası doğrulanamayan imaj kurulmadı ($IMAGE_REPO:${TAG#v}). $([[ $MODE == update ]] && echo "Mevcut sürüm çalışmaya devam ediyor.")"
  else
    PANEL_IMAGE=""
    if [[ $MODE == update ]]; then
      status "pull-failed $TAG"
      fail "Yeni sürümün imajı indirilemedi ($IMAGE_REPO:${TAG#v}). Mevcut sürüm çalışmaya devam ediyor."
    fi
    echo "   ${Y}!${X} Hazır imaj indirilemedi; panel kaynaktan derlenecek (imza doğrulaması YAPILAMAZ)."
  fi
fi

if [[ $LOCAL_SOURCE == 1 ]]; then
  mkdir -p "$INSTALL_DIR"
  tar -C "$SCRIPT_DIR" --exclude=node_modules --exclude=dist --exclude=data --exclude=.git --exclude=.env -cf - . | tar -C "$INSTALL_DIR" -xf -
  ok "Kaynak kod kopyalandı: $SCRIPT_DIR"
elif [[ -d $INSTALL_DIR/.git ]]; then
  git -C "$INSTALL_DIR" fetch -q --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" || fail "Sürüm indirilemedi: $TAG"
  git -C "$INSTALL_DIR" -c advice.detachedHead=false checkout -q "$TAG" || fail "Sürüme geçilemedi: $TAG"
  ok "Sürüm $TAG çekildi"
elif [[ ! -f $INSTALL_DIR/docker-compose.yml ]]; then
  git clone -q --depth 1 --branch "$TAG" "$REPO" "$INSTALL_DIR" || fail "Repo indirilemedi: $REPO ($TAG)"
  ok "İndirildi: $REPO ($TAG)"
else
  ok "Mevcut kurulum kullanılıyor"
fi
cd "$INSTALL_DIR"
install -m 0755 "$INSTALL_DIR/scripts/xudbin" /usr/local/bin/xudbin
ok "xudbin komutu kuruldu (xudbin link, xudbin status, xudbin update...)"

# --- Ayarlar (.env) ---
CLI_DOMAIN=${XUDBIN_DOMAIN:-}; CLI_EMAIL=${ACME_EMAIL:-}; CLI_HTTPS=${XUDBIN_HTTPS:-}
# .env bir kabuk betiği gibi çalıştırılmaz (içine yazılmış komutlar root olarak çalışırdı); yalnız bilinen anahtarlar,
# güvenli karakterlerden oluşan değerlerle okunur.
if [[ -f .env ]]; then
  while IFS='=' read -r key value; do
    value=${value%\"}; value=${value#\"}
    [[ $value =~ ^[A-Za-z0-9@._:/+-]*$ ]] || continue
    case $key in
      XUDBIN_DOMAIN|ACME_EMAIL|XUDBIN_HTTPS|XUDBIN_PUBLIC_IP) printf -v "$key" '%s' "$value" ;;
    esac
  done < .env
fi
XUDBIN_DOMAIN=${CLI_DOMAIN:-${XUDBIN_DOMAIN:-}}; ACME_EMAIL=${CLI_EMAIL:-${ACME_EMAIL:-}}
XUDBIN_HTTPS=${CLI_HTTPS:-${XUDBIN_HTTPS:-1}}; XUDBIN_IMAGE=$PANEL_IMAGE
if [[ $XUDBIN_HTTPS == 0 ]]; then SCHEME=http; SECURE_COOKIES=false; else SCHEME=https; SECURE_COOKIES=true; fi
PUBLIC_IP=${XUDBIN_PUBLIC_IP:-}
if [[ -z ${XUDBIN_DOMAIN:-} ]]; then
  if [[ $XUDBIN_HTTPS == 0 ]]; then
    PUBLIC_IP=$(hostname -I | awk '{print $1}')
  else
    PUBLIC_IP=$(curl -4 -fsS --max-time 5 https://api.ipify.org || curl -4 -fsS --max-time 5 https://ifconfig.me || true)
  fi
  [[ $PUBLIC_IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "IP adresi bulunamadı. XUDBIN_DOMAIN=panel.ornek.com ile tekrar dene."
  XUDBIN_DOMAIN="xudbin.${PUBLIC_IP//./-}.sslip.io"
fi

# --- 4. Güvenlik duvarı ---------------------------------------------------------
# Debian/Ubuntu'da UFW, AlmaLinux/Rocky/RHEL'de firewalld kullanılır; fail2ban ikisinde de var.
if [[ $MODE == install ]]; then
  step "Sunucu güvenliği"
  if [[ ${XUDBIN_HARDEN:-1} == 1 ]]; then
    SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}' || true)
    SSH_PORT=${SSH_PORT:-22}
    if command -v apt-get >/dev/null; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw fail2ban >/dev/null
      for p in "$SSH_PORT/tcp" 80/tcp 443/tcp 443/udp; do ufw allow "$p" >/dev/null; done
      ufw --force enable >/dev/null
      F2B_BACKEND=auto
    elif command -v dnf >/dev/null; then
      dnf install -y -q epel-release >/dev/null && dnf install -y -q firewalld fail2ban >/dev/null
      systemctl enable --now firewalld >/dev/null 2>&1
      for p in "$SSH_PORT/tcp" 80/tcp 443/tcp 443/udp; do firewall-cmd -q --permanent --add-port="$p"; done
      firewall-cmd -q --reload
      F2B_BACKEND=systemd
    fi
    FW_DONE=0
    command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active' && FW_DONE=1
    command -v firewall-cmd >/dev/null && firewall-cmd -q --state 2>/dev/null && FW_DONE=1
    if [[ -d /etc/fail2ban ]]; then
      printf '[sshd]\nenabled = true\nport = %s\nbackend = %s\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' "$SSH_PORT" "${F2B_BACKEND:-auto}" > /etc/fail2ban/jail.d/xudbin.local
      systemctl enable --now fail2ban >/dev/null 2>&1 || true
      systemctl restart fail2ban || true
    fi
    if [[ $FW_DONE == 1 ]]; then
      ok "Güvenlik duvarı açık: yalnız $SSH_PORT (SSH), 80, 443"
    else
      info "Uyarı: apt-get/dnf bulunamadı ya da güvenlik duvarı etkinleşmedi; güvenlik duvarını elle kur (yalnız $SSH_PORT, 80, 443 açık olmalı)"
    fi
    if [[ -d /etc/fail2ban ]]; then ok "fail2ban: 10 dakikada 5 hatalı SSH girişi 1 saat ban"; else info "fail2ban kurulmadı"; fi
  else
    info "Atlandı (XUDBIN_HARDEN=0)"
  fi
fi

# --- 5. Panel ------------------------------------------------------------------
step "Panel başlatılıyor"
if [[ -n $XUDBIN_IMAGE ]]; then
  BUILD_FLAG=--no-build
else
  XUDBIN_IMAGE=xudbin:local
  info "Kaynaktan derleniyor (birkaç dakika)..."
  BUILD_FLAG=--build
fi
# Caddy (WAF) imajı da doğrulanır; doğrulanamazsa panel onu yerelde derler (hazır imaja güvenilmez).
set +e
CADDY_IMAGE=$(verify_image "$CADDY_IMAGE_REPO:$CADDY_IMAGE_TAG")
crc=$?
set -e
if [[ $crc == 0 ]]; then ok "Caddy imajı imzası doğrulandı"; else CADDY_IMAGE=""; info "Caddy imajı doğrulanamadı; panel yerelde derleyecek"; fi
cat > .env <<ENV
XUDBIN_DOMAIN=${XUDBIN_DOMAIN}
ACME_EMAIL=${ACME_EMAIL:-}
XUDBIN_HTTPS=${XUDBIN_HTTPS}
XUDBIN_PUBLIC_IP=${PUBLIC_IP:-}
XUDBIN_IMAGE=${XUDBIN_IMAGE}
XUDBIN_CADDY_IMAGE=${CADDY_IMAGE}
XUDBIN_VERSION=${TAG#v}
SECURE_COOKIES=${SECURE_COOKIES}
HOST_HOSTNAME=$(hostname)
ENV
chmod 600 .env
# Öngörülebilir /tmp yolu yerine mktemp (başka bir kullanıcı sembolik bağ koyup root'a dosya ezdiremesin).
COMPOSE_LOG=$(mktemp /tmp/xudbin-compose.XXXXXX)
docker compose up -d $BUILD_FLAG >"$COMPOSE_LOG" 2>&1 || { tail -20 "$COMPOSE_LOG"; fail "Panel başlatılamadı."; }
rm -f "$COMPOSE_LOG"
ok "Panel konteyneri çalışıyor"
status "ok ${TAG:-yerel}"

# --- 6. Caddy + sertifika --------------------------------------------------------
step "Alan adı ve ${SCHEME^^}"
if [[ $SCHEME == https ]]; then
  info "Caddy WAF ve hız sınırı modülleriyle hazırlanıyor, Let's Encrypt sertifikası alınıyor..."
else
  info "Caddy WAF ve hız sınırı modülleriyle hazırlanıyor..."
fi
READY=0
for i in $(seq 1 180); do
  if curl -fsS --max-time 5 "${SCHEME}://${XUDBIN_DOMAIN}/api/auth/status" >/dev/null 2>&1; then READY=1; break; fi
  (( i % 12 == 0 )) && info "Bekleniyor... ($((i * 5 / 60)) dk)"
  sleep 5
done
if [[ $READY == 1 ]]; then
  ok "${SCHEME}://${XUDBIN_DOMAIN} yanıt veriyor"
else
  echo "   ${Y}!${X} Adres henüz doğrulanamadı. 80/443 portlarının dışarıya açık olduğundan emin ol."
  info "Loglar: xudbin logs   |   docker logs xudbin-caddy"
fi

# --- 7. Bitti -----------------------------------------------------------------
step "$([[ $MODE == update ]] && echo "Güncellendi" || echo "Xudbin hazır")"
docker exec xudbin node dist/cli.js link || echo "   Panel: ${SCHEME}://${XUDBIN_DOMAIN}"
echo "   ${D}Komutlar: xudbin link | xudbin status | xudbin user list | xudbin update | xudbin logs${X}"
echo
}

xudbin_install "$@"
