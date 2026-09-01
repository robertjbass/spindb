import { describe, it } from 'node:test'
import { shouldPassRedisCliUsername } from '../../engines/redis/index'
import { shouldPassRedisCliUsername as sharedHelper } from '../../engines/redis/cli-common'
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

  it('omits the Heroku legacy placeholder username', () => {
    assertEqual(
      shouldPassRedisCliUsername('h'),
      false,
      'Heroku classic URLs carry a placeholder "h" username that is not an ACL user',
    )
  })

  it('passes explicit ACL users', () => {
    assertEqual(
      shouldPassRedisCliUsername('appuser'),
      true,
      'non-default ACL users should be passed to redis-cli',
    )
  })

  it('keeps usernames that merely start with h', () => {
    assertEqual(
      shouldPassRedisCliUsername('hasura'),
      true,
      'only a lone "h" is the Heroku placeholder',
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

  it('exposes one implementation to every redis-cli call site', () => {
    assertEqual(
      shouldPassRedisCliUsername === sharedHelper,
      true,
      'engines/redis/index re-exports the cli-common helper rather than copying it',
    )
  })
})
