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
# NOT pre-installed (SpinDB downloads from hostdb automatically):
# - PostgreSQL: server + client tools (psql, pg_dump, pg_restore)
# - MySQL: server + client tools (mysql, mysqldump, mysqladmin)
# - MariaDB: server + client tools (mariadb, mariadb-dump, mariadb-admin)
# - MongoDB: server + client tools (mongod, mongosh, mongodump, mongorestore)
# - Redis: server + client tools (redis-server, redis-cli)
# - SQLite: sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync

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
# libnuma1: NUMA library required by Percona PostgreSQL builds
# libaio1: async I/O library required by MySQL
# libncurses6: terminal library required by MariaDB client
# libxml2: XML library required by PostgreSQL (hostdb binaries compiled with XML support)
# libicu74: ICU library - PostgreSQL needs ICU 70 but Ubuntu 24.04 ships ICU 74
#           We create symlinks (libicui18n.so.70 -> .74, etc.) below for compatibility
# sudo: needed for non-root user to run privileged commands
RUN apt-get update && apt-get install -y \
    git \
    procps \
    jq \
    binutils \
    xz-utils \
    libnuma1 \
    libaio1t64 \
    libncurses6 \
    libxml2 \
    libicu74 \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Create compatibility symlink for MySQL
# Ubuntu 24.04 renamed libaio package to libaio1t64 which creates libaio.so.1t64
# MySQL binaries are compiled against the old library name (libaio.so.1)
# Only create symlink if the source .1t64 file exists (architecture-dependent)
RUN set -e && \
    if test -e /lib/aarch64-linux-gnu/libaio.so.1t64; then \
      ln -sf /lib/aarch64-linux-gnu/libaio.so.1t64 /lib/aarch64-linux-gnu/libaio.so.1; \
    elif test -e /lib/x86_64-linux-gnu/libaio.so.1t64; then \
      ln -sf /lib/x86_64-linux-gnu/libaio.so.1t64 /lib/x86_64-linux-gnu/libaio.so.1; \
    else \
      echo "ERROR: libaio.so.1t64 source file not found - libaio1t64 package may not be installed" && exit 1; \
    fi && \
    (test -e /lib/aarch64-linux-gnu/libaio.so.1 -o -e /lib/x86_64-linux-gnu/libaio.so.1 || \
     (echo "ERROR: libaio.so.1 symlink not created - MySQL may fail to start" && exit 1))

# Create compatibility symlinks for PostgreSQL ICU libraries
# hostdb PostgreSQL binaries are compiled against ICU 70 (libicui18n.so.70, etc.)
# Ubuntu 24.04 ships with ICU 74 (libicui18n.so.74, etc.)
# Create symlinks from ICU 74 to ICU 70 names so PostgreSQL can find them
# Note: ICU major versions are generally ABI-compatible for basic usage
RUN set -e && \
    LIBDIR="" && \
    if test -d /usr/lib/aarch64-linux-gnu; then \
      LIBDIR=/usr/lib/aarch64-linux-gnu; \
    elif test -d /usr/lib/x86_64-linux-gnu; then \
      LIBDIR=/usr/lib/x86_64-linux-gnu; \
    else \
      echo "ERROR: Could not find system library directory" && exit 1; \
    fi && \
    for lib in libicui18n libicuuc libicudata; do \
      if test -e "$LIBDIR/${lib}.so.74"; then \
        ln -sf "$LIBDIR/${lib}.so.74" "$LIBDIR/${lib}.so.70"; \
        echo "Created symlink: ${lib}.so.70 -> ${lib}.so.74"; \
      else \
        echo "WARNING: $LIBDIR/${lib}.so.74 not found"; \
      fi; \
    done

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

# Default command runs the E2E test script
CMD ["bash", "/home/spindb/spindb/tests/docker/run-e2e.sh"]
