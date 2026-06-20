import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createAuthContext } from '@spark/auth'
import type { AuthProviderConfig } from '@spark/auth'
import { PrismaService } from '../prisma/prisma.service'
import { AUTH_CONTEXT_TOKEN } from './auth.constants'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { PrismaAuthJsUserStore } from './authjs-user.store'

function resolveAuthConfig(config: ConfigService, prisma: PrismaService): AuthProviderConfig {
  const provider = (config.get<string>('AUTH_PROVIDER') ?? 'authjs') as AuthProviderConfig['provider']

  switch (provider) {
    case 'authjs':
      return {
        provider: 'authjs',
        config: {
          secret: config.getOrThrow('AUTH_SECRET'),
          store: new PrismaAuthJsUserStore(prisma),
        },
      }
    case 'firebase':
      return {
        provider: 'firebase',
        config: {
          projectId: config.getOrThrow('FIREBASE_PROJECT_ID'),
          clientEmail: config.getOrThrow('FIREBASE_CLIENT_EMAIL'),
          privateKey: config.getOrThrow('FIREBASE_PRIVATE_KEY'),
        },
      }
    case 'clerk':
      return {
        provider: 'clerk',
        config: {
          secretKey: config.getOrThrow('CLERK_SECRET_KEY'),
          publishableKey: config.getOrThrow('CLERK_PUBLISHABLE_KEY'),
        },
      }
    case 'supabase':
      return {
        provider: 'supabase',
        config: {
          url: config.getOrThrow('SUPABASE_URL'),
          serviceRoleKey: config.getOrThrow('SUPABASE_SERVICE_ROLE_KEY'),
        },
      }
    default:
      throw new Error(`Unknown AUTH_PROVIDER: ${provider}`)
  }
}

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_CONTEXT_TOKEN,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        createAuthContext(resolveAuthConfig(config, prisma)),
    },
    AuthService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
