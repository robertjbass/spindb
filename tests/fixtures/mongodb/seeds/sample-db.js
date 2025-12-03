// MongoDB seed script for integration tests
// This inserts sample documents into the test_user collection

// Clear existing data
db.test_user.drop();

// Insert sample users
db.test_user.insertMany([
  {
    name: 'Alice',
    email: 'alice@example.com',
    created_at: new Date('2024-01-01T00:00:00Z')
  },
  {
    name: 'Bob',
    email: 'bob@example.com',
    created_at: new Date('2024-01-02T00:00:00Z')
  },
  {
    name: 'Charlie',
    email: 'charlie@example.com',
    created_at: new Date('2024-01-03T00:00:00Z')
  },
  {
    name: 'Diana',
    email: 'diana@example.com',
    created_at: new Date('2024-01-04T00:00:00Z')
  },
  {
    name: 'Eve',
    email: 'eve@example.com',
    created_at: new Date('2024-01-05T00:00:00Z')
  }
]);

// Verify insert
print(`Inserted ${db.test_user.countDocuments()} documents into test_user collection`);
