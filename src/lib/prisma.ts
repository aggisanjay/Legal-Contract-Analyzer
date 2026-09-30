import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function getDatabaseUrl(): string {
  let url = process.env.DATABASE_URL || '';
  if (!url) return url;

  // Ensure SSL and connection timeout parameters for Neon PostgreSQL
  const params: string[] = [];
  if (!url.includes('connect_timeout')) params.push('connect_timeout=30');
  if (!url.includes('pool_timeout')) params.push('pool_timeout=30');
  if (!url.includes('sslmode')) params.push('sslmode=require');

  if (params.length > 0) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}${params.join('&')}`;
  }
  return url;
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: getDatabaseUrl(),
      },
    },
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
