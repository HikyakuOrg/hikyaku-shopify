import { vercelPreset } from "@vercel/react-router/vite";
import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Only on Vercel, which deploys the server build as per-function bundles.
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
