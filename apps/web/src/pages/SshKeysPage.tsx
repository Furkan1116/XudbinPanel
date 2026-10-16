import { PageHeader } from "@/components/ui";
import { t } from "@/lib/i18n";
import { SshKeys } from "./Settings";

/** Sunuculara bağlanmak için kullanılan SSH anahtarları. */
export function SshKeysPage() {
  return (
    <>
      <PageHeader title={t("SSH anahtarları")} description={t("Uzak sunuculara bağlanırken kullanılan anahtarlar. Sunucu eklerken otomatik üretilir; buradan yenisini oluşturabilir veya var olanı içe aktarabilirsin.")} />
      <SshKeys />
    </>
  );
}
