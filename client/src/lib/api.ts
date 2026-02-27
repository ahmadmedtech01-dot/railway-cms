import { apiRequest } from "./queryClient";

export const api = {
  // Auth
  login: (email: string, password: string) =>
    apiRequest("POST", "/api/auth/login", { email, password }),

  // Videos
  getVideos: () => fetch("/api/videos").then(r => r.json()),
  createVideo: (data: any) => apiRequest("POST", "/api/videos", data),
  getVideo: (id: string) => fetch(`/api/videos/${id}`).then(r => r.json()),
  updateVideo: (id: string, data: any) => apiRequest("PUT", `/api/videos/${id}`, data),
  deleteVideo: (id: string) => apiRequest("DELETE", `/api/videos/${id}`),
  toggleAvailability: (id: string) => apiRequest("POST", `/api/videos/${id}/toggle-availability`),
  updatePlayerSettings: (id: string, data: any) => apiRequest("PUT", `/api/videos/${id}/player-settings`, data),
  updateWatermarkSettings: (id: string, data: any) => apiRequest("PUT", `/api/videos/${id}/watermark-settings`, data),
  updateSecuritySettings: (id: string, data: any) => apiRequest("PUT", `/api/videos/${id}/security-settings`, data),

  // Tokens
  getTokens: (videoId: string) => fetch(`/api/videos/${videoId}/tokens`).then(r => r.json()),
  createToken: (videoId: string, data: any) => apiRequest("POST", `/api/videos/${videoId}/tokens`, data),
  revokeToken: (id: string) => apiRequest("POST", `/api/tokens/${id}/revoke`),
  deleteToken: (id: string) => apiRequest("DELETE", `/api/tokens/${id}`),
  getAllTokens: () => fetch("/api/tokens").then(r => r.json()),

  // Analytics
  getAnalytics: (id: string) => fetch(`/api/videos/${id}/analytics`).then(r => r.json()),
  getSessions: (id: string) => fetch(`/api/videos/${id}/sessions`).then(r => r.json()),

  // Audit
  getAuditLogs: () => fetch("/api/audit").then(r => r.json()),

  // Settings
  getSettings: () => fetch("/api/settings").then(r => r.json()),
  updateSettings: (data: any) => apiRequest("PUT", "/api/settings", data),

  // Dashboard
  getDashboard: () => fetch("/api/dashboard").then(r => r.json()),
};
