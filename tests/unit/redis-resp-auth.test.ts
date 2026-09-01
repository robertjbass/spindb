import { describe, it } from 'node:test'
import { buildRespAuthArgs } from '../../engines/redis/resp-client'
import { assertDeepEqual } from '../utils/assertions'

describe('RESP AUTH args', () => {
  it('sends a one-argument AUTH for Heroku legacy dummy usernames', () => {
    assertDeepEqual(
      buildRespAuthArgs('s3cret', 'h'),
      ['AUTH', 's3cret'],
      'Heroku classic URLs carry a placeholder "h" username that is not an ACL user',
    )
  })

  it('sends a one-argument AUTH for the implicit default user', () => {
    assertDeepEqual(
      buildRespAuthArgs('s3cret', 'default'),
      ['AUTH', 's3cret'],
      'requirepass-only servers reject an explicit default user',
    )
  })

  it('sends a one-argument AUTH when no username is present', () => {
    assertDeepEqual(
      buildRespAuthArgs('s3cret'),
      ['AUTH', 's3cret'],
      'a missing username should not be invented',
    )
    assertDeepEqual(
      buildRespAuthArgs('s3cret', ''),
      ['AUTH', 's3cret'],
      'an empty username should not be invented',
    )
  })

  it('sends a two-argument AUTH for real ACL users', () => {
    assertDeepEqual(
      buildRespAuthArgs('s3cret', 'appuser'),
      ['AUTH', 'appuser', 's3cret'],
      'explicit ACL users must still be authenticated by name',
    )
  })

  it('keeps usernames that merely start with h', () => {
    assertDeepEqual(
      buildRespAuthArgs('s3cret', 'hasura'),
      ['AUTH', 'hasura', 's3cret'],
      'only a lone "h" is the Heroku placeholder',
    )
  })
})
