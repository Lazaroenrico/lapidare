import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
