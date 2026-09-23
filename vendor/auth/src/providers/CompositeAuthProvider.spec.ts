import type { AuthResult, AuthUser, TokenVerificationResult } from '@spark/types'
import type { IAuthProvider } from '../IAuthProvider'
import { CompositeAuthProvider } from './CompositeAuthProvider'

function fakeProvider(name: string): jest.Mocked<IAuthProvider> {
  const result: AuthResult = {
    session: {
      accessToken: `${name}-access`,
      refreshToken: `${name}-refresh`,
      expiresAt: 0,
      user: {
        id: `${name}-id`,
        email: 'x@spark.gr',
        role: 'user',
        emailVerified: true,
      } as AuthUser,
    },
  }
  const verification: TokenVerificationResult = {
    user: result.session.user,
    isExpired: false,
    issuedAt: 1_785_412_800,
  }
  return {
    providerName: name,
    signIn: jest.fn().mockResolvedValue(result),
    signUp: jest.fn().mockResolvedValue(result),
    signOut: jest.fn().mockResolvedValue(undefined),
    verifyToken: jest.fn().mockResolvedValue(verification),
    refreshToken: jest.fn().mockResolvedValue(result),
    resetPassword: jest.fn().mockResolvedValue(undefined),
    getUser: jest.fn().mockResolvedValue(result.session.user),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    findIdentityByEmail: jest.fn().mockResolvedValue(null),
    deleteIdentity: jest.fn().mockResolvedValue(undefined),
  }
}

