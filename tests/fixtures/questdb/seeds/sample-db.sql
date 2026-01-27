-- Sample seed data for QuestDB integration tests
-- QuestDB is a time-series database with specific SQL extensions

-- Create test table (QuestDB uses designated timestamp column)
CREATE TABLE IF NOT EXISTS test_user (
  id LONG,
  name STRING,
  email SYMBOL,
  created_at TIMESTAMP
) timestamp(created_at) PARTITION BY DAY;

-- Insert sample data with explicit timestamps
INSERT INTO test_user VALUES
  (1, 'Alice Johnson', 'alice@example.com', '2024-01-15T10:30:00.000000Z'),
  (2, 'Bob Smith', 'bob@example.com', '2024-01-16T14:45:00.000000Z'),
  (3, 'Charlie Brown', 'charlie@example.com', '2024-01-17T09:15:00.000000Z'),
  (4, 'Diana Ross', 'diana@example.com', '2024-01-18T16:00:00.000000Z'),
  (5, 'Eve Wilson', 'eve@example.com', '2024-01-19T11:30:00.000000Z');
