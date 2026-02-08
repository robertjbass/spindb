import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { Engine } from '../../types'
import { paths } from '../../config/paths'
import {
  saveCredentials,
  loadCredentials,
  listCredentials,
  credentialsExist,
} from '../../core/credential-manager'
import type { UserCredentials } from '../../types'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'

// Use unique container names with a nonce to avoid collisions with real data
const TEST_NONCE = Date.now()
const TEST_CONTAINER = `_cred_test_${TEST_NONCE}`
const TEST_CONTAINER_MS = `_cred_test_ms_${TEST_NONCE}`

describe('Credential Manager', () => {
  beforeEach(() => {
    // Ensure container directories exist
    const pgDir = paths.getContainerPath(TEST_CONTAINER, {
      engine: Engine.PostgreSQL,
    })
    mkdirSync(pgDir, { recursive: true })

    const msDir = paths.getContainerPath(TEST_CONTAINER_MS, {
      engine: Engine.Meilisearch,
    })
    mkdirSync(msDir, { recursive: true })

    // Clean any existing credentials
    const pgCredDir = join(pgDir, 'credentials')
    if (existsSync(pgCredDir)) {
      rmSync(pgCredDir, { recursive: true, force: true })
    }
    const msCredDir = join(msDir, 'credentials')
    if (existsSync(msCredDir)) {
      rmSync(msCredDir, { recursive: true, force: true })
    }
  })

  afterEach(() => {
    // Clean up test containers
    const pgDir = paths.getContainerPath(TEST_CONTAINER, {
      engine: Engine.PostgreSQL,
    })
    if (existsSync(pgDir)) {
      rmSync(pgDir, { recursive: true, force: true })
    }

    const msDir = paths.getContainerPath(TEST_CONTAINER_MS, {
      engine: Engine.Meilisearch,
    })
    if (existsSync(msDir)) {
      rmSync(msDir, { recursive: true, force: true })
    }
  })

  describe('saveCredentials', () => {
    it('should save SQL credentials as .env file', async () => {
      const credentials: UserCredentials = {
        username: 'appuser',
        password: 'xA9bK2mQ7nR4wE1s',
        connectionString:
          'postgresql://appuser:xA9bK2mQ7nR4wE1s@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      const filePath = await saveCredentials(
        TEST_CONTAINER,
        Engine.PostgreSQL,
        credentials,
      )

      assert(existsSync(filePath), 'Credential file should exist')
      assert(
        filePath.endsWith('.env.appuser'),
        'File should be named .env.appuser',
      )

      const content = readFileSync(filePath, 'utf-8')
      assert(content.includes('DB_USER=appuser'), 'Should contain DB_USER')
      assert(
        content.includes('DB_PASSWORD=xA9bK2mQ7nR4wE1s'),
        'Should contain DB_PASSWORD',
      )
      assert(content.includes('DB_HOST=127.0.0.1'), 'Should contain DB_HOST')
      assert(content.includes('DB_PORT=5432'), 'Should contain DB_PORT')
      assert(content.includes('DB_NAME=mydb'), 'Should contain DB_NAME')
      assert(
        content.includes(
          'DB_URL=postgresql://appuser:xA9bK2mQ7nR4wE1s@127.0.0.1:5432/mydb',
        ),
        'Should contain DB_URL',
      )
    })

    it('should save API key credentials', async () => {
      const credentials: UserCredentials = {
        username: 'search_key',
        password: '',
        connectionString: 'http://127.0.0.1:7700',
        engine: Engine.Meilisearch,
        container: TEST_CONTAINER_MS,
        apiKey: 'abc123def456',
      }

      const filePath = await saveCredentials(
        TEST_CONTAINER_MS,
        Engine.Meilisearch,
        credentials,
      )

      const content = readFileSync(filePath, 'utf-8')
      assert(
        content.includes('API_KEY_NAME=search_key'),
        'Should contain API_KEY_NAME',
      )
      assert(content.includes('API_KEY=abc123def456'), 'Should contain API_KEY')
      assert(
        content.includes('API_URL=http://127.0.0.1:7700'),
        'Should contain API_URL',
      )
    })

    it('should create credentials directory if missing', async () => {
      const credentials: UserCredentials = {
        username: 'testuser',
        password: 'pass123',
        connectionString: 'postgresql://testuser:pass123@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      const credDir = join(
        paths.getContainerPath(TEST_CONTAINER, { engine: Engine.PostgreSQL }),
        'credentials',
      )
      assert(!existsSync(credDir), 'Credentials dir should not exist yet')

      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, credentials)

      assert(existsSync(credDir), 'Credentials dir should be created')
    })
  })

  describe('loadCredentials', () => {
    it('should load saved SQL credentials', async () => {
      const original: UserCredentials = {
        username: 'appuser',
        password: 'secret123',
        connectionString: 'postgresql://appuser:secret123@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, original)
      const loaded = await loadCredentials(
        TEST_CONTAINER,
        Engine.PostgreSQL,
        'appuser',
      )

      assert(loaded !== null, 'Should load credentials')
      assertEqual(loaded!.username, 'appuser', 'Username should match')
      assertEqual(loaded!.password, 'secret123', 'Password should match')
      assertEqual(loaded!.database, 'mydb', 'Database should match')
    })

    it('should return null for non-existent credentials', async () => {
      const loaded = await loadCredentials(
        TEST_CONTAINER,
        Engine.PostgreSQL,
        'nonexistent',
      )
      assert(loaded === null, 'Should return null')
    })

    it('should load API key credentials', async () => {
      const original: UserCredentials = {
        username: 'mykey',
        password: '',
        connectionString: 'http://127.0.0.1:7700',
        engine: Engine.Meilisearch,
        container: TEST_CONTAINER_MS,
        apiKey: 'key123',
      }

      await saveCredentials(TEST_CONTAINER_MS, Engine.Meilisearch, original)
      const loaded = await loadCredentials(
        TEST_CONTAINER_MS,
        Engine.Meilisearch,
        'mykey',
      )

      assert(loaded !== null, 'Should load API key credentials')
      assertEqual(loaded!.apiKey, 'key123', 'API key should match')
      assertEqual(
        loaded!.connectionString,
        'http://127.0.0.1:7700',
        'URL should match',
      )
    })
  })

  describe('listCredentials', () => {
    it('should list all saved credentials', async () => {
      const base: Omit<UserCredentials, 'username' | 'connectionString'> = {
        password: 'pass',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'alice',
        connectionString: 'postgresql://alice:pass@127.0.0.1:5432/mydb',
      })
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'bob',
        connectionString: 'postgresql://bob:pass@127.0.0.1:5432/mydb',
      })

      const users = await listCredentials(TEST_CONTAINER, Engine.PostgreSQL)
      assertDeepEqual(users, ['alice', 'bob'], 'Should list both users sorted')
    })

    it('should return sorted results regardless of insertion order', async () => {
      const base: Omit<UserCredentials, 'username' | 'connectionString'> = {
        password: 'pass',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      }

      // Insert in reverse alphabetical order
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'zara',
        connectionString: 'postgresql://zara:pass@127.0.0.1:5432/mydb',
      })
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'alice',
        connectionString: 'postgresql://alice:pass@127.0.0.1:5432/mydb',
      })
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        ...base,
        username: 'mike',
        connectionString: 'postgresql://mike:pass@127.0.0.1:5432/mydb',
      })

      const users = await listCredentials(TEST_CONTAINER, Engine.PostgreSQL)
      assertDeepEqual(
        users,
        ['alice', 'mike', 'zara'],
        'Should be alphabetically sorted regardless of insert order',
      )
    })

    it('should return empty array when no credentials', async () => {
      const users = await listCredentials(TEST_CONTAINER, Engine.PostgreSQL)
      assertDeepEqual(users, [], 'Should return empty array')
    })
  })

  describe('credentialsExist', () => {
    it('should return true when credentials exist', async () => {
      await saveCredentials(TEST_CONTAINER, Engine.PostgreSQL, {
        username: 'testuser',
        password: 'pass',
        connectionString: 'postgresql://testuser:pass@127.0.0.1:5432/mydb',
        engine: Engine.PostgreSQL,
        container: TEST_CONTAINER,
        database: 'mydb',
      })

      assert(
        credentialsExist(TEST_CONTAINER, Engine.PostgreSQL, 'testuser'),
        'Should return true',
      )
    })

    it('should return false when credentials do not exist', () => {
      assert(
        !credentialsExist(TEST_CONTAINER, Engine.PostgreSQL, 'nonexistent'),
        'Should return false',
      )
    })
  })
})
