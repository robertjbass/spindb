-- CockroachDB test fixture
-- Creates a sample table with 5 test users

CREATE TABLE IF NOT EXISTS test_user (
    id INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT now()
);

INSERT INTO test_user (id, name, email) VALUES
    (1, 'Alice', 'alice@example.com'),
    (2, 'Bob', 'bob@example.com'),
    (3, 'Charlie', 'charlie@example.com'),
    (4, 'Diana', 'diana@example.com'),
    (5, 'Eve', 'eve@example.com');
