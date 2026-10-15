import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Layout } from "@/components/Layout";
import { Toaster } from "@/components/ui/toast";
import { useAuthStatus } from "@/lib/auth";
import { AppDetailPage } from "@/pages/AppDetail";
import { DatabaseDetailPage } from "@/pages/DatabaseDetail";
import { DashboardPage } from "@/pages/Dashboard";
import { LoginPage } from "@/pages/Login";
import { ProjectDetailPage } from "@/pages/ProjectDetail";
import { ProjectsPage } from "@/pages/Projects";
import { SecurityPage } from "@/pages/Security";
import { ServerDetailPage } from "@/pages/ServerDetail";
import { ServersPage } from "@/pages/Servers";
import { SettingsPage } from "@/pages/Settings";
import { SetupPage } from "@/pages/Setup";
import { ChangePasswordPage } from "@/pages/ChangePassword";
import { t } from "@/lib/i18n";

export function App() {
  const { data, isLoading, error } = useAuthStatus();

  if (isLoading) return <div className="min-h-dvh" />;
  if (error || !data)
    return <div className="grid min-h-dvh place-items-center px-4 text-center text-[15px] text-muted">{t("Panel sunucusuna ulaşılamıyor. Sunucunun çalıştığından emin olup sayfayı yenile.")}</div>;

  return (
    <>
      {data.setupRequired ? (
        <SetupPage />
      ) : !data.user ? (
        <LoginPage />
      ) : data.user.mustChangePassword ? (
        <ChangePasswordPage />
      ) : (
        <BrowserRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="/apps/:id" element={<AppDetailPage />} />
              <Route path="/databases/:id" element={<DatabaseDetailPage />} />
              <Route path="/servers" element={<ServersPage />} />
              <Route path="/servers/:id" element={<ServerDetailPage />} />
              <Route path="/security" element={<SecurityPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      )}
      <Toaster />
    </>
  );
}
