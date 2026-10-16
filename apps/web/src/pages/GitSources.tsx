import { GithubSettings } from "@/components/GithubSettings";
import { PageHeader } from "@/components/ui";
import { t } from "@/lib/i18n";

/** Git sağlayıcı bağlantıları (şimdilik GitHub App). */
export function GitSourcesPage() {
  return (
    <>
      <PageHeader title={t("Git kaynakları")} description={t("Özel repoları token girmeden deploy etmek ve push/PR olaylarını otomatik almak için Git sağlayıcını bağla.")} />
      <GithubSettings />
    </>
  );
}
