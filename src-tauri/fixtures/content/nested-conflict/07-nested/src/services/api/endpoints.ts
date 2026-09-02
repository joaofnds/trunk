export const ENDPOINTS = {
  auth: {
    login: "/api/auth/login",
    logout: "/api/auth/logout",
    refresh: "/api/auth/refresh",
    register: "/api/auth/register",
  },
  users: {
    list: "/api/users",
    get: (id: string) => `/api/users/${id}`,
    update: (id: string) => `/api/users/${id}`,
    delete: (id: string) => `/api/users/${id}`,
  },
  posts: {
    list: "/api/posts",
    get: (id: string) => `/api/posts/${id}`,
    create: "/api/posts",
    update: (id: string) => `/api/posts/${id}`,
    delete: (id: string) => `/api/posts/${id}`,
  },
} as const;
