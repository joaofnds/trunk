const BASE = "/api/v1";

export const ENDPOINTS = {
  auth: {
    login: `${BASE}/auth/login`,
    logout: `${BASE}/auth/logout`,
    refresh: `${BASE}/auth/refresh`,
    register: `${BASE}/auth/register`,
    verify: `${BASE}/auth/verify-email`,
  },
  users: {
    list: `${BASE}/users`,
    get: (id: string) => `${BASE}/users/${id}`,
    update: (id: string) => `${BASE}/users/${id}`,
    delete: (id: string) => `${BASE}/users/${id}`,
    avatar: (id: string) => `${BASE}/users/${id}/avatar`,
  },
  posts: {
    list: `${BASE}/posts`,
    get: (id: string) => `${BASE}/posts/${id}`,
    create: `${BASE}/posts`,
    update: (id: string) => `${BASE}/posts/${id}`,
    delete: (id: string) => `${BASE}/posts/${id}`,
    comments: (id: string) => `${BASE}/posts/${id}/comments`,
  },
} as const;
