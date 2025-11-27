-- Sample seed data for PostgreSQL integration tests

-- Create test table
CREATE TABLE IF NOT EXISTS test_users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert sample data
INSERT INTO test_users (name, email) VALUES
  ('Alice Johnson', 'alice@example.com'),
  ('Bob Smith', 'bob@example.com'),
  ('Charlie Brown', 'charlie@example.com'),
  ('Diana Ross', 'diana@example.com'),
  ('Eve Wilson', 'eve@example.com')
ON CONFLICT (email) DO NOTHING;
