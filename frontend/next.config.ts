import type { NextConfig } from "next";

// LAPIDARE_EXPORT=1 builds the static site that FastAPI serves on the same origin as /api
// (Electron AppImage); dev and `next start` keep proxying /api to the backend.
const isExport = process.env.LAPIDARE_EXPORT === "1";

const nextConfig: NextConfig = isExport
  ? {
      reactStrictMode: true,
      output: "export",
      images: { unoptimized: true },
    }
  : {
      reactStrictMode: true,
      experimental: {
        // GitHub previews clone whole repositories and LLM-backed routes can take minutes;
        // the 30s default proxy timeout cut them off with a socket hang up.
        proxyTimeout: 300_000,
      },
      async rewrites() {
        const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:8000";
        return [
          {
            source: "/api/:path*",
            destination: `${backendUrl}/api/:path*`,
          },
        ];
      },
    };

export default nextConfig;
