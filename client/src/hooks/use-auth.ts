import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";

export function useAuth() {
  const { data, isLoading } = useQuery({
    queryKey: ["/api/auth/me"],
    retry: false,
  });
  return { user: data as { id: string; email: string } | undefined, isLoading };
}

export function useLogout() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  return useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout"),
    onSuccess: () => {
      qc.clear();
      setLocation("/login");
    },
  });
}
