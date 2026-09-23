import type { AuthJsCreateUserInput, AuthJsUserRecord, AuthJsUserStore } from './AuthJsProvider'
import { FirebaseAuthProvider } from './FirebaseAuthProvider'
import {
  EmailInUseError,
  WeakPasswordError,
  InvalidCredentialsError,
  InvalidTokenError,
} from '../errors'

jest.mock('firebase-admin', () => {
  const auth = {
    createUser: jest.fn(),
    setCustomUserClaims: jest.fn(),
    deleteUser: jest.fn(),
    verifyIdToken: jest.fn(),
    revokeRefreshTokens: jest.fn(),
    updateUser: jest.fn(),
  }
  return {
    apps: [{}],
    app: jest.fn(() => ({})),
    initializeApp: jest.fn(() => ({})),
    credential: { cert: jest.fn(() => ({})) },
    auth: jest.fn(() => auth),
  }
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const admin = require('firebase-admin') as {
  auth: () => {
    createUser: jest.Mock
    setCustomUserClaims: jest.Mock
    deleteUser: jest.Mock
    verifyIdToken: jest.Mock
    revokeRefreshTokens: jest.Mock
    updateUser: jest.Mock
  }
}

const authMock = admin.auth()

class InMemoryStore implements AuthJsUserStore {
  private readonly byId = new Map<string, AuthJsUserRecord>()
  private seq = 0

  async findByEmail(email: string): Promise<AuthJsUserRecord | null> {
    return [...this.byId.values()].find((u) => u.email === email) ?? null
  }
  async findById(id: string): Promise<AuthJsUserRecord | null> {
    return this.byId.get(id) ?? null
  }
  async createUser(input: AuthJsCreateUserInput): Promise<AuthJsUserRecord> {
    const record: AuthJsUserRecord = {
      id: `u${++this.seq}`,
      email: input.email,
      role: input.role,
      emailVerified: false,
      displayName: input.displayName ?? null,
      avatarUrl: null,
      passwordHash: input.passwordHash,
      firebaseUid: input.firebaseUid ?? null,
    }
    this.byId.set(record.id, record)
    return record
  }
  async deleteUser(id: string): Promise<void> {
    this.byId.delete(id)
  }
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    const record = this.byId.get(id)
    if (record) record.passwordHash = passwordHash
  }

  async upgradePassword(id: string, expectedHash: string, passwordHash: string): Promise<void> {
    const record = this.byId.get(id)
    if (record?.passwordHash === expectedHash) record.passwordHash = passwordHash
  }
  async revokeSessions(id: string, at: Date): Promise<void> {
    const record = this.byId.get(id)
    if (record) record.sessionsValidFrom = at
  }
  seed(record: AuthJsUserRecord): void {
    this.byId.set(record.id, record)
  }
  has(id: string): boolean {
    return this.byId.has(id)
  }
  get(id: string): AuthJsUserRecord | undefined {
    return this.byId.get(id)
  }
}

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
const errJson = (status: number) =>
  Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve('{}'),
  } as Response)

function makeProvider() {
  const store = new InMemoryStore()
  const provider = new FirebaseAuthProvider({
    projectId: 'demo',
    clientEmail: 'svc@demo.iam.gserviceaccount.com',
    privateKey: 'key',
    apiKey: 'web-api-key',
    store,
  })
  return { store, provider }
}

