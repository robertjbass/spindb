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
# Uses Ubuntu LTS as base because:
# - Represents a typical developer Linux system
# - Includes standard system libraries (libaio, etc.) that apps expect
# - More "batteries included" than minimal Debian images
#
# Binary sourcing strategy:
# All database engines download complete, self-contained binaries from hostdb
# (https://github.com/robertjbass/hostdb). No database tools are pre-installed.
#
# Only pre-installs:
# - sqlite3: SQLite engine uses system binary by design (commonly pre-installed)
#
# NOT pre-installed (SpinDB downloads from hostdb automatically):
# - PostgreSQL: server + client tools (psql, pg_dump, pg_restore)
# - MySQL: server + client tools (mysql, mysqldump, mysqladmin)
# - MariaDB: server + client tools (mariadb, mariadb-dump, mariadb-admin)
# - MongoDB: server + client tools (mongod, mongosh, mongodump, mongorestore)
# - Redis: server + client tools (redis-server, redis-cli)

FROM ubuntu:24.04

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
# sqlite3: SQLite engine uses system binary by design
# libnuma1: NUMA library required by Percona PostgreSQL builds
# libaio1: async I/O library required by MySQL
# libncurses6: terminal library required by MariaDB client
# sudo: needed for non-root user to run privileged commands
RUN apt-get update && apt-get install -y \
    git \
    procps \
    jq \
    binutils \
    xz-utils \
    sqlite3 \
    libnuma1 \
    libaio1t64 \
    libncurses6 \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Create compatibility symlink for MySQL
# Ubuntu 24.04 renamed libaio package to libaio1t64 which creates libaio.so.1t64
# MySQL binaries are compiled against the old library name (libaio.so.1)
RUN ln -sf /lib/aarch64-linux-gnu/libaio.so.1t64 /lib/aarch64-linux-gnu/libaio.so.1 2>/dev/null || \
    ln -sf /lib/x86_64-linux-gnu/libaio.so.1t64 /lib/x86_64-linux-gnu/libaio.so.1 2>/dev/null || true

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

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

# Default command runs the E2E test script
CMD ["bash", "/home/spindb/spindb/tests/docker/run-e2e.sh"]
