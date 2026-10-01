import type { NextConfig } from "next";

// Pin the workspace root to this directory: the app is also built from
// standalone copies of itself, where no parent lockfile should be inferred.
const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
