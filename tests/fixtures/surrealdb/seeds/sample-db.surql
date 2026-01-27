-- SurrealDB test fixture
-- Creates a sample table with 5 test users

-- Define the table schema
DEFINE TABLE test_user SCHEMAFULL;
DEFINE FIELD id ON test_user TYPE int;
DEFINE FIELD name ON test_user TYPE string;
DEFINE FIELD email ON test_user TYPE string;
DEFINE FIELD created_at ON test_user TYPE datetime DEFAULT time::now();

-- Insert test data
CREATE test_user:1 SET id = 1, name = 'Alice', email = 'alice@example.com';
CREATE test_user:2 SET id = 2, name = 'Bob', email = 'bob@example.com';
CREATE test_user:3 SET id = 3, name = 'Charlie', email = 'charlie@example.com';
CREATE test_user:4 SET id = 4, name = 'Diana', email = 'diana@example.com';
CREATE test_user:5 SET id = 5, name = 'Eve', email = 'eve@example.com';
