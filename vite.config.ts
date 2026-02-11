import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      '/rest/transactions': {
        target: 'https://portal.skylinkscapital.com',
        changeOrigin: true,
        rewrite: (path) => path,
      },
      '/rest/trades': {
        target: 'https://portal.skylinkscapital.com',
        changeOrigin: true,
        rewrite: (path) => path,
      },
      '/rest/users': {
        target: 'https://portal.skylinkscapital.com',
        changeOrigin: true,
        rewrite: (path) => path,
      },
      '/rest/accounts': {
        target: 'https://portal.skylinkscapital.com',
        changeOrigin: true,
        rewrite: (path) => path,
      },
      '/api/mt5': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/mt5/, '/mt5_api.php'),
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
