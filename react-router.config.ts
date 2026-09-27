import { vercelPreset } from "@vercel/react-router/vite";
import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Only on Vercel: the preset splits the server build into per-function
  // bundles (build/server/<bundle>/index.js), which would break the Docker
  // image's `react-router-serve ./build/server/index.js`.
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
