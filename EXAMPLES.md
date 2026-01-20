# SpinDB Examples

Comprehensive examples and workflows for PostgreSQL, MySQL, SQLite, and MongoDB. Each section includes practical, real-world scenarios you can adapt to your projects.

> **Looking for quick command reference?** See [CHEATSHEET.md](CHEATSHEET.md) for a compact one-page reference.

---

## Table of Contents

- [PostgreSQL Examples](#postgresql-examples)
- [MySQL Examples](#mysql-examples)
- [SQLite Examples](#sqlite-examples)
- [MongoDB Examples](#mongodb-examples)
- [Redis Examples](#redis-examples)
- [Automation & Testing](#automation--testing)

---

## PostgreSQL Examples

### Available Commands & Flags

#### `create` - Create PostgreSQL container
```bash
spindb create [name] [options]
```
**Options:**
- `-e, --engine <engine>` - Database engine (default: `postgresql`)
- `--db-version <version>` - PostgreSQL version (14, 15, 16, 17, 18)
- `-d, --database <database>` - Primary database name
- `-p, --port <port>` - Port number (default: 5432)
- `--max-connections <number>` - Max connections (default: 200)
- `--start` - Auto-start after creation
- `--no-start` - Don't start after creation
- `--connect` - Open shell after creation
- `--from <location>` - Restore from backup file or connection string
- `-j, --json` - Output as JSON

#### `start` - Start container
```bash
spindb start [name] [-j, --json]
```

#### `stop` - Stop container
```bash
spindb stop [name] [-a, --all] [-j, --json]
```

#### `list` - List containers
```bash
spindb list [--json] [--no-scan]
```

#### `info` - Show container details
```bash
spindb info [name] [--json]
```

#### `delete` - Delete container
```bash
spindb delete [name] [-f, --force] [-y, --yes] [-j, --json]
```

#### `backup` - Create backup
```bash
spindb backup [container] [options]
```
**Options:**
- `-d, --database <name>` - Database to backup
- `-n, --name <name>` - Backup filename (without extension)
- `-o, --output <path>` - Output directory
- `--format <format>` - Engine-specific format (see below)
- `-j, --json` - Output result as JSON

**Format options by engine:**
- PostgreSQL: `sql`, `custom` (default: `sql`)
- MySQL/MariaDB: `sql`, `compressed` (default: `sql`)
- SQLite/DuckDB: `sql`, `binary` (default: `binary`)
- MongoDB: `bson`, `archive` (default: `archive`)
- Redis/Valkey: `text`, `rdb` (default: `rdb`)

#### `restore` - Restore backup
```bash
spindb restore [name] [backup] [options]
```
**Options:**
- `-d, --database <name>` - Target database
- `--from-url <url>` - Pull from remote database
- `-f, --force` - Overwrite existing database
- `-j, --json` - Output result as JSON

#### `backups` - List backup files
```bash
spindb backups [directory] [options]
```
**Options:**
- `-a, --all` - Include backups from `~/.spindb/backups`
- `-n, --limit <count>` - Limit number of results (default: 20)
- `-j, --json` - Output as JSON

#### `clone` - Clone container
```bash
spindb clone [source] [target] [-j, --json]
```

#### `connect` - Connect to database
```bash
spindb connect [name] [options]
```
**Options:**
- `-d, --database <name>` - Database to connect to
- `--tui` - Use usql for enhanced shell
- `--install-tui` - Install usql then connect
- `--pgcli` - Use pgcli (auto-completion)
- `--install-pgcli` - Install pgcli then connect

#### `run` - Execute SQL/JS/Commands
```bash
spindb run <name> [file] [options]
```
**Options:**
- `-d, --database <name>` - Target database
- `-c, --command <statement>` - Statement to execute (SQL, JavaScript, or Redis command)

#### `url` - Get connection string
```bash
spindb url [name] [options]
```
**Options:**
- `-c, --copy` - Copy to clipboard
- `-d, --database <database>` - Specify database
- `--json` - Output as JSON

#### `edit` - Edit container properties
```bash
spindb edit [name] [options]
```
**Options:**
- `-n, --name <newName>` - New container name
- `-p, --port <port>` - New port number
- `--set-config <setting>` - Set database config (e.g., `max_connections=200`)
- `-j, --json` - Output result as JSON

#### `logs` - View container logs
```bash
spindb logs [name] [options]
```
**Options:**
- `-f, --follow` - Follow log output
- `-n, --lines <number>` - Number of lines to show (default: 50)
- `--editor` - Open logs in $EDITOR

---

### Basic PostgreSQL Workflow

**Example: Create and use a development database**
```bash
# Create a PostgreSQL 18 container (latest version)
spindb create myapp --version 18

# Check it's running
spindb list
# Output shows: myapp (postgresql 18) running on port 5432

# Get connection string
spindb url myapp
# postgresql://postgres@127.0.0.1:5432/myapp

# Copy connection string to clipboard
spindb url myapp --copy

# Connect with psql
spindb connect myapp

# Inside psql:
# CREATE TABLE users (
#   id SERIAL PRIMARY KEY,
#   email TEXT UNIQUE NOT NULL,
#   created_at TIMESTAMP DEFAULT NOW()
# );
# \q to exit
```

---

### Multi-Version PostgreSQL Setup

**Example: Run different PostgreSQL versions simultaneously**
```bash
# Create multiple versions for compatibility testing
spindb create legacy-app --version 14 --port 5432
spindb create current-app --version 17 --port 5433
spindb create beta-app --version 18 --port 5434

# List all containers
spindb list
# legacy-app   🐘 postgresql   14       5432      ● running
# current-app  🐘 postgresql   17       5433      ● running
# beta-app     🐘 postgresql   18       5434      ● running

# Connect to specific version
spindb connect legacy-app
spindb connect current-app
spindb connect beta-app
```

---

### Custom Configuration

**Example: High-performance PostgreSQL for development**
```bash
# Create with more connections
spindb create analytics-db --max-connections 500

# Tune shared buffers after creation
spindb edit analytics-db --set-config shared_buffers=512MB

# Increase work memory for complex queries
spindb edit analytics-db --set-config work_mem=16MB

# Set effective cache size (tells planner how much RAM is available)
spindb edit analytics-db --set-config effective_cache_size=8GB

# Restart to apply changes
spindb stop analytics-db && spindb start analytics-db

# Verify settings via psql
spindb connect analytics-db
# SHOW max_connections;
# SHOW shared_buffers;
# SHOW work_mem;
```

---

### Backup & Restore

**Example: Create backups in different formats**
```bash
# Create a database with sample data
spindb create prod-backup
spindb run prod-backup -c "
  CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name TEXT,
    price DECIMAL(10,2)
  );
  INSERT INTO products (name, price) VALUES
    ('Widget', 19.99),
    ('Gadget', 29.99),
    ('Doohickey', 9.99);
"

# Plain SQL backup (human-readable, portable)
spindb backup prod-backup --format sql --name prod-snapshot-sql
# Creates: prod-backup-prod-backup-backup-TIMESTAMP.sql

# Custom format dump (faster restore, compressed)
spindb backup prod-backup --format custom --name prod-snapshot-dump
# Creates: prod-backup-prod-backup-backup-TIMESTAMP.dump

# Backup specific database with custom output dir
spindb backup prod-backup --database prod-backup --output ~/backups

# Backup in JSON format (for scripts)
spindb backup prod-backup --json
```

**Example: List backup files in directory**
```bash
# List backups in current directory
spindb backups
# Output:
#   🐘 prod-backup-backup-20260102T120000.sql    12.5 MB     2h ago  SQL dump
#   🐘 prod-backup-backup-20260101T180000.dump    8.2 MB    1d ago  pg_dump custom

# List backups including system backup directory
spindb backups --all

# List backups in a specific directory
spindb backups ./backups

# Get machine-readable output
spindb backups --json
```

**Example: Restore from local backup**
```bash
# Create empty container
spindb create prod-restore

# Restore from SQL file
spindb restore prod-restore ./prod-snapshot-sql.sql

# Restore from dump file
spindb restore prod-restore ./prod-snapshot-dump.dump --database prod-restore

# Force overwrite existing database
spindb restore prod-restore ./backup.sql --force

# Restore to specific database name
spindb restore prod-restore ./backup.sql --database my_app_db
```

**Example: Pull from remote production database**
```bash
# Create local container for staging
spindb create staging-copy

# Pull data from production (creates dump automatically)
spindb restore staging-copy --from-url "postgresql://user:pass@prod.example.com:5432/myapp"

# Or create and restore in one command
spindb create staging-copy \
  --from "postgresql://user:pass@prod.example.com:5432/myapp"
```

---

### Database Cloning

**Example: Clone for testing destructive operations**
```bash
# Stop source container (required for cloning)
spindb stop prod-backup

# Clone the entire container (data + config)
spindb clone prod-backup test-migrations

# Start the clone
spindb start test-migrations
# Runs on new port (auto-assigned): 5433

# Run risky migrations on clone
spindb run test-migrations -c "ALTER TABLE products DROP COLUMN price;"

# If migration works, delete clone and run on original
spindb delete test-migrations --force

# If migration fails, delete clone and fix migration
spindb delete test-migrations --force
# Original data is untouched!
```

---

### Executing SQL

**Example: Run SQL from command line**
```bash
# Single statement
spindb run myapp -c "SELECT version();"

# Create schema
spindb run myapp -c "
  CREATE SCHEMA analytics;
  CREATE TABLE analytics.events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );
"

# Insert data
spindb run myapp -c "
  INSERT INTO users (email) VALUES ('alice@example.com');
"
```

**Example: Run SQL from file**
```bash
# Create migration file
cat > migrations/001_initial_schema.sql << 'EOF'
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
EOF

# Run the migration
spindb run myapp ./migrations/001_initial_schema.sql

# Run with specific database
spindb run myapp ./migrations/001_initial_schema.sql --database analytics
```

---

### Connection Strings

**Example: Get connection strings for different use cases**
```bash
# Plain output (for scripts)
spindb url myapp
# postgresql://postgres@127.0.0.1:5432/myapp

# Copy to clipboard
spindb url myapp --copy

# Different database in same container
spindb url myapp --database analytics
# postgresql://postgres@127.0.0.1:5432/analytics

# JSON format with connection details
spindb url myapp --json
# {
#   "connectionString": "postgresql://postgres@127.0.0.1:5432/myapp",
#   "host": "127.0.0.1",
#   "port": 5432,
#   "database": "myapp",
#   "user": "postgres",
#   "engine": "postgresql",
#   "container": "myapp"
# }
```

---

### Enhanced Shell Clients

**Example: Use pgcli for better interactive experience**
```bash
# Install and connect with pgcli (auto-completion, syntax highlighting)
spindb connect myapp --install-pgcli

# Or if already installed
spindb connect myapp --pgcli

# Use usql for universal SQL client (supports all engines)
spindb connect myapp --install-tui
```

---

### Container Management

**Example: Rename and change port**
```bash
# Rename container (must be stopped)
spindb stop myapp
spindb edit myapp --name my-app-prod
spindb start my-app-prod

# Change port
spindb edit my-app-prod --port 5555

# Restart to apply port change
spindb stop my-app-prod && spindb start my-app-prod

# Interactive edit (prompts for what to edit)
spindb edit my-app-prod
# Shows menu: Rename / Change port / Edit config / Cancel
```

---

### Viewing Logs

**Example: Debug startup issues**
```bash
# View last 50 lines (default)
spindb logs myapp

# View last 200 lines
spindb logs myapp --lines 200

# Follow logs in real-time (like tail -f)
spindb logs myapp --follow

# Open in editor
spindb logs myapp --editor
```

---

### Complete Development Workflow

**Example: Full lifecycle from creation to deletion**
```bash
# 1. Create database for new feature
spindb create feature-auth --version 18 --port 5444

# 2. Run initial schema
spindb run feature-auth ./schema/auth.sql

# 3. Seed test data
spindb run feature-auth ./seeds/users.sql

# 4. Get connection string for application config
spindb url feature-auth --copy
# Paste into .env: DATABASE_URL=postgresql://postgres@127.0.0.1:5444/feature-auth

# 5. Develop feature, make schema changes
spindb run feature-auth -c "ALTER TABLE users ADD COLUMN last_login TIMESTAMP;"

# 6. Create backup before testing
spindb backup feature-auth --format sql --name pre-merge-backup

# 7. Test feature, merge to main

# 8. Create staging database from backup
spindb create staging-auth --from ./pre-merge-backup.sql

# 9. Clean up
spindb delete feature-auth --force --yes
```

---

## MySQL Examples

### Available Commands & Flags

*(MySQL uses the same commands as PostgreSQL with minor differences)*

Key differences:
- Default port: **3306** (range: 3306-3400)
- Default user: **root** (no password by default)
- No version selection (uses system MySQL)
- Connection string format: `mysql://root@127.0.0.1:3306/database`
- Enhanced shell: Use `--mycli` instead of `--pgcli`

---

### Basic MySQL Workflow

**Example: Create and use a MySQL database**
```bash
# Create MySQL container
spindb create shopdb --engine mysql

# Check status
spindb list
# shopdb   🐬 mysql   8.0      3306      ● running

# Connect with mysql client
spindb connect shopdb

# Inside mysql:
# CREATE TABLE products (
#   id INT AUTO_INCREMENT PRIMARY KEY,
#   name VARCHAR(255) NOT NULL,
#   price DECIMAL(10,2),
#   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
# );
# EXIT;
```

---

### Multi-Database Setup

**Example: Separate databases for different services**
```bash
# Create multiple MySQL containers for microservices
spindb create users-service --engine mysql --port 3306
spindb create orders-service --engine mysql --port 3307
spindb create inventory-service --engine mysql --port 3308

# List all MySQL containers
spindb list
# users-service      🐬 mysql   8.0   3306   ● running
# orders-service     🐬 mysql   8.0   3307   ● running
# inventory-service  🐬 mysql   8.0   3308   ● running

# Get all connection strings
spindb url users-service      # mysql://root@127.0.0.1:3306/users-service
spindb url orders-service     # mysql://root@127.0.0.1:3307/orders-service
spindb url inventory-service  # mysql://root@127.0.0.1:3308/inventory-service
```

---

### Backup & Restore

**Example: Create MySQL backups**
```bash
# Create database with data
spindb create ecommerce --engine mysql
spindb run ecommerce -c "
  CREATE TABLE orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_email VARCHAR(255),
    total DECIMAL(10,2),
    status ENUM('pending', 'shipped', 'delivered'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO orders (customer_email, total, status) VALUES
    ('alice@example.com', 99.99, 'pending'),
    ('bob@example.com', 149.50, 'shipped');
"

# SQL backup (human-readable)
spindb backup ecommerce --format sql --name ecommerce-backup

# Compressed SQL backup (MySQL default: gzipped)
spindb backup ecommerce --format compressed --name ecommerce-compressed
# Creates: ecommerce-ecommerce-backup-TIMESTAMP.sql.gz
```

**Example: Restore MySQL backup**
```bash
# Create new container and restore
spindb create ecommerce-restore --engine mysql
spindb restore ecommerce-restore ./ecommerce-backup.sql

# Pull from remote MySQL server
spindb restore ecommerce-restore \
  --from-url "mysql://user:password@prod.example.com:3306/ecommerce"
```

---

### Cloning MySQL Databases

**Example: Clone for development**
```bash
# Stop and clone
spindb stop ecommerce
spindb clone ecommerce ecommerce-dev

# Start clone
spindb start ecommerce-dev
# Runs on new port: 3307

# Both containers now have identical data
# Modify dev without affecting original
spindb run ecommerce-dev -c "TRUNCATE TABLE orders;"
```

---

### Executing SQL

**Example: Run MySQL queries**
```bash
# Single query
spindb run ecommerce -c "SHOW TABLES;"

# Multiple statements
spindb run ecommerce -c "
  USE ecommerce;
  SELECT * FROM orders WHERE status = 'pending';
  UPDATE orders SET status = 'shipped' WHERE id = 1;
"

# Run from file
cat > reports/daily-sales.sql << 'EOF'
SELECT
  DATE(created_at) as sale_date,
  COUNT(*) as order_count,
  SUM(total) as total_sales
FROM orders
WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(created_at)
ORDER BY sale_date DESC;
EOF

spindb run ecommerce ./reports/daily-sales.sql
```

---

### Enhanced MySQL Client

**Example: Use mycli for better experience**
```bash
# Install and connect with mycli
spindb connect ecommerce --install-mycli

# Features:
# - Auto-completion for table/column names
# - Syntax highlighting
# - Query history
# - Pretty printed output
```

---

### Connection Strings for ORMs

**Example: Use with popular frameworks**
```bash
# For Prisma (Node.js)
spindb url ecommerce
# Add to schema.prisma:
# datasource db {
#   provider = "mysql"
#   url      = "mysql://root@127.0.0.1:3306/ecommerce"
# }

# For Django (Python)
spindb url ecommerce --json
# Use in settings.py:
# DATABASES = {
#     'default': {
#         'ENGINE': 'django.db.backends.mysql',
#         'NAME': 'ecommerce',
#         'USER': 'root',
#         'PASSWORD': '',
#         'HOST': '127.0.0.1',
#         'PORT': '3306',
#     }
# }

# For Laravel (PHP)
# Add to .env:
# DB_CONNECTION=mysql
# DB_HOST=127.0.0.1
# DB_PORT=3306
# DB_DATABASE=ecommerce
# DB_USERNAME=root
# DB_PASSWORD=
```

---

### Complete MySQL Example

**Example: E-commerce database setup**
```bash
# 1. Create database
spindb create shop --engine mysql

# 2. Run schema
cat > schema.sql << 'EOF'
CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  stock INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  status ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);
EOF

spindb run shop ./schema.sql

# 3. Seed data
spindb run shop -c "
  INSERT INTO customers (email, name) VALUES
    ('alice@example.com', 'Alice Smith'),
    ('bob@example.com', 'Bob Johnson');

  INSERT INTO products (name, description, price, stock) VALUES
    ('Laptop', '15-inch laptop', 999.99, 10),
    ('Mouse', 'Wireless mouse', 29.99, 50),
    ('Keyboard', 'Mechanical keyboard', 79.99, 25);
"

# 4. Create backup before testing
spindb backup shop --format sql --name shop-initial

# 5. Get connection string
spindb url shop --copy
```

---

## SQLite Examples

### Available Commands & Flags

Key differences from server databases:
- **No port management** - SQLite is file-based
- **No start/stop** - File is always "available" if it exists
- Default location: Current working directory (not `~/.spindb/`)
- Connection string format: `sqlite:///path/to/file.sqlite`
- Enhanced shell: Use `--litecli` instead of `--pgcli`
- Special flags:
  - `--path <path>` - Specify file location
  - `--relocate <path>` - Move database file (via `edit` command)

---

### Basic SQLite Workflow

**Example: Create and use a SQLite database**
```bash
# Create in current directory (default: ./mydb.sqlite)
spindb create mydb --engine sqlite

# Create with custom path
spindb create mydb --engine sqlite --path ./data/app.sqlite

# Create in specific location (absolute path)
spindb create mydb --engine sqlite --path ~/projects/myapp/database.db

# List SQLite databases
spindb list
# mydb   🗄️  sqlite   3   mydb.sqlite   🔵 available

# Connect to it
spindb connect mydb

# Inside sqlite3:
# CREATE TABLE tasks (
#   id INTEGER PRIMARY KEY AUTOINCREMENT,
#   title TEXT NOT NULL,
#   completed INTEGER DEFAULT 0,
#   created_at TEXT DEFAULT (datetime('now'))
# );
# .quit
```

---

### SQLite is Always "Available"

**Example: No start/stop needed**
```bash
# Create database
spindb create todos --engine sqlite

# No need to start - it's always available
spindb connect todos

# List shows status as "available" (not "running")
spindb list
# todos   🗄️  sqlite   3   todos.sqlite   🔵 available

# If file is deleted, status becomes "missing"
rm todos.sqlite
spindb list
# todos   🗄️  sqlite   3   todos.sqlite   ⚪ missing
```

---

### Registering Existing SQLite Files

**Example: Import existing database**
```bash
# You have an existing SQLite file
ls data/
# app.sqlite  legacy.db  analytics.sqlite3

# SpinDB can register it
cd data/
spindb list
# SpinDB prompts: "Unregistered SQLite database 'app.sqlite' found. Register with SpinDB?"
# Choose: Yes / No / Don't ask again for this folder

# Or register manually using the sqlite command
spindb sqlite register ./app.sqlite --name myapp
```

---

### Relocating SQLite Files

**Example: Move database to different location**
```bash
# Create database in current directory
spindb create testdb --engine sqlite
# File: ./testdb.sqlite

# Move to project data folder
spindb edit testdb --relocate ./data/

# Move and rename
spindb edit testdb --relocate ./data/production.sqlite

# Move with absolute path
spindb edit testdb --relocate ~/backups/testdb-backup.sqlite

# Overwrite existing file
spindb edit testdb --relocate ./data/testdb.sqlite --overwrite

# Connection still works - SpinDB tracks the new location
spindb connect testdb
```

---

### Backup & Restore

**Example: Backup SQLite database**
```bash
# Create database with data
spindb create notes --engine sqlite
spindb run notes -c "
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    title TEXT,
    content TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO notes (title, content) VALUES
    ('Meeting Notes', 'Discussed Q4 roadmap'),
    ('Ideas', 'New feature concepts');
"

# SQL backup (text format)
spindb backup notes --format sql --name notes-backup
# Creates: notes-notes-backup-TIMESTAMP.sql

# Backup is just the database file copy
# You can also manually copy the .sqlite file
cp notes.sqlite notes-backup.sqlite
```

**Example: Restore SQLite backup**
```bash
# Restore from SQL backup
spindb create notes-restore --engine sqlite
spindb restore notes-restore ./notes-backup.sql

# Or create and restore in one command
spindb create notes-restore --engine sqlite --from ./notes-backup.sql
```

---

### Cloning SQLite Databases

**Example: Clone for testing**
```bash
# Clone SQLite database (no need to stop - it's file-based)
spindb clone notes notes-test

# Both databases are independent files
spindb info notes
# File: /Users/you/projects/app/notes.sqlite

spindb info notes-test
# File: /Users/you/projects/app/notes-test.sqlite

# Modify test without affecting original
spindb run notes-test -c "DELETE FROM notes;"
```

---

### Executing SQL

**Example: Run SQLite queries**
```bash
# Single query
spindb run notes -c "SELECT * FROM notes ORDER BY created_at DESC;"

# Multiple statements
spindb run notes -c "
  CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
  INSERT INTO tags (name) VALUES ('work'), ('personal');
  CREATE TABLE note_tags (note_id INTEGER, tag_id INTEGER);
"

# Run from file
cat > migrations/add-tags.sql << 'EOF'
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id),
  PRIMARY KEY (note_id, tag_id)
);
EOF

spindb run notes ./migrations/add-tags.sql
```

---

### Enhanced SQLite Client

**Example: Use litecli for better experience**
```bash
# Install and connect with litecli
spindb connect notes --install-litecli

# Features:
# - Auto-completion for table/column names
# - Syntax highlighting
# - Multi-line editing
# - Pretty printed tables
```

---

### Connection Strings

**Example: Get SQLite connection strings**
```bash
# Plain output
spindb url notes
# sqlite:////Users/you/projects/app/notes.sqlite

# Copy to clipboard
spindb url notes --copy

# JSON format
spindb url notes --json
# {
#   "connectionString": "sqlite:////Users/you/projects/app/notes.sqlite",
#   "path": "/Users/you/projects/app/notes.sqlite",
#   "engine": "sqlite",
#   "container": "notes"
# }
```

---

### SQLite for Testing

**Example: Use SQLite for fast tests**
```bash
# Create test database
spindb create test-db --engine sqlite --path ./tmp/test.sqlite

# Run test migrations
spindb run test-db ./migrations/*.sql

# Run test suite (your app connects to sqlite:///./tmp/test.sqlite)
npm test

# Clean up
rm ./tmp/test.sqlite
spindb delete test-db --yes
```

---

### Complete SQLite Example

**Example: Task management app**
```bash
# 1. Create database
spindb create taskapp --engine sqlite --path ./taskapp.db

# 2. Create schema
cat > schema.sql << 'EOF'
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'done')),
  due_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_tasks_user ON tasks(user_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
EOF

spindb run taskapp ./schema.sql

# 3. Seed test data
spindb run taskapp -c "
  INSERT INTO users (username, email) VALUES
    ('alice', 'alice@example.com'),
    ('bob', 'bob@example.com');

  INSERT INTO tasks (user_id, title, description, status, due_date) VALUES
    (1, 'Write docs', 'Complete API documentation', 'in_progress', date('now', '+7 days')),
    (1, 'Code review', 'Review PR #123', 'todo', date('now', '+2 days')),
    (2, 'Deploy staging', 'Deploy v2.0 to staging', 'done', date('now', '-1 day'));
"

# 4. Query data
spindb run taskapp -c "
  SELECT
    u.username,
    t.title,
    t.status,
    t.due_date
  FROM tasks t
  JOIN users u ON t.user_id = u.id
  WHERE t.status != 'done'
  ORDER BY t.due_date;
"

# 5. Get connection string for your app
spindb url taskapp
# sqlite:////path/to/taskapp.db

# 6. Create backup before deploying
cp taskapp.db taskapp-backup-$(date +%Y%m%d).db

# Or use SpinDB backup command
spindb backup taskapp --format sql --name taskapp-backup
```

---

## MongoDB Examples

### Available Commands & Flags

Key differences from SQL databases:
- Default port: **27017** (range: 27017-27100)
- No default user (auth disabled by default)
- Uses **JavaScript** instead of SQL for queries
- Connection string format: `mongodb://127.0.0.1:27017/database`
- `spindb run` executes JavaScript code, not SQL

---

### Basic MongoDB Workflow

**Example: Create and use MongoDB database**
```bash
# Create MongoDB container
spindb create blogdb --engine mongodb

# Check status
spindb list
# blogdb   🍃 mongodb   8.0   27017   ● running

# Connect with mongosh
spindb connect blogdb

# Inside mongosh:
# db.posts.insertOne({
#   title: "Getting Started with MongoDB",
#   content: "MongoDB is a NoSQL database...",
#   tags: ["mongodb", "database", "nosql"],
#   createdAt: new Date()
# })
#
# db.posts.find().pretty()
# exit
```

---

### Multi-Database Setup

**Example: Separate MongoDB instances for different apps**
```bash
# Create multiple MongoDB containers
spindb create blog-db --engine mongodb --port 27017
spindb create analytics-db --engine mongodb --port 27018
spindb create cache-db --engine mongodb --port 27019

# List all MongoDB containers
spindb list
# blog-db        🍃 mongodb   8.0   27017   ● running
# analytics-db   🍃 mongodb   8.0   27018   ● running
# cache-db       🍃 mongodb   8.0   27019   ● running

# Get connection strings
spindb url blog-db        # mongodb://127.0.0.1:27017/blog-db
spindb url analytics-db   # mongodb://127.0.0.1:27018/analytics-db
spindb url cache-db       # mongodb://127.0.0.1:27019/cache-db
```

---

### Executing JavaScript (Not SQL!)

**Example: Run MongoDB queries with JavaScript**
```bash
# Insert documents
spindb run blogdb -c "
  db.posts.insertMany([
    {
      title: 'First Post',
      content: 'Hello MongoDB!',
      tags: ['intro', 'mongodb'],
      likes: 0,
      createdAt: new Date()
    },
    {
      title: 'Second Post',
      content: 'Learning NoSQL',
      tags: ['tutorial', 'nosql'],
      likes: 5,
      createdAt: new Date()
    }
  ])
"

# Query documents
spindb run blogdb -c "db.posts.find().pretty()"

# Query with filter
spindb run blogdb -c "db.posts.find({ likes: { \$gt: 0 } }).pretty()"

# Update documents
spindb run blogdb -c "
  db.posts.updateOne(
    { title: 'First Post' },
    { \$inc: { likes: 1 } }
  )
"

# Aggregate data
spindb run blogdb -c "
  db.posts.aggregate([
    { \$unwind: '\$tags' },
    { \$group: { _id: '\$tags', count: { \$sum: 1 } } },
    { \$sort: { count: -1 } }
  ])
"
```

**Example: Run JavaScript from file**
```bash
# Create seed script
cat > seeds/blog-data.js << 'EOF'
// Clear existing data
db.posts.deleteMany({});
db.users.deleteMany({});

// Insert users
db.users.insertMany([
  {
    username: 'alice',
    email: 'alice@example.com',
    joinedAt: new Date()
  },
  {
    username: 'bob',
    email: 'bob@example.com',
    joinedAt: new Date()
  }
]);

// Insert posts
db.posts.insertMany([
  {
    title: 'Getting Started with MongoDB',
    author: 'alice',
    content: 'MongoDB is a document database...',
    tags: ['mongodb', 'tutorial'],
    likes: 10,
    comments: [
      { user: 'bob', text: 'Great post!', createdAt: new Date() }
    ],
    createdAt: new Date()
  },
  {
    title: 'Advanced MongoDB Queries',
    author: 'bob',
    content: 'Learn aggregation pipelines...',
    tags: ['mongodb', 'advanced'],
    likes: 25,
    comments: [],
    createdAt: new Date()
  }
]);

print('Seeded ' + db.posts.countDocuments() + ' posts');
print('Seeded ' + db.users.countDocuments() + ' users');
EOF

# Run the seed script
spindb run blogdb ./seeds/blog-data.js
```

---

### Backup & Restore

**Example: Backup MongoDB database**
```bash
# Create compressed archive backup (recommended)
spindb backup blogdb --format archive --name blogdb-backup
# Creates: blogdb-blogdb-backup-TIMESTAMP.archive

# Create BSON directory backup (for per-collection access)
spindb backup blogdb --format bson --name blogdb-backup-dir
# Creates: blogdb-blogdb-backup-dir-TIMESTAMP/ directory with BSON files
```

**Example: Restore MongoDB backup**
```bash
# Create new container and restore from archive
spindb create blogdb-restore --engine mongodb
spindb restore blogdb-restore ./blogdb-backup.archive

# Pull from remote MongoDB server
spindb restore blogdb-restore \
  --from-url "mongodb://user:password@prod.example.com:27017/blogdb"
```

---

### Cloning MongoDB Databases

**Example: Clone for development**
```bash
# Stop and clone
spindb stop blogdb
spindb clone blogdb blogdb-dev

# Start clone
spindb start blogdb-dev
# Runs on new port: 27018

# Test destructive operations on clone
spindb run blogdb-dev -c "db.posts.deleteMany({ likes: { \$lt: 5 } })"

# Original data untouched
spindb start blogdb
spindb run blogdb -c "db.posts.countDocuments()"
```

---

### Complex MongoDB Operations

**Example: Aggregation pipelines**
```bash
# Calculate post statistics
spindb run blogdb -c "
  db.posts.aggregate([
    {
      \$group: {
        _id: '\$author',
        totalPosts: { \$sum: 1 },
        totalLikes: { \$sum: '\$likes' },
        avgLikes: { \$avg: '\$likes' }
      }
    },
    {
      \$sort: { totalLikes: -1 }
    }
  ])
"

# Find posts with most comments
spindb run blogdb -c "
  db.posts.aggregate([
    {
      \$project: {
        title: 1,
        author: 1,
        commentCount: { \$size: '\$comments' }
      }
    },
    {
      \$sort: { commentCount: -1 }
    },
    {
      \$limit: 5
    }
  ])
"
```

**Example: Indexes**
```bash
# Create indexes for better performance
spindb run blogdb -c "
  db.posts.createIndex({ author: 1 });
  db.posts.createIndex({ tags: 1 });
  db.posts.createIndex({ createdAt: -1 });
  db.posts.createIndex({ title: 'text', content: 'text' });
"

# List indexes
spindb run blogdb -c "db.posts.getIndexes()"

# Explain query plan
spindb run blogdb -c "
  db.posts.find({ author: 'alice' }).explain('executionStats')
"
```

---

### Connection Strings for Applications

**Example: Use with MongoDB drivers**
```bash
# For Node.js (MongoDB driver)
spindb url blogdb
# Add to .env:
# MONGODB_URI=mongodb://127.0.0.1:27017/blogdb

# Connection code:
# const { MongoClient } = require('mongodb');
# const client = new MongoClient(process.env.MONGODB_URI);
# await client.connect();

# For Mongoose (Node.js ODM)
# mongoose.connect('mongodb://127.0.0.1:27017/blogdb');

# Get JSON format with details
spindb url blogdb --json
# {
#   "connectionString": "mongodb://127.0.0.1:27017/blogdb",
#   "host": "127.0.0.1",
#   "port": 27017,
#   "database": "blogdb",
#   "engine": "mongodb",
#   "container": "blogdb"
# }
```

---

### Complete MongoDB Example

**Example: Social media API backend**
```bash
# 1. Create database
spindb create social-api --engine mongodb

# 2. Create schema (JavaScript)
cat > schema/init.js << 'EOF'
// Create collections with validation
db.createCollection("users", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["username", "email"],
      properties: {
        username: { bsonType: "string", minLength: 3 },
        email: { bsonType: "string", pattern: "^.+@.+$" },
        bio: { bsonType: "string" },
        followers: { bsonType: "array" },
        following: { bsonType: "array" },
        createdAt: { bsonType: "date" }
      }
    }
  }
});

db.createCollection("posts", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["userId", "content", "createdAt"],
      properties: {
        userId: { bsonType: "objectId" },
        content: { bsonType: "string", maxLength: 280 },
        likes: { bsonType: "array" },
        retweets: { bsonType: "array" },
        replies: { bsonType: "array" },
        createdAt: { bsonType: "date" }
      }
    }
  }
});

// Create indexes
db.users.createIndex({ username: 1 }, { unique: true });
db.users.createIndex({ email: 1 }, { unique: true });
db.posts.createIndex({ userId: 1 });
db.posts.createIndex({ createdAt: -1 });
db.posts.createIndex({ content: "text" });

print("Schema created successfully");
EOF

spindb run social-api ./schema/init.js

# 3. Seed data
cat > seeds/users.js << 'EOF'
const users = db.users.insertMany([
  {
    username: "alice",
    email: "alice@example.com",
    bio: "Software developer",
    followers: [],
    following: [],
    createdAt: new Date()
  },
  {
    username: "bob",
    email: "bob@example.com",
    bio: "Designer",
    followers: [],
    following: [],
    createdAt: new Date()
  }
]);

const alice = db.users.findOne({ username: "alice" });
const bob = db.users.findOne({ username: "bob" });

db.posts.insertMany([
  {
    userId: alice._id,
    content: "Just set up my local MongoDB with SpinDB!",
    likes: [],
    retweets: [],
    replies: [],
    createdAt: new Date()
  },
  {
    userId: bob._id,
    content: "Loving the new design tools",
    likes: [alice._id],
    retweets: [],
    replies: [],
    createdAt: new Date()
  }
]);

print("Seeded " + db.users.countDocuments() + " users");
print("Seeded " + db.posts.countDocuments() + " posts");
EOF

spindb run social-api ./seeds/users.js

# 4. Query data
spindb run social-api -c "
  db.posts.aggregate([
    {
      \$lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'author'
      }
    },
    {
      \$unwind: '\$author'
    },
    {
      \$project: {
        content: 1,
        'author.username': 1,
        likeCount: { \$size: '\$likes' },
        createdAt: 1
      }
    },
    {
      \$sort: { createdAt: -1 }
    }
  ]).pretty()
"

# 5. Get connection string
spindb url social-api --copy

# 6. Create backup
spindb backup social-api --format archive --name social-api-backup
```

---

## Redis Examples

### Available Commands & Flags

Key differences from SQL databases:
- Default port: **6379** (range: 6379-6400)
- No authentication by default
- Uses **Redis commands** instead of SQL
- Numbered databases (0-15) instead of named databases
- Connection string format: `redis://127.0.0.1:6379/0`
- `spindb run` executes Redis commands, not SQL
- Enhanced shell: Use `--iredis` for interactive experience

---

### Basic Redis Workflow

**Example: Create and use a Redis database**
```bash
# Create Redis container
spindb create cache --engine redis

# Check status
spindb list
# cache   🔴 redis   7.2   6379   ● running

# Connect with redis-cli
spindb connect cache

# Inside redis-cli:
# SET greeting "Hello, Redis!"
# GET greeting
# EXPIRE greeting 3600
# TTL greeting
# quit
```

---

### Multi-Instance Setup

**Example: Separate Redis instances for different purposes**
```bash
# Create multiple Redis containers
spindb create cache-main --engine redis --port 6379
spindb create cache-sessions --engine redis --port 6380
spindb create cache-jobs --engine redis --port 6381

# List all Redis containers
spindb list
# cache-main      🔴 redis   7.2   6379   ● running
# cache-sessions  🔴 redis   7.2   6380   ● running
# cache-jobs      🔴 redis   7.2   6381   ● running

# Get connection strings
spindb url cache-main       # redis://127.0.0.1:6379/0
spindb url cache-sessions   # redis://127.0.0.1:6380/0
spindb url cache-jobs       # redis://127.0.0.1:6381/0
```

---

### Executing Redis Commands

**Example: Run Redis commands**
```bash
# Set and get values
spindb run cache -c "SET user:1:name 'Alice'"
spindb run cache -c "GET user:1:name"

# Work with hashes
spindb run cache -c "HSET user:1 name Alice email alice@example.com"
spindb run cache -c "HGETALL user:1"

# Work with lists
spindb run cache -c "RPUSH queue:jobs job1 job2 job3"
spindb run cache -c "LRANGE queue:jobs 0 -1"

# Work with sets
spindb run cache -c "SADD tags:post:1 redis database nosql"
spindb run cache -c "SMEMBERS tags:post:1"

# Work with sorted sets
spindb run cache -c "ZADD leaderboard 100 alice 85 bob 92 charlie"
spindb run cache -c "ZREVRANGE leaderboard 0 2 WITHSCORES"
```

**Example: Run Redis commands from file**
```bash
# Create seed script
cat > seeds/redis-data.txt << 'EOF'
SET app:version "1.0.0"
SET app:environment "development"

HSET user:1 id 1 name "Alice" email "alice@example.com"
HSET user:2 id 2 name "Bob" email "bob@example.com"

RPUSH notifications:1 "Welcome to the app!" "Check out new features"
RPUSH notifications:2 "Welcome, Bob!"

SADD active_users 1 2

ZADD user_scores 100 1 85 2
EOF

# Run the seed script
spindb run cache ./seeds/redis-data.txt
```

---

### Backup & Restore

**Example: Backup Redis database**
```bash
# Create backup using RDB snapshot (default)
spindb backup cache --format rdb --name cache-backup
# Creates: cache-cache-backup-TIMESTAMP.rdb

# Or create text format backup (human-readable Redis commands)
spindb backup cache --format text --name cache-backup-text
# Creates: cache-cache-backup-text-TIMESTAMP.redis

# RDB files are Redis's native binary format
# They can be restored to any Redis instance
```

**Example: Restore Redis backup**
```bash
# Create new container and restore
spindb create cache-restore --engine redis
spindb restore cache-restore ./cache-backup.rdb

# Note: Container must be stopped to restore RDB files
spindb stop cache-restore
spindb restore cache-restore ./cache-backup.rdb
spindb start cache-restore
```

---

### Cloning Redis Databases

**Example: Clone for testing**
```bash
# Stop and clone
spindb stop cache
spindb clone cache cache-test

# Start clone
spindb start cache-test
# Runs on new port: 6380

# Test operations on clone
spindb run cache-test -c "FLUSHDB"
# Original data is safe!

# Restart original
spindb start cache
```

---

### Connection Strings for Applications

**Example: Use with Redis clients**
```bash
# For Node.js (ioredis)
spindb url cache
# Add to .env:
# REDIS_URL=redis://127.0.0.1:6379/0

# Connection code:
# const Redis = require('ioredis');
# const redis = new Redis(process.env.REDIS_URL);

# For Python (redis-py)
# import redis
# r = redis.from_url('redis://127.0.0.1:6379/0')

# Get JSON format with details
spindb url cache --json
# {
#   "connectionString": "redis://127.0.0.1:6379/0",
#   "host": "127.0.0.1",
#   "port": 6379,
#   "database": "0",
#   "engine": "redis",
#   "container": "cache"
# }
```

---

### Enhanced Redis Client

**Example: Use iredis for better experience**
```bash
# Install and connect with iredis
spindb connect cache --iredis

# Features:
# - Auto-completion for commands
# - Syntax highlighting
# - Command history
# - Pretty printed output
```

---

### Complete Redis Example

**Example: Session store and cache**
```bash
# 1. Create Redis instance
spindb create session-store --engine redis

# 2. Set up session data structure
spindb run session-store -c "
SET session:abc123 '{\"userId\":1,\"email\":\"alice@example.com\",\"loginAt\":1234567890}'
EXPIRE session:abc123 3600
"

# 3. Cache some data
spindb run session-store -c "
SET cache:user:1:profile '{\"name\":\"Alice\",\"avatar\":\"https://...\"}'
EXPIRE cache:user:1:profile 300
"

# 4. Add rate limiting counter
spindb run session-store -c "
SET ratelimit:ip:192.168.1.1 1
EXPIRE ratelimit:ip:192.168.1.1 60
INCR ratelimit:ip:192.168.1.1
"

# 5. Check all keys
spindb run session-store -c "KEYS *"

# 6. Get connection string
spindb url session-store --copy

# 7. Create backup
spindb backup session-store --format rdb --name session-store-backup
```

---

## Automation & Testing

### Using SpinDB in Node.js Test Runner

This example shows how to use SpinDB in automated tests to spin up databases, seed data, run queries, and clean up.

**Example: Integration tests with Node.js test runner**

```javascript
// test/database.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import pg from 'pg';

const { Client } = pg;

/**
 * Helper to run spindb commands
 */
function spindb(command) {
  try {
    const result = execSync(`spindb ${command}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim();
  } catch (error) {
    throw new Error(`SpinDB command failed: ${command}\n${error.message}`);
  }
}

/**
 * Helper to parse JSON output from spindb
 */
function spindbJSON(command) {
  const output = spindb(`${command} --json`);
  return JSON.parse(output);
}

describe('Database Integration Tests', () => {
  const containerName = 'test-db-' + Date.now();
  let connectionString;
  let client;

  before(async () => {
    // Create a fresh PostgreSQL container for testing
    console.log('Setting up test database...');

    const result = spindbJSON(`create ${containerName} --start`);

    assert.ok(result.success, 'Database creation should succeed');
    assert.strictEqual(result.name, containerName);
    assert.strictEqual(result.engine, 'postgresql');

    connectionString = result.connectionString;
    console.log(`Test database created: ${connectionString}`);

    // Create test schema
    spindb(`run ${containerName} -c "
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE posts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        title TEXT NOT NULL,
        content TEXT,
        published BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX idx_posts_user_id ON posts(user_id);
      CREATE INDEX idx_posts_published ON posts(published);
    "`);

    // Seed test data
    spindb(`run ${containerName} -c "
      INSERT INTO users (email, name) VALUES
        ('alice@example.com', 'Alice Smith'),
        ('bob@example.com', 'Bob Johnson'),
        ('charlie@example.com', 'Charlie Brown');

      INSERT INTO posts (user_id, title, content, published) VALUES
        (1, 'First Post', 'Hello World!', true),
        (1, 'Draft Post', 'Work in progress...', false),
        (2, 'Bob\\'s Post', 'My first post', true),
        (3, 'Charlie\\'s Thoughts', 'Random thoughts', true);
    "`);

    // Connect with pg client for detailed tests
    client = new Client({ connectionString });
    await client.connect();
  });

  after(async () => {
    // Clean up: close connection and delete container
    if (client) {
      await client.end();
    }

    console.log('Cleaning up test database...');
    spindb(`delete ${containerName} --force --yes`);
    console.log('Test database deleted');
  });

  describe('User Operations', () => {
    it('should retrieve all users', async () => {
      const result = await client.query('SELECT * FROM users ORDER BY id');

      assert.strictEqual(result.rows.length, 3);
      assert.strictEqual(result.rows[0].email, 'alice@example.com');
      assert.strictEqual(result.rows[1].email, 'bob@example.com');
      assert.strictEqual(result.rows[2].email, 'charlie@example.com');
    });

    it('should create a new user', async () => {
      const result = await client.query(
        'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *',
        ['dave@example.com', 'Dave Wilson']
      );

      assert.strictEqual(result.rows.length, 1);
      assert.strictEqual(result.rows[0].email, 'dave@example.com');
      assert.strictEqual(result.rows[0].name, 'Dave Wilson');
    });

    it('should enforce unique email constraint', async () => {
      await assert.rejects(
        async () => {
          await client.query(
            'INSERT INTO users (email, name) VALUES ($1, $2)',
            ['alice@example.com', 'Another Alice']
          );
        },
        /duplicate key value violates unique constraint/
      );
    });
  });

  describe('Post Operations', () => {
    it('should retrieve only published posts', async () => {
      const result = await client.query(
        'SELECT * FROM posts WHERE published = true ORDER BY id'
      );

      assert.strictEqual(result.rows.length, 3);
      assert.strictEqual(result.rows[0].title, 'First Post');
      assert.strictEqual(result.rows[1].title, "Bob's Post");
      assert.strictEqual(result.rows[2].title, "Charlie's Thoughts");
    });

    it('should create post for user', async () => {
      const userResult = await client.query(
        'SELECT id FROM users WHERE email = $1',
        ['alice@example.com']
      );
      const userId = userResult.rows[0].id;

      const postResult = await client.query(
        'INSERT INTO posts (user_id, title, content, published) VALUES ($1, $2, $3, $4) RETURNING *',
        [userId, 'New Post', 'New content', true]
      );

      assert.strictEqual(postResult.rows.length, 1);
      assert.strictEqual(postResult.rows[0].user_id, userId);
      assert.strictEqual(postResult.rows[0].title, 'New Post');
    });

    it('should get posts with user details using JOIN', async () => {
      const result = await client.query(`
        SELECT
          p.id,
          p.title,
          p.content,
          u.name as author_name,
          u.email as author_email
        FROM posts p
        JOIN users u ON p.user_id = u.id
        WHERE p.published = true
        ORDER BY p.created_at DESC
      `);

      assert.ok(result.rows.length >= 3);
      assert.ok(result.rows[0].author_name);
      assert.ok(result.rows[0].author_email);
    });
  });

  describe('Complex Queries', () => {
    it('should count posts per user', async () => {
      const result = await client.query(`
        SELECT
          u.name,
          COUNT(p.id) as post_count,
          COUNT(CASE WHEN p.published THEN 1 END) as published_count
        FROM users u
        LEFT JOIN posts p ON u.id = p.user_id
        GROUP BY u.id, u.name
        ORDER BY u.name
      `);

      assert.ok(result.rows.length >= 3);

      const alice = result.rows.find(r => r.name === 'Alice Smith');
      assert.ok(alice);
      assert.ok(parseInt(alice.post_count) >= 2);
      assert.ok(parseInt(alice.published_count) >= 1);
    });
  });
});
```

**Run the tests:**
```bash
node --test test/database.test.js
```

**Output:**
```
Setting up test database...
Test database created: postgresql://postgres@127.0.0.1:5432/test-db-1234567890
✔ User Operations > should retrieve all users (5ms)
✔ User Operations > should create a new user (3ms)
✔ User Operations > should enforce unique email constraint (2ms)
✔ Post Operations > should retrieve only published posts (2ms)
✔ Post Operations > should create post for user (3ms)
✔ Post Operations > should get posts with user details using JOIN (2ms)
✔ Complex Queries > should count posts per user (3ms)
Cleaning up test database...
Test database deleted
```

---

### Advanced Testing: Parallel Tests with Isolation

**Example: Multiple test files with isolated databases**

```javascript
// test/helpers/db.js
import { execSync } from 'node:child_process';
import pg from 'pg';

export class TestDatabase {
  constructor(name) {
    this.containerName = `test-${name}-${Date.now()}`;
    this.connectionString = null;
    this.client = null;
  }

  /**
   * Create and start database
   */
  async setup() {
    const output = execSync(
      `spindb create ${this.containerName} --start --json`,
      { encoding: 'utf-8' }
    );

    const result = JSON.parse(output);
    this.connectionString = result.connectionString;

    this.client = new pg.Client({ connectionString: this.connectionString });
    await this.client.connect();

    return this.client;
  }

  /**
   * Run SQL against database
   */
  async run(sql) {
    return this.client.query(sql);
  }

  /**
   * Load schema from file
   */
  loadSchema(schemaPath) {
    execSync(`spindb run ${this.containerName} ${schemaPath}`);
  }

  /**
   * Teardown and delete database
   */
  async teardown() {
    if (this.client) {
      await this.client.end();
    }
    execSync(`spindb delete ${this.containerName} --force --yes`, {
      stdio: 'ignore'
    });
  }
}
```

**Use in tests:**
```javascript
// test/users.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { TestDatabase } from './helpers/db.js';

describe('User Tests', () => {
  const db = new TestDatabase('users');

  before(async () => {
    await db.setup();
    db.loadSchema('./schema/users.sql');
  });

  after(async () => {
    await db.teardown();
  });

  it('should create user', async () => {
    const result = await db.run(
      `INSERT INTO users (email, name) VALUES ('test@example.com', 'Test User') RETURNING *`
    );
    assert.strictEqual(result.rows[0].email, 'test@example.com');
  });
});

// test/posts.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { TestDatabase } from './helpers/db.js';

describe('Post Tests', () => {
  const db = new TestDatabase('posts');

  before(async () => {
    await db.setup();
    db.loadSchema('./schema/posts.sql');
  });

  after(async () => {
    await db.teardown();
  });

  it('should create post', async () => {
    // Each test file has its own isolated database!
    const result = await db.run(
      `INSERT INTO posts (title) VALUES ('Test Post') RETURNING *`
    );
    assert.strictEqual(result.rows[0].title, 'Test Post');
  });
});
```

**Run tests in parallel:**
```bash
# Each test file gets its own database
node --test test/*.test.js

# Databases are created/destroyed automatically
# test-users-1234567890
# test-posts-1234567891
```

---

### CI/CD Integration

**Example: GitHub Actions workflow**

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      # Install SpinDB
      - name: Install SpinDB
        run: npm install -g spindb

      # Check dependencies (installs PostgreSQL client tools)
      - name: Install database tools
        run: spindb deps install --engine postgresql

      # Run tests (tests will create/destroy databases automatically)
      - name: Run tests
        run: npm test

      # Optional: Show running containers (for debugging)
      - name: Show containers
        if: failure()
        run: spindb list
```

---

### Using SpinDB in Package Scripts

**Example: package.json scripts**

```json
{
  "name": "myapp",
  "scripts": {
    "db:create": "spindb create myapp --start",
    "db:drop": "spindb delete myapp --force --yes",
    "db:reset": "npm run db:drop && npm run db:create && npm run db:migrate && npm run db:seed",
    "db:migrate": "spindb run myapp ./migrations/*.sql",
    "db:seed": "spindb run myapp ./seeds/dev-data.sql",
    "db:backup": "spindb backup myapp --format sql --output ./backups",
    "test": "node --test test/**/*.test.js",
    "test:integration": "npm run db:create && npm test && npm run db:drop"
  }
}
```

**Usage:**
```bash
# Set up development database
npm run db:create
npm run db:migrate
npm run db:seed

# Reset database when needed
npm run db:reset

# Run tests with fresh database
npm run test:integration

# Create backup before risky operation
npm run db:backup
```

---

### Snapshot Testing with Clones

**Example: Test migrations without risk**

```javascript
// scripts/test-migration.js
import { execSync } from 'node:child_process';

const PROD_CONTAINER = 'production';
const TEST_CONTAINER = 'migration-test-' + Date.now();

console.log('1. Stopping production database...');
execSync(`spindb stop ${PROD_CONTAINER}`);

console.log('2. Cloning production database...');
execSync(`spindb clone ${PROD_CONTAINER} ${TEST_CONTAINER}`);

console.log('3. Starting test clone...');
execSync(`spindb start ${TEST_CONTAINER}`);

console.log('4. Restarting production database...');
execSync(`spindb start ${PROD_CONTAINER}`);

try {
  console.log('5. Running migration on test clone...');
  execSync(`spindb run ${TEST_CONTAINER} ./migrations/005-add-users-table.sql`);

  console.log('6. Verifying migration...');
  execSync(`spindb run ${TEST_CONTAINER} -c "SELECT * FROM users LIMIT 1"`);

  console.log('✅ Migration successful!');
  console.log('You can now apply this migration to production.');

} catch (error) {
  console.error('❌ Migration failed!');
  console.error(error.message);
  console.log('Production data is safe. Review the error and fix the migration.');

} finally {
  console.log('7. Cleaning up test clone...');
  execSync(`spindb delete ${TEST_CONTAINER} --force --yes`);
}
```

**Run:**
```bash
node scripts/test-migration.js
```

---

## Summary

This guide covers all SpinDB commands across all five supported database engines. Key patterns:

1. **Server databases** (PostgreSQL, MySQL, MongoDB, Redis) need start/stop, use ports
2. **File-based databases** (SQLite) are always available, use file paths
3. **All engines** support backup, restore, clone, run, connect
4. **Automation** is easy - use `--json` for scripting and spawn databases in tests
5. **MongoDB** uses JavaScript, **Redis** uses Redis commands instead of SQL

---

**Quick reference:** [CHEATSHEET.md](CHEATSHEET.md)
**Full documentation:** [README.md](README.md)
