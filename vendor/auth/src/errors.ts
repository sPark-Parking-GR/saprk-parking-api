export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('Invalid email or password')
  }
}

export class EmailInUseError extends AuthError {
  constructor() {
    super('Email already in use')
  }
}

/**
 * The provider refused the password itself — Firebase applies its own six-character floor
 * underneath ours, and would previously rethrow that raw, so a rejected password surfaced
 * as a 500 rather than as the validation failure it is.
 */
export class WeakPasswordError extends AuthError {
  constructor() {
    super('Password is too weak')
  }
}

export class InvalidTokenError extends AuthError {
  constructor() {
    super('Invalid or expired token')
  }
}