function jwt(payload: object): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`
}

const FIREBASE_TOKEN = jwt({ iss: 'https://securetoken.google.com/spark-demo', sub: 'fb' })
const DEFAULT_TOKEN = jwt({ sub: 'authjs-user', typ: 'access' })

function make(resolve: 'firebase' | 'local' | null) {
  const def = fakeProvider('default')
  const firebase = fakeProvider('firebase')
  const resolveByEmail = jest.fn().mockResolvedValue(resolve)
  const provider = new CompositeAuthProvider({ default: def, firebase, local: def, resolveByEmail })
  return { def, firebase, resolveByEmail, provider }
}

describe('CompositeAuthProvider', () => {
  describe('email routing', () => {
    it('routes signIn/signUp to firebase when resolveByEmail returns firebase', async () => {
      const { def, firebase, resolveByEmail, provider } = make('firebase')
      await provider.signIn({ email: 'Owner@Spark.gr', password: 'pw' })
      await provider.signUp({ email: 'Owner@Spark.gr', password: 'pw' })
      expect(resolveByEmail).toHaveBeenCalledWith('owner@spark.gr')
      expect(firebase.signIn).toHaveBeenCalledTimes(1)
      expect(firebase.signUp).toHaveBeenCalledTimes(1)
      expect(def.signIn).not.toHaveBeenCalled()
      expect(def.signUp).not.toHaveBeenCalled()
    })

    it('routes signIn to default when resolveByEmail returns null', async () => {
      const { def, firebase, provider } = make(null)
      await provider.signIn({ email: 'user@spark.gr', password: 'pw' })
      expect(def.signIn).toHaveBeenCalledTimes(1)
      expect(firebase.signIn).not.toHaveBeenCalled()
    })

    // Mis-routing here would write the new password to a backend that does not own the
    // credential, leaving the real one untouched.
    it('routes resetPassword to the backend that owns the credential', async () => {
      const { def, firebase, resolveByEmail, provider } = make('firebase')
      await provider.resetPassword({ email: 'Owner@Spark.gr' }, 'new-password')
      expect(resolveByEmail).toHaveBeenCalledWith('owner@spark.gr')
      expect(firebase.resetPassword).toHaveBeenCalledWith(
        { email: 'Owner@Spark.gr' },
        'new-password',
      )
      expect(def.resetPassword).not.toHaveBeenCalled()
    })

    it('routes resetPassword to the default backend for a non-firebase email', async () => {
      const { def, firebase, provider } = make(null)
      await provider.resetPassword({ email: 'user@spark.gr' }, 'new-password')
      expect(def.resetPassword).toHaveBeenCalledTimes(1)
      expect(firebase.resetPassword).not.toHaveBeenCalled()
    })
  })

  describe('token routing', () => {
    it('routes a Firebase-issued token to the firebase provider', async () => {
      const { def, firebase, provider } = make(null)
      await provider.verifyToken(FIREBASE_TOKEN)
      await provider.signOut(FIREBASE_TOKEN)
      await provider.refreshToken(FIREBASE_TOKEN)
      expect(firebase.verifyToken).toHaveBeenCalledWith(FIREBASE_TOKEN)
      expect(firebase.signOut).toHaveBeenCalledWith(FIREBASE_TOKEN)
      expect(firebase.refreshToken).toHaveBeenCalledWith(FIREBASE_TOKEN)
      expect(def.verifyToken).not.toHaveBeenCalled()
    })

    it('routes a token without a Firebase issuer to the default provider', async () => {
      const { def, firebase, provider } = make(null)
      await provider.verifyToken(DEFAULT_TOKEN)
      expect(def.verifyToken).toHaveBeenCalledWith(DEFAULT_TOKEN)
      expect(firebase.verifyToken).not.toHaveBeenCalled()
    })

    // Revocation lives in whichever provider owns the token, so a mis-routed sign-out
    // would silently leave the session alive.
    it('routes sign-out to the provider that issued the token', async () => {
      const { def, firebase, provider } = make(null)
      await provider.signOut(DEFAULT_TOKEN)
      expect(def.signOut).toHaveBeenCalledWith(DEFAULT_TOKEN)
      expect(firebase.signOut).not.toHaveBeenCalled()

      await provider.signOut(FIREBASE_TOKEN)
      expect(firebase.signOut).toHaveBeenCalledWith(FIREBASE_TOKEN)
      expect(def.signOut).toHaveBeenCalledTimes(1)
    })

    it('routes an unparseable token to the default provider', async () => {
      const { def, firebase, provider } = make(null)
      await provider.verifyToken('not-a-jwt')
      expect(def.verifyToken).toHaveBeenCalledWith('not-a-jwt')
      expect(firebase.verifyToken).not.toHaveBeenCalled()
    })
  })

  /**
   * Refresh tokens route on their own rule, because only ACCESS tokens are JWTs. Firebase
   * issues an opaque string for refresh, which the issuer peek cannot read — sending it to
   * the default provider left every Firebase-backed account unable to renew a session once
   * its access token lapsed.
   */
  describe('refresh-token routing', () => {
    // A real one, from a live sign-in: no dots, nothing to decode.
    const FIREBASE_REFRESH = 'AMf-vBwuWwYV9s7Qk3nJhTt2pLxR0aZbGcDeFgHiJkLmNoPqRsTuVwXyZ'

    it('routes an opaque refresh token to firebase, not the default provider', async () => {
      const { def, firebase, provider } = make(null)
      await provider.refreshToken(FIREBASE_REFRESH)
      expect(firebase.refreshToken).toHaveBeenCalledWith(FIREBASE_REFRESH)
      expect(def.refreshToken).not.toHaveBeenCalled()
    })

    it('still routes a JWT refresh token to the default provider', async () => {
      const { def, firebase, provider } = make(null)
      await provider.refreshToken(DEFAULT_TOKEN)
      expect(def.refreshToken).toHaveBeenCalledWith(DEFAULT_TOKEN)
      expect(firebase.refreshToken).not.toHaveBeenCalled()
    })

    // The shape rule is a fallback, not a replacement: a Firebase-issued JWT keeps routing
    // on its issuer.
    it('routes a Firebase-issued JWT refresh token to firebase', async () => {
      const { def, firebase, provider } = make(null)
      await provider.refreshToken(FIREBASE_TOKEN)
      expect(firebase.refreshToken).toHaveBeenCalledWith(FIREBASE_TOKEN)
      expect(def.refreshToken).not.toHaveBeenCalled()
    })

    // Access tokens are unaffected: an unparseable one is not a credential either provider
    // should be guessing about, and the previous behaviour is the safer default there.
    it('leaves access-token routing alone', async () => {
      const { def, firebase, provider } = make(null)
      await provider.verifyToken(FIREBASE_REFRESH)
      expect(def.verifyToken).toHaveBeenCalledWith(FIREBASE_REFRESH)
      expect(firebase.verifyToken).not.toHaveBeenCalled()
    })
  })

  describe('id-based routing', () => {
    it('reads users from the default provider and deletes via firebase', async () => {
      const { def, firebase, provider } = make(null)
      await provider.getUser('local-id')
      await provider.deleteUser('local-id')
      expect(def.getUser).toHaveBeenCalledWith('local-id')
      expect(firebase.deleteUser).toHaveBeenCalledWith('local-id')
      expect(firebase.getUser).not.toHaveBeenCalled()
      expect(def.deleteUser).not.toHaveBeenCalled()
    })
  })
  /**
   * A deployment that has configured no Firebase credentials has no second leg at all. Every
   * route must fall through to the default rather than calling into a provider that cannot
   * initialise — previously deleteUser was hardcoded to firebase and broke by construction,
   * not by data.
   */
  describe('with no firebase leg configured', () => {
    function soloDefault() {
      const def = fakeProvider('default')
      const resolveByEmail = jest.fn().mockResolvedValue(null)
      const provider = new CompositeAuthProvider({
        default: def,
        firebase: null,
        local: def,
        resolveByEmail,
      })
      return { def, resolveByEmail, provider }
    }

    it('sends every credential operation to the default provider', async () => {
      const { def, provider } = soloDefault()

      await provider.signIn({ email: 'a@b.gr', password: 'pw' })
      await provider.signUp({ email: 'a@b.gr', password: 'pw' })
      await provider.resetPassword({ email: 'a@b.gr' }, 'pw')

      expect(def.signIn).toHaveBeenCalled()
      expect(def.signUp).toHaveBeenCalled()
      expect(def.resetPassword).toHaveBeenCalled()
    })

    // The lookup still happens — it is what identifies the credential's owner — but with
    // only one leg configured every answer resolves to the same provider.
    it('resolves every owner to the single configured provider', async () => {
      const { def, provider } = soloDefault()

      await provider.signIn({ email: 'a@b.gr', password: 'pw' })
      await provider.verifyToken('AMf-vBopaque')

      expect(def.signIn).toHaveBeenCalled()
      expect(def.verifyToken).toHaveBeenCalled()
    })

    it('deletes through the default rather than a provider that is not there', async () => {
      const { def, provider } = soloDefault()

      await provider.deleteUser('u1')
      await provider.deleteIdentity('id1')
      const identity = await provider.findIdentityByEmail('a@b.gr')

      expect(def.deleteUser).toHaveBeenCalledWith('u1')
      expect(def.deleteIdentity).toHaveBeenCalledWith('id1')
      expect(identity).toBeNull()
    })

    it('routes an opaque refresh token to the default instead of guessing firebase', async () => {
      const { def, provider } = soloDefault()

      await provider.refreshToken('AMf-vBopaque')

      expect(def.refreshToken).toHaveBeenCalledWith('AMf-vBopaque')
    })
  })

  /**
   * The mirror deployment: AUTH_PROVIDER=firebase, so NEW accounts are Firebase's — but the
   * seeded, bootstrapped and previously-authjs accounts still hold local password hashes.
   * Routing used to be "firebase, or else the default", which sent those to Firebase and
   * locked out every existing user the moment the strategy was switched.
   */
  describe('with firebase as the default and local accounts still present', () => {
    function firebaseDefault(resolve: 'firebase' | 'local' | null) {
      const firebase = fakeProvider('firebase')
      const local = fakeProvider('local')
      const resolveByEmail = jest.fn().mockResolvedValue(resolve)
      const provider = new CompositeAuthProvider({
        default: firebase,
        firebase,
        local,
        resolveByEmail,
      })
      return { firebase, local, provider }
    }

    it('signs a local-credential account in through the local provider', async () => {
      const { firebase, local, provider } = firebaseDefault('local')

      await provider.signIn({ email: 'seeded@spark.gr', password: 'pw' })

      expect(local.signIn).toHaveBeenCalled()
      expect(firebase.signIn).not.toHaveBeenCalled()
    })

    it('creates a new account through the default, which is firebase', async () => {
      const { firebase, local, provider } = firebaseDefault(null)

      await provider.signUp({ email: 'new@spark.gr', password: 'pw' })

      expect(firebase.signUp).toHaveBeenCalled()
      expect(local.signUp).not.toHaveBeenCalled()
    })

    it('verifies a local JWT through the local provider, not the firebase default', async () => {
      const { firebase, local, provider } = firebaseDefault('local')

      await provider.verifyToken(jwt({ iss: 'spark' }))

      expect(local.verifyToken).toHaveBeenCalled()
      expect(firebase.verifyToken).not.toHaveBeenCalled()
    })

    it('resets a local account password against the local provider', async () => {
      const { firebase, local, provider } = firebaseDefault('local')

      await provider.resetPassword({ email: 'seeded@spark.gr' }, 'pw')

      expect(local.resetPassword).toHaveBeenCalled()
      expect(firebase.resetPassword).not.toHaveBeenCalled()
    })
  })
})
