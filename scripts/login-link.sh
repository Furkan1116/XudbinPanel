# Xudbin: SSH ile girişte panel adresini gösterir (install.sh /etc/profile.d/xudbin.sh olarak kurar).
# Kullanıcının kendi yetkisiyle çalışır: yalnız Docker'a erişebilen (root ya da docker grubu)
# kullanıcılar görür. Kurulum bitmediyse link hesap oluşturma anahtarını içerdiği için bu önemli.
# Kapatmak için: sudo touch /etc/xudbin/no-login-link
case $- in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
if [ -z "${XUDBIN_LOGIN_LINK_SHOWN:-}" ] && [ ! -e /etc/xudbin/no-login-link ] && command -v docker >/dev/null 2>&1; then
  XUDBIN_LOGIN_LINK_SHOWN=1; export XUDBIN_LOGIN_LINK_SHOWN
  _xb_state=$(docker inspect -f '{{.State.Running}}' xudbin 2>/dev/null || true)
  if [ "$_xb_state" = true ]; then
    timeout 5 docker exec xudbin node dist/cli.js link --short 2>/dev/null || true
  elif [ -n "$_xb_state" ]; then
    echo "  Xudbin paneli çalışmıyor. Başlatmak için: sudo xudbin restart"
  fi
  unset _xb_state
fi
