import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function getDatabaseUrl(): string {
  let url = process.env.DATABASE_URL || '';
  if (!url) return url;

  // If using Neon pooled connection, ensure connect and pool timeouts are set
  if (url.includes('neon.tech') && !url.includes('connect_timeout')) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}connect_timeout=30&pool_timeout=30`;
  }
  return url;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: {
        url: getDatabaseUrl(),
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
