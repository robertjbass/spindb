// FerretDB test seed data
// This file can be run with: mongosh mongodb://localhost:27017/test --file sample-db.js

// Create test_users collection with sample data
db.test_users.drop()
db.test_users.insertMany([
  { name: 'Alice', email: 'alice@example.com', age: 30 },
  { name: 'Bob', email: 'bob@example.com', age: 25 },
  { name: 'Charlie', email: 'charlie@example.com', age: 35 },
  { name: 'Diana', email: 'diana@example.com', age: 28 },
  { name: 'Eve', email: 'eve@example.com', age: 32 },
])

// Create test_products collection
db.test_products.drop()
db.test_products.insertMany([
  { name: 'Widget', price: 9.99, category: 'electronics' },
  { name: 'Gadget', price: 19.99, category: 'electronics' },
  { name: 'Book', price: 14.99, category: 'books' },
])

// Print confirmation
print('Seed data inserted successfully')
print('test_users count: ' + db.test_users.countDocuments())
print('test_products count: ' + db.test_products.countDocuments())
