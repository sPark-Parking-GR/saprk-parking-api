import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AuthContext, CompositeAuthProvider, FirebaseAuthProvider, createAuthProvider } from '@spark/auth'
import type { AuthProviderConfig } from '@spark/auth'
import { OperatorStatusService } from '../common/authz/operator-status.service'
import { PrismaService } from '../prisma/prisma.service'
import { AUTH_CONTEXT_TOKEN, FIREBASE_AUTH_PROVIDER_TOKEN } from './auth.constants'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { PrismaAuthJsUserStore } from './authjs-user.store'

// The concrete strategy the global AUTH_PROVIDER env var resolves to; it becomes the
// composite router's `default` provider (Firebase handles per-user routed accounts).
type DefaultAuthProviderConfig = Exclude<AuthProviderConfig, { provider: 'composite' }>

function firebaseProvider(config: ConfigService, store: PrismaAuthJsUserStore): FirebaseAuthProvider {
  return new FirebaseAuthProvider({
    projectId: config.getOrThrow('FIREBASE_PROJECT_ID'),
    clientEmail: config.getOrThrow('FIREBASE_CLIENT_EMAIL'),
    privateKey: config.getOrThrow('FIREBASE_PRIVATE_KEY'),
    apiKey: config.getOrThrow('FIREBASE_API_KEY'),
    store,
  })
}

function resolveDefaultConfig(
  config: ConfigService,
  store: PrismaAuthJsUserStore,
): DefaultAuthProviderConfig {
  const provider = (config.get<string>('AUTH_PROVIDER') ?? 'authjs') as DefaultAuthProviderConfig['provider']

  switch (provider) {
    case 'authjs':
      return {
        provider: 'authjs',
        config: {
          secret: config.getOrThrow('AUTH_SECRET'),
          store,
        },
      }
    case 'firebase':
      return {
        provider: 'firebase',
        config: {
          projectId: config.getOrThrow('FIREBASE_PROJECT_ID'),
          clientEmail: config.getOrThrow('FIREBASE_CLIENT_EMAIL'),
          privateKey: config.getOrThrow('FIREBASE_PRIVATE_KEY'),
          apiKey: config.getOrThrow('FIREBASE_API_KEY'),
          store,
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
      // The app-wide auth context routes per user: Firebase for accounts with a
      // firebaseUid, the configured default (authjs by default) for everyone else.
      provide: AUTH_CONTEXT_TOKEN,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) => {
        const store = new PrismaAuthJsUserStore(prisma)
        const composite = new CompositeAuthProvider({
          default: createAuthProvider(resolveDefaultConfig(config, store)),
          firebase: firebaseProvider(config, store),
          resolveByEmail: async (email) => {
            const record = await store.findByEmail(email)
            return record?.firebaseUid ? 'firebase' : null
          },
        })
        return new AuthContext(composite)
      },
    },
    {
      // The raw Firebase strategy, for the invite module's operator provisioning. A
      // second construction is harmless: FirebaseAuthProvider's admin.apps.length guard
      // prevents double-initializing the underlying Firebase Admin SDK app.
      provide: FIREBASE_AUTH_PROVIDER_TOKEN,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        firebaseProvider(config, new PrismaAuthJsUserStore(prisma)),
    },
    AuthService,
    OperatorStatusService,
  ],
  // OperatorStatusService is exported because the globally-registered AuthGuard resolves
  // its dependencies from the root module context.
  exports: [AuthService, OperatorStatusService, FIREBASE_AUTH_PROVIDER_TOKEN],
})
export class AuthModule {}
