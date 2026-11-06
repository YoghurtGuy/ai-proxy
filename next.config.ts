import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* 输出自包含的 server.js，供 Dockerfile 里的 runner 阶段直接用 */
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
