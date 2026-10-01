/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    config.resolve.alias.encoding = false;
    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist', '@prisma/client', 'prisma', 'pdf-lib', 'mammoth'],
    outputFileTracingIncludes: {
      '/api/**/*': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.js'],
    },
  },
};

export default nextConfig;
