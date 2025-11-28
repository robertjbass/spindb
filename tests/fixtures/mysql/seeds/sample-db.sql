-- Sample seed data for MySQL integration tests

-- Create test table (singular naming convention)
CREATE TABLE IF NOT EXISTS test_user (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert sample data (using IGNORE to skip duplicates)
INSERT IGNORE INTO test_user (name, email) VALUES
  ('Alice Johnson', 'alice@example.com'),
  ('Bob Smith', 'bob@example.com'),
  ('Charlie Brown', 'charlie@example.com'),
  ('Diana Ross', 'diana@example.com'),
  ('Eve Wilson', 'eve@example.com');
