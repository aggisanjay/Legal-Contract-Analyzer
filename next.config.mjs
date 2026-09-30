/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    config.resolve.alias.encoding = false;
    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist', '@prisma/client', 'prisma', 'pdf-lib', 'mammoth'],
  },
};

export default nextConfig;
