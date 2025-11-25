-- Sample database schema for testing SpinDB
-- Creates a basic users table with common fields (MySQL syntax)

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,
    INDEX idx_users_email (email),
    INDEX idx_users_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sample data
INSERT IGNORE INTO users (first_name, last_name, email) VALUES
    ('Alice', 'Johnson', 'alice@example.com'),
    ('Bob', 'Smith', 'bob@example.com'),
    ('Charlie', 'Williams', 'charlie@example.com'),
    ('Diana', 'Brown', 'diana@example.com'),
    ('Eve', 'Davis', 'eve@example.com');
