import {
  AuthJsProvider,
  EmailInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
  type AuthJsCreateUserInput,
  type AuthJsUserRecord,
  type AuthJsUserStore,
} from '@spark/auth'

const SECRET = 'test-secret-at-least-16-chars-long'

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
}

// Trivial scrypt cost: this suite exercises token and revocation behaviour, and the real
// N=2^17 parameters would add minutes of key derivation to it.
const TEST_PASSWORD_PARAMS = { N: 16, r: 8, p: 1 }

function makeProvider(overrides: { accessTtlSeconds?: number } = {}) {
  const store = new InMemoryStore()
  const provider = new AuthJsProvider({
    secret: SECRET,
    store,
    passwordParams: TEST_PASSWORD_PARAMS,
    ...overrides,
  })
  return { store, provider }
}

describe('AuthJsProvider', () => {
  it('rejects a too-short secret', () => {
    expect(() => new AuthJsProvider({ secret: 'short', store: new InMemoryStore() })).toThrow()
  })

  it('signs up then signs in and verifies the access token', async () => {
    const { provider } = makeProvider()
    const signUp = await provider.signUp({
      email: 'A@Spark.gr',
      password: 'pw-123456',
      role: 'operator_admin',
    })
    expect(signUp.session.user.email).toBe('a@spark.gr')
    expect(signUp.session.user.role).toBe('operator_admin')

    const signIn = await provider.signIn({ email: 'a@spark.gr', password: 'pw-123456' })
    const verified = await provider.verifyToken(signIn.session.accessToken)
    expect(verified).not.toBeNull()
    expect(verified?.isExpired).toBe(false)
    expect(verified?.user.role).toBe('operator_admin')
  })

  it('rejects a wrong password', async () => {
    const { provider } = makeProvider()
    await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    await expect(
      provider.signIn({ email: 'a@spark.gr', password: 'wrong-pass' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError)
  })

  it('rejects duplicate sign-up', async () => {
    const { provider } = makeProvider()
    await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    await expect(
      provider.signUp({ email: 'A@spark.gr', password: 'pw-123456' }),
    ).rejects.toBeInstanceOf(EmailInUseError)
  })

  it('returns null for a tampered token', async () => {
    const { provider } = makeProvider()
    const { session } = await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    expect(await provider.verifyToken(session.accessToken + 'x')).toBeNull()
    expect(await provider.verifyToken('not.a.jwt')).toBeNull()
  })

  it('marks an expired access token as expired but still parses the user', async () => {
    const { provider } = makeProvider({ accessTtlSeconds: -1 })
    const { session } = await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })
    const verified = await provider.verifyToken(session.accessToken)
    expect(verified?.isExpired).toBe(true)
  })

  it('refreshes into a new session and rejects an access token used as refresh', async () => {
    const { provider } = makeProvider()
    const { session } = await provider.signUp({ email: 'a@spark.gr', password: 'pw-123456' })

    const refreshed = await provider.refreshToken(session.refreshToken)
    expect(refreshed.session.user.email).toBe('a@spark.gr')
    expect((await provider.verifyToken(refreshed.session.accessToken))?.isExpired).toBe(false)

    await expect(provider.refreshToken(session.accessToken)).rejects.toBeInstanceOf(
      InvalidTokenError,
    )
  })

  describe('session revocation', () => {
    const SIGN_UP = { email: 'a@spark.gr', password: 'pw-123456' }

    afterEach(() => {
      jest.useRealTimers()
    })

    it('signOut stamps the watermark on the user record', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-30T12:00:00.000Z'))
      const { store, provider } = makeProvider()
      const { session } = await provider.signUp(SIGN_UP)
      expect((await store.findById('u1'))?.sessionsValidFrom).toBeUndefined()

      jest.setSystemTime(new Date('2026-07-30T12:05:00.000Z'))
      await provider.signOut(session.accessToken)

      expect((await store.findById('u1'))?.sessionsValidFrom).toEqual(
        new Date('2026-07-30T12:05:00.000Z'),
      )
    })

    it('refuses a refresh token issued before the watermark', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-30T12:00:00.000Z'))
      const { provider } = makeProvider()
      const { session } = await provider.signUp(SIGN_UP)

      jest.setSystemTime(new Date('2026-07-30T12:05:00.000Z'))
      await provider.signOut(session.accessToken)

      await expect(provider.refreshToken(session.refreshToken)).rejects.toBeInstanceOf(
        InvalidTokenError,
      )
    })

    it('refuses a refresh token minted in the same second as the revocation', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-30T12:00:00.100Z'))
      const { provider } = makeProvider()
      const { session } = await provider.signUp(SIGN_UP)

      jest.setSystemTime(new Date('2026-07-30T12:00:00.900Z'))
      await provider.signOut(session.accessToken)

      await expect(provider.refreshToken(session.refreshToken)).rejects.toBeInstanceOf(
        InvalidTokenError,
      )
    })

    it('honours a refresh token issued after the revocation', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-30T12:00:00.000Z'))
      const { provider } = makeProvider()
      const first = await provider.signUp(SIGN_UP)

      jest.setSystemTime(new Date('2026-07-30T12:05:00.000Z'))
      await provider.signOut(first.session.accessToken)

      jest.setSystemTime(new Date('2026-07-30T12:05:01.000Z'))
      const second = await provider.signIn(SIGN_UP)
      await expect(provider.refreshToken(second.session.refreshToken)).resolves.toMatchObject({
        session: { user: { email: 'a@spark.gr' } },
      })
      await expect(provider.refreshToken(first.session.refreshToken)).rejects.toBeInstanceOf(
        InvalidTokenError,
      )
    })

    it('still revokes when the access token presented at sign-out has already expired', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-30T12:00:00.000Z'))
      const { store, provider } = makeProvider({ accessTtlSeconds: 1 })
      const { session } = await provider.signUp(SIGN_UP)

      jest.setSystemTime(new Date('2026-07-30T12:30:00.000Z'))
      await provider.signOut(session.accessToken)

      expect((await store.findById('u1'))?.sessionsValidFrom).toEqual(
        new Date('2026-07-30T12:30:00.000Z'),
      )
      await expect(provider.refreshToken(session.refreshToken)).rejects.toBeInstanceOf(
        InvalidTokenError,
      )
    })

    it('ignores a sign-out presenting a token it did not sign', async () => {
      const { store, provider } = makeProvider()
      await provider.signUp(SIGN_UP)
      await expect(provider.signOut('not.a.jwt')).resolves.toBeUndefined()
      expect((await store.findById('u1'))?.sessionsValidFrom).toBeUndefined()
    })
  })

  describe('resetPassword', () => {
    const SIGN_UP = { email: 'a@spark.gr', password: 'pw-123456' }

    afterEach(() => {
      jest.useRealTimers()
    })

    it('replaces the credential: the new password signs in, the old one no longer does', async () => {
      const { store, provider } = makeProvider()
      await provider.signUp(SIGN_UP)
      const oldHash = (await store.findById('u1'))?.passwordHash

      await provider.resetPassword({ email: 'A@Spark.gr' }, 'fresh-pw-99')

      const newHash = (await store.findById('u1'))?.passwordHash
      expect(newHash).not.toBe(oldHash)
      // Salted scrypt, so the stored value is never the plaintext.
      expect(newHash).not.toContain('fresh-pw-99')
      await expect(
        provider.signIn({ email: 'a@spark.gr', password: 'fresh-pw-99' }),
      ).resolves.toMatchObject({ session: { user: { email: 'a@spark.gr' } } })
      await expect(provider.signIn(SIGN_UP)).rejects.toBeInstanceOf(InvalidCredentialsError)
    })

    // A reset that leaves the attacker's 30-day refresh token working is not a reset.
    it('kills sessions issued before the reset', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-30T12:00:00.000Z'))
      const { store, provider } = makeProvider()
      const stolen = await provider.signUp(SIGN_UP)

      jest.setSystemTime(new Date('2026-07-30T12:05:00.000Z'))
      await provider.resetPassword({ email: 'a@spark.gr' }, 'fresh-pw-99')

      expect((await store.findById('u1'))?.sessionsValidFrom).toEqual(
        new Date('2026-07-30T12:05:00.000Z'),
      )
      await expect(provider.refreshToken(stolen.session.refreshToken)).rejects.toBeInstanceOf(
        InvalidTokenError,
      )

      jest.setSystemTime(new Date('2026-07-30T12:05:01.000Z'))
      const fresh = await provider.signIn({ email: 'a@spark.gr', password: 'fresh-pw-99' })
      await expect(provider.refreshToken(fresh.session.refreshToken)).resolves.toMatchObject({
        session: { user: { email: 'a@spark.gr' } },
      })
    })

    it('refuses an unknown email rather than silently succeeding', async () => {
      const { provider } = makeProvider()
      await expect(
        provider.resetPassword({ email: 'nobody@spark.gr' }, 'fresh-pw-99'),
      ).rejects.toBeInstanceOf(InvalidTokenError)
    })
  })
})
