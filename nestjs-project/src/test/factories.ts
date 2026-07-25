import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';

/**
 * Typed entity builders for unit tests.
 *
 * Replaces the `{ id: 'u1' } as any` fixtures that made mock return values
 * untyped — a stale fixture used to pass silently, and now fails `tsc --noEmit`
 * when the entity changes. Required by `.claude/rules/nestjs-testing.md`
 * ("use factories or builders to create test data objects").
 *
 * Values are deterministic: no randomness, so assertions stay reproducible.
 * Integration and e2e tests should persist real rows instead of using these.
 */

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

export function buildUser(overrides: Partial<User> = {}): User {
  const user = new User();
  Object.assign(user, {
    id: 'user-1',
    email: 'test@example.com',
    password: 'hashed-password',
    is_confirmed: true,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    ...overrides,
  });
  return user;
}

export function buildChannel(overrides: Partial<Channel> = {}): Channel {
  const channel = new Channel();
  Object.assign(channel, {
    id: 'channel-1',
    name: 'test',
    nickname: 'test',
    description: null,
    user_id: 'user-1',
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    ...overrides,
  });
  return channel;
}

export function buildVerificationToken(
  overrides: Partial<VerificationToken> = {},
): VerificationToken {
  const token = new VerificationToken();
  Object.assign(token, {
    id: 'verification-token-1',
    token_hash: 'hashed-token',
    type: VerificationTokenType.EMAIL_CONFIRMATION,
    user_id: 'user-1',
    expires_at: new Date(FIXED_DATE.getTime() + 60 * 60 * 1000),
    used_at: null,
    created_at: FIXED_DATE,
    ...overrides,
  });
  return token;
}

export function buildRefreshToken(
  overrides: Partial<RefreshToken> = {},
): RefreshToken {
  const token = new RefreshToken();
  Object.assign(token, {
    id: 'refresh-token-1',
    token_hash: 'hashed-token',
    family: 'family-1',
    user_id: 'user-1',
    expires_at: new Date(FIXED_DATE.getTime() + 7 * 24 * 60 * 60 * 1000),
    revoked_at: null,
    created_at: FIXED_DATE,
    ...overrides,
  });
  return token;
}
