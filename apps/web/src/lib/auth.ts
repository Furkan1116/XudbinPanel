import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuthStatus } from "./api";

export function useAuthStatus() {
  return useQuery({ queryKey: ["auth"], queryFn: () => api.get<AuthStatus>("/auth/status"), staleTime: 60_000 });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => {
      qc.setQueryData<AuthStatus>(["auth"], (old) => (old ? { ...old, user: null } : old));
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
    },
  });
}
