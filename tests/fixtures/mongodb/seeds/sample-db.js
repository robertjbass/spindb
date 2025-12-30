/**
 * MongoDB seed script for integration tests
 * Creates test_user collection with 5 documents
 *
 * Usage: mongosh testdb --file sample-db.js
 */

// Switch to the test database (creates it if it doesn't exist)
db = db.getSiblingDB('testdb')

// Drop existing collection to ensure clean state
db.test_user.drop()

// Insert test documents (exactly 5 for test verification)
db.test_user.insertMany([
  { id: 1, name: 'Alice Johnson', email: 'alice@example.com' },
  { id: 2, name: 'Bob Smith', email: 'bob@example.com' },
  { id: 3, name: 'Charlie Brown', email: 'charlie@example.com' },
  { id: 4, name: 'Diana Ross', email: 'diana@example.com' },
  { id: 5, name: 'Eve Wilson', email: 'eve@example.com' },
])

// Verify insertion
const count = db.test_user.countDocuments()
print('Inserted ' + count + ' documents into test_user collection')