let fetchMock: jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  fetchMock = jest.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe('FirebaseAuthProvider', () => {
  describe('signUp', () => {
    it('creates the Firebase user, local row, sets claims, and mints tokens with the local id', async () => {
      const { store, provider } = makeProvider()
      authMock.createUser.mockResolvedValue({ uid: 'fb-uid-1' })
      authMock.setCustomUserClaims.mockResolvedValue(undefined)
      fetchMock.mockReturnValue(
        okJson({ idToken: 'id-tok', refreshToken: 'ref-tok', expiresIn: '3600' }),
      )

      const result = await provider.signUp({
        email: 'Owner@Spark.gr',
        password: 'pw-123456',
        displayName: 'Owner',
        role: 'operator_admin',
      })

      expect(result.session.user.id).toBe('u1')
      expect(result.session.user.email).toBe('owner@spark.gr')
      expect(result.session.accessToken).toBe('id-tok')
      expect(result.session.refreshToken).toBe('ref-tok')

      expect(authMock.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'owner@spark.gr', emailVerified: false }),
      )
      expect(authMock.setCustomUserClaims).toHaveBeenCalledWith('fb-uid-1', {
        localUserId: 'u1',
        role: 'operator_admin',
      })
      const stored = await store.findById('u1')
      expect(stored?.firebaseUid).toBe('fb-uid-1')
    })

    it('maps a duplicate Firebase email to EmailInUseError', async () => {
      const { provider } = makeProvider()
      authMock.createUser.mockRejectedValue({ code: 'auth/email-already-exists' })
      await expect(
        provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' }),
      ).rejects.toBeInstanceOf(EmailInUseError)
    })

    /**
     * Firebase applies a six-character floor of its own, beneath the eight our schemas ask
     * for. Rethrowing it raw turned a rejected password into a 500 with a Google stack in
     * the log; as an AuthError it is the 400 it always was.
     */
    it.each(['auth/invalid-password', 'auth/weak-password'])(
      'maps %s to WeakPasswordError rather than rethrowing it raw',
      async (code) => {
        const { provider } = makeProvider()
        authMock.createUser.mockRejectedValue({ code })
        await expect(
          provider.signUp({ email: 'a@spark.gr', password: 'short' }),
        ).rejects.toBeInstanceOf(WeakPasswordError)
      },
    )

    it('still rethrows an error it does not recognise', async () => {
      const { provider } = makeProvider()
      const boom = { code: 'auth/internal-error' }
      authMock.createUser.mockRejectedValue(boom)
      await expect(provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })).rejects.toBe(
        boom,
      )
    })

    it('deletes the orphaned Firebase user when the local write fails', async () => {
      const { store, provider } = makeProvider()
      authMock.createUser.mockResolvedValue({ uid: 'fb-uid-2' })
      authMock.deleteUser.mockResolvedValue(undefined)
      const boom = new Error('db down')
      jest.spyOn(store, 'createUser').mockRejectedValueOnce(boom)

      await expect(provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })).rejects.toBe(
        boom,
      )
      expect(authMock.deleteUser).toHaveBeenCalledWith('fb-uid-2')
      expect(authMock.setCustomUserClaims).not.toHaveBeenCalled()
    })
  })

  describe('signIn', () => {
    it('returns a session built from the local record on a successful password grant', async () => {
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u9',
        email: 'a@spark.gr',
        role: 'operator_admin',
        emailVerified: true,
        displayName: 'A',
        avatarUrl: null,
        passwordHash: '',
        firebaseUid: 'fb-9',
      })
      fetchMock.mockReturnValue(
        okJson({ idToken: 'id-9', refreshToken: 'ref-9', expiresIn: '3600' }),
      )

      const result = await provider.signIn({ email: 'A@spark.gr', password: 'pw-123456' })
      expect(result.session.user.id).toBe('u9')
      expect(result.session.user.role).toBe('operator_admin')
      expect(result.session.accessToken).toBe('id-9')
    })

    it('throws InvalidCredentialsError when the email is unknown locally', async () => {
      const { provider } = makeProvider()
      await expect(
        provider.signIn({ email: 'missing@spark.gr', password: 'x' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('throws InvalidCredentialsError when the REST password grant fails', async () => {
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u1',
        email: 'a@spark.gr',
        role: 'user',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: '',
        firebaseUid: 'fb-1',
      })
      fetchMock.mockReturnValue(errJson(400))
      await expect(
        provider.signIn({ email: 'a@spark.gr', password: 'wrong' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError)
    })

    it('logs only the HTTP status on a failed REST sign-in, never the response body', async () => {
      const { store, provider } = makeProvider()
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      store.seed({
        id: 'u1',
        email: 'a@spark.gr',
        role: 'user',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: '',
        firebaseUid: 'fb-1',
      })
      fetchMock.mockReturnValue(
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({}),
          text: () =>
            Promise.resolve(
              JSON.stringify({
                error: { message: 'INVALID_LOGIN_CREDENTIALS' },
                email: 'a@spark.gr',
              }),
            ),
        } as Response),
      )

      await expect(
        provider.signIn({ email: 'a@spark.gr', password: 'wrong' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError)

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[FirebaseAuthProvider] Identity Toolkit sign-in failed (400)',
      )
      const loggedText = consoleErrorSpy.mock.calls.flat().join(' ')
      expect(loggedText).not.toContain('a@spark.gr')

      consoleErrorSpy.mockRestore()
    })
  })

  describe('verifyToken', () => {
    it('returns the fresh local user for a valid token', async () => {
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u5',
        email: 'a@spark.gr',
        role: 'operator_admin',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: '',
        firebaseUid: 'fb-5',
      })
      authMock.verifyIdToken.mockResolvedValue({
        uid: 'fb-5',
        localUserId: 'u5',
        role: 'operator_admin',
        iat: 1_785_412_800,
      })

      const verified = await provider.verifyToken('valid-token')
      expect(verified?.isExpired).toBe(false)
      expect(verified?.user.id).toBe('u5')
      expect(verified?.user.role).toBe('operator_admin')
      expect(verified?.issuedAt).toBe(1_785_412_800)
    })

    it('returns null for an expired or tampered token', async () => {
      const { provider } = makeProvider()
      authMock.verifyIdToken.mockRejectedValue(new Error('token expired'))
      expect(await provider.verifyToken('bad-token')).toBeNull()
    })

    it('returns null when the local user no longer exists', async () => {
      const { provider } = makeProvider()
      authMock.verifyIdToken.mockResolvedValue({ uid: 'fb-x', localUserId: 'gone' })
      expect(await provider.verifyToken('valid-but-stale')).toBeNull()
    })
  })

  describe('refreshToken', () => {
    it('exchanges the refresh token and re-verifies the new id token', async () => {
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u7',
        email: 'a@spark.gr',
        role: 'user',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: '',
        firebaseUid: 'fb-7',
      })
      fetchMock.mockReturnValue(
        okJson({
          id_token: 'new-id',
          refresh_token: 'new-ref',
          expires_in: '3600',
          user_id: 'fb-7',
        }),
      )
      authMock.verifyIdToken.mockResolvedValue({ uid: 'fb-7', localUserId: 'u7' })

      const result = await provider.refreshToken('old-ref')
      expect(result.session.accessToken).toBe('new-id')
      expect(result.session.refreshToken).toBe('new-ref')
      expect(result.session.user.id).toBe('u7')
    })

    it('throws InvalidTokenError when the exchange fails', async () => {
      const { provider } = makeProvider()
      fetchMock.mockReturnValue(errJson(400))
      await expect(provider.refreshToken('bad')).rejects.toBeInstanceOf(InvalidTokenError)
    })
  })

  describe('signOut', () => {
    it('revokes refresh tokens at Google and stamps the local watermark', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-30T12:00:00.000Z'))
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u3',
        email: 'a@spark.gr',
        role: 'operator_admin',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: '',
        firebaseUid: 'fb-3',
      })
      authMock.verifyIdToken.mockResolvedValue({ uid: 'fb-3', localUserId: 'u3' })
      authMock.revokeRefreshTokens.mockResolvedValue(undefined)

      await provider.signOut('a-token')

      expect(authMock.revokeRefreshTokens).toHaveBeenCalledWith('fb-3')
      expect((await store.findById('u3'))?.sessionsValidFrom).toEqual(
        new Date('2026-07-30T12:00:00.000Z'),
      )
      jest.useRealTimers()
    })

    it('is forgiving when the token cannot be verified', async () => {
      const { provider } = makeProvider()
      authMock.verifyIdToken.mockRejectedValue(new Error('invalid'))
      await expect(provider.signOut('bad')).resolves.toBeUndefined()
      expect(authMock.revokeRefreshTokens).not.toHaveBeenCalled()
    })

    it('surfaces a failed revocation instead of reporting a sign-out that did not happen', async () => {
      const { store, provider } = makeProvider()
      authMock.verifyIdToken.mockResolvedValue({ uid: 'fb-3', localUserId: 'u3' })
      authMock.revokeRefreshTokens.mockResolvedValue(undefined)
      const boom = new Error('db down')
      jest.spyOn(store, 'revokeSessions').mockRejectedValueOnce(boom)

      await expect(provider.signOut('a-token')).rejects.toBe(boom)
    })
  })

  describe('deleteUser', () => {
    it('deletes both the Firebase identity and the local row', async () => {
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u2',
        email: 'a@spark.gr',
        role: 'user',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: '',
        firebaseUid: 'fb-2',
      })
      authMock.deleteUser.mockResolvedValue(undefined)
      await provider.deleteUser('u2')
      expect(authMock.deleteUser).toHaveBeenCalledWith('fb-2')
      expect(store.has('u2')).toBe(false)
    })

    it('deletes only the local row when there is no firebaseUid', async () => {
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u4',
        email: 'legacy@spark.gr',
        role: 'user',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: 'scrypt$x$y',
        firebaseUid: null,
      })
      await provider.deleteUser('u4')
      expect(authMock.deleteUser).not.toHaveBeenCalled()
      expect(store.has('u4')).toBe(false)
    })
  })

  describe('resetPassword', () => {
    const seedFirebaseUser = (store: InMemoryStore) =>
      store.seed({
        id: 'u9',
        email: 'owner@spark.gr',
        role: 'operator_admin',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: '',
        firebaseUid: 'fb-9',
        sessionsValidFrom: null,
      })

    it('writes the password at Google and revokes on both sides', async () => {
      const { store, provider } = makeProvider()
      seedFirebaseUser(store)
      authMock.updateUser.mockResolvedValue(undefined)
      authMock.revokeRefreshTokens.mockResolvedValue(undefined)

      const before = Date.now()
      await provider.resetPassword({ email: 'Owner@Spark.gr' }, 'brand-new-pw')

      expect(authMock.updateUser).toHaveBeenCalledWith('fb-9', { password: 'brand-new-pw' })
      // Google stops minting fresh ID tokens; the local watermark rejects the ones already
      // issued, which stay cryptographically valid for up to an hour.
      expect(authMock.revokeRefreshTokens).toHaveBeenCalledWith('fb-9')
      const watermark = store.get('u9')?.sessionsValidFrom
      expect(watermark).toBeInstanceOf(Date)
      expect(watermark!.getTime()).toBeGreaterThanOrEqual(before)
    })

    it('never stores the new password locally for a Firebase-owned credential', async () => {
      const { store, provider } = makeProvider()
      seedFirebaseUser(store)
      authMock.updateUser.mockResolvedValue(undefined)

      await provider.resetPassword({ email: 'owner@spark.gr' }, 'brand-new-pw')

      expect(store.get('u9')?.passwordHash).toBe('')
    })

    it('refuses an account with no Firebase identity instead of silently doing nothing', async () => {
      const { store, provider } = makeProvider()
      store.seed({
        id: 'u10',
        email: 'local@spark.gr',
        role: 'user',
        emailVerified: true,
        avatarUrl: null,
        displayName: null,
        passwordHash: 'scrypt$x$y',
        firebaseUid: null,
      })

      await expect(
        provider.resetPassword({ email: 'local@spark.gr' }, 'brand-new-pw'),
      ).rejects.toBeInstanceOf(InvalidTokenError)
      expect(authMock.updateUser).not.toHaveBeenCalled()
    })

    it('refuses an unknown email', async () => {
      const { provider } = makeProvider()
      await expect(
        provider.resetPassword({ email: 'nobody@spark.gr' }, 'brand-new-pw'),
      ).rejects.toBeInstanceOf(InvalidTokenError)
      expect(authMock.updateUser).not.toHaveBeenCalled()
    })
  })
})
