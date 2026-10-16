import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ApiError } from "./lib/api";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2 } },
  // Oturum düşerse (401) giriş ekranına dönmek için durum sorgusunu tazele.
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
  }),
});

async function boot() {
  // Demo derlemesi (VITE_DEMO=1): API istekleri tarayıcıdaki örnek verilerle yanıtlanır.
  // Koşul derleme anında sabitlendiği için normal pakete demo kodu girmez.
  if (import.meta.env.VITE_DEMO === "1") (await import("./demo")).installDemo();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
void boot();
