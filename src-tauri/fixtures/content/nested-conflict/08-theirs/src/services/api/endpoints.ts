export const API_VERSION = "v2";

export const ENDPOINTS = {
  auth: {
    login: `/api/${API_VERSION}/auth/login`,
    logout: `/api/${API_VERSION}/auth/logout`,
    refresh: `/api/${API_VERSION}/auth/refresh`,
    register: `/api/${API_VERSION}/auth/register`,
    forgotPassword: `/api/${API_VERSION}/auth/forgot-password`,
    resetPassword: `/api/${API_VERSION}/auth/reset-password`,
  },
  users: {
    list: `/api/${API_VERSION}/users`,
    get: (id: string) => `/api/${API_VERSION}/users/${id}`,
    update: (id: string) => `/api/${API_VERSION}/users/${id}`,
    delete: (id: string) => `/api/${API_VERSION}/users/${id}`,
    profile: (id: string) => `/api/${API_VERSION}/users/${id}/profile`,
  },
  posts: {
    list: `/api/${API_VERSION}/posts`,
    get: (id: string) => `/api/${API_VERSION}/posts/${id}`,
    create: `/api/${API_VERSION}/posts`,
    update: (id: string) => `/api/${API_VERSION}/posts/${id}`,
    delete: (id: string) => `/api/${API_VERSION}/posts/${id}`,
    publish: (id: string) => `/api/${API_VERSION}/posts/${id}/publish`,
  },
  media: {
    upload: `/api/${API_VERSION}/media/upload`,
    get: (id: string) => `/api/${API_VERSION}/media/${id}`,
    delete: (id: string) => `/api/${API_VERSION}/media/${id}`,
  },
} as const;
