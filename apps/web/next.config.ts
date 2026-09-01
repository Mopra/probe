import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // postgres.js must not be bundled: it is a server-only driver (§4).
  serverExternalPackages: ['postgres'],
  // probe.toml lives at the repo root and is read by @probe/config at runtime,
  // so it has to be traced into the serverless bundle.
  outputFileTracingRoot: path.join(process.cwd(), '..', '..'),
  outputFileTracingIncludes: {
    '/**': ['../../probe.toml'],
  },
};

export default nextConfig;
