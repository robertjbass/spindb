-- Sample seed data for ClickHouse integration tests

-- Create test table (singular naming convention)
CREATE TABLE IF NOT EXISTS test_user (
  id UInt64,
  name String,
  email String,
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY id;

-- Clear existing data (ClickHouse uses TRUNCATE)
TRUNCATE TABLE IF EXISTS test_user;

-- Insert sample data
INSERT INTO test_user (id, name, email) VALUES
  (1, 'Alice Johnson', 'alice@example.com'),
  (2, 'Bob Smith', 'bob@example.com'),
  (3, 'Charlie Brown', 'charlie@example.com'),
  (4, 'Diana Ross', 'diana@example.com'),
  (5, 'Eve Wilson', 'eve@example.com');
