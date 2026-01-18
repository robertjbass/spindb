# SpinDB Docker Linux Edge Case Test Environment
#
# PURPOSE: Tests that hostdb binaries work correctly on minimal Linux systems.
# This catches library dependency issues and platform-specific edge cases.
#
# NOTE: This is NOT the primary test environment. GitHub Actions runs native
# tests on Ubuntu, macOS, and Windows VMs which better represent real user
# environments. Use this for:
# - Verifying hostdb binaries have correct library dependencies
# - Testing on a minimal system without pre-installed database tools
# - Catching Linux-specific edge cases (libaio, libnuma, etc.)
#
# Uses Ubuntu 22.04 LTS as base because:
# - Represents a typical developer Linux system
# - Includes standard system libraries (libaio, etc.) that apps expect
# - More "batteries included" than minimal Debian images
# - Ships with ICU 70 which hostdb PostgreSQL binaries are compiled against
#   (Ubuntu 24.04 ships ICU 74 which is not ABI-compatible)
#
# Binary sourcing strategy:
# All database engines download complete, self-contained binaries from hostdb
# (https://github.com/robertjbass/hostdb). No database tools are pre-installed.
#
# NOT pre-installed (SpinDB downloads from hostdb automatically):
# - PostgreSQL: server + client tools (psql, pg_dump, pg_restore)
# - MySQL: server + client tools (mysql, mysqldump, mysqladmin)
# - MariaDB: server + client tools (mariadb, mariadb-dump, mariadb-admin)
# - MongoDB: server + client tools (mongod, mongosh, mongodump, mongorestore)
# - Redis: server + client tools (redis-server, redis-cli)
# - Valkey: server + client tools (valkey-server, valkey-cli)
# - ClickHouse: clickhouse (unified binary with subcommands)
# - SQLite: sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync
# - DuckDB: duckdb

FROM ubuntu:22.04

# Prevent interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 22.x LTS and basic tools
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install additional tools needed for SpinDB/tests
# binutils: provides 'ar' for extracting .deb archives (standard Unix tool)
# xz-utils: provides 'xz' for .tar.xz decompression (standard Unix tool)
# libnuma1: NUMA library required by Percona PostgreSQL builds
# libaio1: async I/O library required by MySQL
# libncurses6: terminal library required by MariaDB client
# libxml2: XML library required by PostgreSQL (hostdb binaries compiled with XML support)
# libicu70: ICU library required by PostgreSQL (Ubuntu 22.04 ships ICU 70)
# sudo: needed for non-root user to run privileged commands
# lsof: needed by SpinDB's findProcessByPort() to detect running database processes
RUN apt-get update && apt-get install -y \
    git \
    procps \
    jq \
    binutils \
    xz-utils \
    libnuma1 \
    libaio1 \
    libncurses6 \
    libxml2 \
    libicu70 \
    sudo \
    lsof \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm (pinned for reproducible builds)
ARG PNPM_VERSION=9.14.2
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Create non-root user for running databases
# PostgreSQL initdb refuses to run as root for security reasons
RUN useradd -m -s /bin/bash spindb \
    && echo "spindb ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Set up pnpm global bin directory for spindb user
ENV PNPM_HOME="/home/spindb/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Set CI=true so SpinDB knows sudo is passwordless
ENV CI=true

# Copy SpinDB source and set ownership
COPY --chown=spindb:spindb . /home/spindb/spindb

# Switch to non-root user
USER spindb
WORKDIR /home/spindb/spindb

# Create pnpm directories
RUN mkdir -p $PNPM_HOME

# Install dependencies
RUN pnpm install --frozen-lockfile

# Link globally so 'spindb' command works
RUN pnpm link --global

# Set working directory for tests
WORKDIR /home/spindb

# Run the E2E test script, allowing engine filter to be passed as argument
# Usage: docker run --rm spindb-e2e [engine]
# Examples:
#   docker run --rm spindb-e2e           # Run all tests
#   docker run --rm spindb-e2e clickhouse # Run only ClickHouse tests
ENTRYPOINT ["bash", "/home/spindb/spindb/tests/docker/run-e2e.sh"]
CMD []
