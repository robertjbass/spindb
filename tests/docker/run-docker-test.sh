#!/bin/bash
# Wrapper script for running SpinDB Docker E2E tests
#
# Usage:
#   ./run-docker-test.sh           # Run all tests
#   ./run-docker-test.sh clickhouse # Run only ClickHouse tests
#   ./run-docker-test.sh postgresql # Run only PostgreSQL tests
#
# Valid engines: postgresql mysql mariadb sqlite mongodb ferretdb redis valkey clickhouse
#                duckdb qdrant meilisearch couchdb cockroachdb surrealdb questdb typedb
#                influxdb weaviate tigerbeetle
#
# Security note: Runs with --security-opt seccomp=unconfined because TigerBeetle
# requires io_uring syscalls which Docker's default seccomp profile blocks.
# This is safe for E2E tests (isolated, ephemeral containers) and does not affect
# the host. TigerBeetle works fine on regular Linux systems — the restriction is
# Docker-specific. See: https://docs.docker.com/engine/security/seccomp/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Cleanup function to remove Docker artifacts
cleanup() {
  echo ""
  echo "Cleaning up Docker artifacts..."
  docker rmi spindb-e2e 2>/dev/null || true
  # Remove dangling images (old layers from previous builds)
  docker image prune -f 2>/dev/null || true
  # Remove build cache to reclaim disk space
  docker builder prune -f 2>/dev/null || true
}

# Ensure cleanup runs on exit (success or failure)
trap cleanup EXIT

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Skip "--" if passed (pnpm passes it literally)
if [ "${1:-}" = "--" ]; then
  shift
fi

ENGINE_FILTER="${1:-}"

echo "Building Docker image..."
docker build -t spindb-e2e -f "$SCRIPT_DIR/Dockerfile" "$PROJECT_ROOT"

# --security-opt seccomp=unconfined: Required for TigerBeetle which uses io_uring.
# Docker's default seccomp profile blocks io_uring_* syscalls. This only affects
# the test container (ephemeral, no network exposure, no persistent state).
DOCKER_RUN=(docker run --rm --security-opt seccomp=unconfined)

echo ""
echo "Running E2E tests..."
if [ -n "$ENGINE_FILTER" ]; then
  "${DOCKER_RUN[@]}" spindb-e2e "$ENGINE_FILTER"
else
  "${DOCKER_RUN[@]}" spindb-e2e
fi

# Cleanup is handled by the trap on EXIT
