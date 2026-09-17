import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The migrations are applied from inside the deployment (Admin → Database),
  // so the files have to be inside it. File tracing only follows imports; a
  // directory opened with readdirSync at runtime has to be named here.
  outputFileTracingIncludes: {
    '/api/admin/migrations': ['./db/migrations/**/*.sql'],
    '/admin/database': ['./db/migrations/**/*.sql'],
  },
};

export default nextConfig;
