// src/lib/api.js
export const API_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.MODE === "development"
    ? "http://localhost:3000"
    : "https://resumail-backendv4.onrender.com");