-- Sample seed data for SQLite integration tests
-- Uses SQLite-compatible syntax (INTEGER PRIMARY KEY AUTOINCREMENT, TEXT, INSERT OR IGNORE)

-- Create test table (singular naming convention)
CREATE TABLE IF NOT EXISTS test_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Insert sample data (use INSERT OR IGNORE for idempotency)
INSERT OR IGNORE INTO test_user (name, email) VALUES
  ('Alice Johnson', 'alice@example.com'),
  ('Bob Smith', 'bob@example.com'),
  ('Charlie Brown', 'charlie@example.com'),
  ('Diana Ross', 'diana@example.com'),
  ('Eve Wilson', 'eve@example.com');
