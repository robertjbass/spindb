-- Sample database schema for testing SpinDB
-- Creates a basic users table with common fields

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Create an index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Create an index on deleted_at for soft delete queries
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

-- Sample data
INSERT INTO users (first_name, last_name, email) VALUES
    ('Alice', 'Johnson', 'alice@example.com'),
    ('Bob', 'Smith', 'bob@example.com'),
    ('Charlie', 'Williams', 'charlie@example.com'),
    ('Diana', 'Brown', 'diana@example.com'),
    ('Eve', 'Davis', 'eve@example.com')
ON CONFLICT (email) DO NOTHING;
