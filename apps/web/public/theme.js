// Sayfa çizilmeden önce temayı uygula ki açılışta yanlış renk yanıp sönmesin.
// Ayrı dosyada: panelin CSP'si satır içi betiklere izin vermez.
try {
  var t = localStorage.getItem("xudbin-theme");
  var dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch (e) {}
