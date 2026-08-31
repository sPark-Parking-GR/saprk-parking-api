import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  AuthContext,
  AuthJsProvider,
  CompositeAuthProvider,
  FirebaseAuthProvider,
  createAuthProvider,
} from '@spark/auth'
import type { AuthProviderConfig } from '@spark/auth'
import { OperatorStatusService } from '../common/authz/operator-status.service'
import { NotificationsModule } from '../notifications/notifications.module'
import { PrismaService } from '../prisma/prisma.service'
import { AccountDeletionService } from './account-deletion.service'
import { AccountLinkingService } from './account-linking.service'
import { AUTH_CONTEXT_TOKEN, FIREBASE_AUTH_PROVIDER_TOKEN } from './auth.constants'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { PrismaAuthJsUserStore } from './authjs-user.store'
import { PasswordResetService } from './password-reset.service'
import { SessionRevocationService } from './session-revocation.service'

// The concrete strategy the global AUTH_PROVIDER env var resolves to; it becomes the
// composite router's `default` provider (Firebase handles per-user routed accounts).
type DefaultAuthProviderConfig = Exclude<AuthProviderConfig, { provider: 'composite' }>

/**
 * The Firebase leg, or null when the deployment has not configured one.
 *
 * Null rather than throwing: Firebase is now one selectable strategy among several rather
 * than a hard requirement of the invite flow, so an authjs-only deployment must be able to
 * boot without Google credentials. Accounts that already carry a firebaseUid still need it,
 * which is why presence is decided by the credentials being there rather than by
 * AUTH_PROVIDER alone — a database holding both kinds keeps working while AUTH_PROVIDER
 * decides only where NEW accounts are created.
 */
function firebaseProvider(
  config: ConfigService,
  store: PrismaAuthJsUserStore,
): FirebaseAuthProvider | null {
  const projectId = config.get<string>('FIREBASE_PROJECT_ID')
  const clientEmail = config.get<string>('FIREBASE_CLIENT_EMAIL')
  const privateKey = config.get<string>('FIREBASE_PRIVATE_KEY')
  const apiKey = config.get<string>('FIREBASE_API_KEY')
  if (!projectId || !clientEmail || !privateKey || !apiKey) return null

  return new FirebaseAuthProvider({ projectId, clientEmail, privateKey, apiKey, store })
}

/**
 * The local-credential leg, present whenever there is a secret to verify a password hash
 * with — regardless of which strategy AUTH_PROVIDER selected.
 *
 * Under AUTH_PROVIDER=authjs this is the same provider as the default, and costs nothing.
 * Under AUTH_PROVIDER=firebase it is the only thing that can authenticate the seeded and
 * bootstrapped accounts, which hold scrypt hashes and no Google identity.
 */
function localProvider(config: ConfigService, store: PrismaAuthJsUserStore): AuthJsProvider | null {
  const secret = config.get<string>('AUTH_SECRET')
  if (!secret) return null
  return new AuthJsProvider({ secret, store })
}

function resolveDefaultConfig(
  config: ConfigService,
  store: PrismaAuthJsUserStore,
): DefaultAuthProviderConfig {
  const provider = (config.get<string>('AUTH_PROVIDER') ??
    'authjs') as DefaultAuthProviderConfig['provider']

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
  imports: [NotificationsModule],
  controllers: [AuthController],
  providers: [
    {
      /**
       * The app-wide auth context. AUTH_PROVIDER decides where NEW accounts are created;
       * EXISTING ones are routed to whichever backend actually holds their credential, so
       * the strategy can be switched in either direction without stranding anybody.
       */
      provide: AUTH_CONTEXT_TOKEN,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) => {
        const store = new PrismaAuthJsUserStore(prisma)
        const composite = new CompositeAuthProvider({
          default: createAuthProvider(resolveDefaultConfig(config, store)),
          firebase: firebaseProvider(config, store),
          local: localProvider(config, store),
          // The row itself says who owns the credential: a firebaseUid means Google holds
          // it, a non-empty passwordHash means we do. FirebaseAuthProvider writes '' as its
          // "no local password" sentinel, so the two are mutually exclusive in practice.
          resolveByEmail: async (email) => {
            const record = await store.findByEmail(email)
            if (!record) return null
            if (record.firebaseUid) return 'firebase'
            return record.passwordHash ? 'local' : null
          },
        })
        return new AuthContext(composite)
      },
    },
    {
      // Kept for the paths that genuinely need the Google-side identity by uid — account
      // deletion, the lifecycle purge and the reconcile CLI — and null when Firebase is not
      // configured, which those paths already handle. Provisioning no longer uses it: an
      // invite now creates its identity through AUTH_CONTEXT_TOKEN, so AUTH_PROVIDER
      // actually decides, per the strategy rule in CLAUDE.md. A second construction is
      // harmless: FirebaseAuthProvider's admin.apps.length guard prevents double-
      // initializing the underlying Firebase Admin SDK app.
      provide: FIREBASE_AUTH_PROVIDER_TOKEN,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        firebaseProvider(config, new PrismaAuthJsUserStore(prisma)),
    },
    AuthService,
    PasswordResetService,
    AccountDeletionService,
    OperatorStatusService,
    SessionRevocationService,
    AccountLinkingService,
  ],
  // OperatorStatusService and SessionRevocationService are exported because the
  // globally-registered AuthGuard resolves its dependencies from the root module context.
  exports: [
    AuthService,
    OperatorStatusService,
    SessionRevocationService,
    AccountLinkingService,
    FIREBASE_AUTH_PROVIDER_TOKEN,
    // Provisioning services (invite accept, admin-invite accept, operator self-registration)
    // create identities through the CONFIGURED provider now, so they need the composite
    // context rather than the raw Firebase strategy.
    AUTH_CONTEXT_TOKEN,
  ],
})
export class AuthModule {}
