import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { fileURLToPath } from "url";
import { componentTagger } from "lovable-tagger";

const BACKEND_API_TARGET =
  process.env.BACKEND_API_BASE_URL ||
  process.env.VITE_BACKEND_BASE_URL ||
  "https://api.skylinkscapital.com";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/rest/transactions": {
        target: "https://portal.skylinkscapital.com",
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
      "/rest/trades": {
        target: "https://portal.skylinkscapital.com",
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
      "/rest/users": {
        target: "https://portal.skylinkscapital.com",
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
      "/rest/accounts": {
        target: "https://portal.skylinkscapital.com",
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
      "/rest/ib/tree": {
        target: "https://portal.skylinkscapital.com",
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
      "/api/mt5": {
        target: "http://127.0.0.1:8001",
        changeOrigin: true,
        rewrite: (reqPath) => reqPath.replace(/^\/api\/mt5/, "/mt5_api.php"),
      },
      "/ws": {
        target: "https://portal.skylinkscapital.com",
        changeOrigin: true,
        ws: true,
        secure: true,
        rewrite: (reqPath) => reqPath,
      },
      "/api/wallet": {
        target: "https://crm.skylinkscapital.com",
        changeOrigin: true,
        secure: true,
        rewrite: (reqPath) => reqPath.replace(/^\/api\/wallet/, ""),
      },
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
      "/NopReport": {
        target: BACKEND_API_TARGET,
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
      "/EquityOverview": {
        target: BACKEND_API_TARGET,
        changeOrigin: true,
        rewrite: (reqPath) => reqPath,
      },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
