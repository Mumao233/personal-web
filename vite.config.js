import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite rewrites the entry tag, so `blocking` has to be added back after it does.
// Without it the first frame is captured before the app has rendered, and a
// cross-document view transition has no shared element to land on.
const renderBlockingEntry = () => ({
  name: "render-blocking-entry",
  transformIndexHtml: {
    order: "post",
    handler: (html) =>
      html.replace(
        /<script type="module" crossorigin src="/,
        '<script type="module" blocking="render" crossorigin src="',
      ),
  },
});

export default defineConfig({
  plugins: [react(), renderBlockingEntry()],
  server: { host: "127.0.0.1" },
  build: { chunkSizeWarningLimit: 1800, assetsDir: "space-assets" },
});
