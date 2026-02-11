-- Verification queries for InfluxDB integration tests
-- Run AFTER seeding with sample-db.lp
-- Usage: spindb run <container> sample-queries.sql --database <dbname>

SHOW TABLES;

SELECT * FROM test_user ORDER BY id;

SELECT COUNT(*) AS total FROM test_user;
