import { describe, it } from 'node:test'
import { shouldPassRedisCliUsername } from '../../engines/redis/index'
import { assertEqual } from '../utils/assertions'

describe('Redis CLI auth', () => {
  it('omits the implicit default user', () => {
    assertEqual(
      shouldPassRedisCliUsername('default'),
      false,
      'default user should not be passed to redis-cli',
    )
    assertEqual(
      shouldPassRedisCliUsername(' DEFAULT '),
      false,
      'default user should be matched case-insensitively',
    )
  })

  it('passes explicit ACL users', () => {
    assertEqual(
      shouldPassRedisCliUsername('appuser'),
      true,
      'non-default ACL users should be passed to redis-cli',
    )
  })

  it('omits empty usernames', () => {
    assertEqual(
      shouldPassRedisCliUsername(undefined),
      false,
      'missing username should not be passed to redis-cli',
    )
    assertEqual(
      shouldPassRedisCliUsername(''),
      false,
      'empty username should not be passed to redis-cli',
    )
  })
})
