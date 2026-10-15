import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Layout } from "@/components/Layout";
import { useAuthStatus } from "@/lib/auth";
import { DashboardPage } from "@/pages/Dashboard";
import { LoginPage } from "@/pages/Login";
import { SetupPage } from "@/pages/Setup";

export function App() {
  const { data, isLoading, error } = useAuthStatus();

  if (isLoading) return <div className="min-h-dvh" />;
  if (error || !data)
    return <div className="grid min-h-dvh place-items-center text-sm text-muted">Panel sunucusuna ulaşılamıyor.</div>;
  if (data.setupRequired) return <SetupPage />;
  if (!data.user) return <LoginPage />;

  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
