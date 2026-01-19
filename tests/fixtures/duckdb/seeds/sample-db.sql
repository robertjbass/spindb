-- DuckDB test seed data
-- This file creates a test table and inserts sample data
-- Uses DELETE + INSERT for idempotency (safe to run multiple times)

CREATE TABLE IF NOT EXISTS test_user (
    id INTEGER PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Clear existing data for idempotency
DELETE FROM test_user WHERE id IN (1, 2, 3, 4, 5);

INSERT INTO test_user (id, email, name) VALUES
    (1, 'alice@example.com', 'Alice'),
    (2, 'bob@example.com', 'Bob'),
    (3, 'charlie@example.com', 'Charlie'),
    (4, 'diana@example.com', 'Diana'),
    (5, 'eve@example.com', 'Eve');
