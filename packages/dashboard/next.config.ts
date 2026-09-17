import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // Server-side proxy for any relative /api/v1 request. This runs inside the
  // dashboard container, so it must target the backend over the internal
  // network (INTERNAL_API_URL, e.g. http://backend:3001/api/v1) rather than
  // localhost. Browser calls go direct to the backend via runtime-config, so
  // this is only a fallback for same-origin/relative requests.
  async rewrites() {
    const target =
      process.env.INTERNAL_API_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      'http://localhost:3001/api/v1';
    return [
      {
        source: '/api/v1/:path*',
        destination: `${target}/:path*`,
      },
    ];
  },
};

export default nextConfig;
