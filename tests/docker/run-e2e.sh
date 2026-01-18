#!/bin/bash
# SpinDB Docker Linux Edge Case Test Script
#
# PURPOSE: Verify hostdb binaries work on minimal Linux systems.
# Tests library dependencies (libaio, libnuma, libncurses) and
# platform-specific edge cases that can't be caught on macOS/Windows.
#
# This script runs in a clean Ubuntu container to catch issues like:
# - Missing shared libraries
# - Library version incompatibilities (e.g., libaio.so.1 vs libaio.so.1t64)
# - Permission issues with binary execution
# - Path resolution problems

set -e

echo "════════════════════════════════════════════════════════════════"
echo "  SpinDB Docker Linux Edge Case Tests"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Environment:"
echo "  Node: $(node --version)"
echo "  pnpm: $(pnpm --version)"
echo "  Platform: $(uname -s) $(uname -m)"
echo "  SpinDB: $(spindb version 2>/dev/null || echo 'not installed')"
echo ""

# Ensure clean state
echo "=== Ensuring clean state ==="
rm -rf ~/.spindb 2>/dev/null || true
echo "Clean state confirmed"
echo ""

# Check library dependencies are available
echo "=== Checking library dependencies ==="
check_lib() {
  local lib=$1
  if ldconfig -p | grep -q "$lib"; then
    echo "  ✓ $lib found"
  else
    echo "  ⚠ $lib NOT found (may cause issues)"
  fi
}

check_lib "libaio"
check_lib "libnuma"
check_lib "libncurses"
check_lib "libssl"
check_lib "libcrypto"
check_lib "libxml2"
check_lib "libicui18n"
check_lib "libicuuc"
echo ""

# Configurable timeouts (can be overridden via environment)
STARTUP_TIMEOUT=${STARTUP_TIMEOUT:-60}  # seconds to wait for container startup

# Test counters and results tracking
PASSED=0
FAILED=0
declare -a RESULTS_ENGINE
declare -a RESULTS_VERSION
declare -a RESULTS_STATUS
declare -a RESULTS_ERROR

# Record test result
record_result() {
  local engine=$1
  local version=$2
  local status=$3
  local error=${4:-""}

  RESULTS_ENGINE+=("$engine")
  RESULTS_VERSION+=("$version")
  RESULTS_STATUS+=("$status")
  RESULTS_ERROR+=("$error")
}

# Test function
run_test() {
  local engine=$1
  local version=$2
  local container_name="test_${engine}_$$"

  echo ""
  echo "=== Testing $engine v$version ==="

  # Download engine from hostdb
  echo "Downloading $engine $version..."
  if ! spindb engines download "$engine" "$version"; then
    echo "FAILED: Could not download $engine $version"
    record_result "$engine" "$version" "FAILED" "Download failed"
    FAILED=$((FAILED+1))
    return 1
  fi
  echo "Download complete"

  # Create container
  echo "Creating container: $container_name"
  if ! spindb create "$container_name" --engine "$engine" --db-version "$version" --no-start; then
    echo "FAILED: Could not create $container_name"
    record_result "$engine" "$version" "FAILED" "Create failed"
    FAILED=$((FAILED+1))
    return 1
  fi

  # Start container (skip for sqlite/duckdb - they're file-based, no server process)
  if [ "$engine" != "sqlite" ] && [ "$engine" != "duckdb" ]; then
    echo "Starting container..."
    if ! spindb start "$container_name"; then
      echo "FAILED: Could not start $container_name"
      spindb delete "$container_name" --yes 2>/dev/null || true
      record_result "$engine" "$version" "FAILED" "Start failed"
      FAILED=$((FAILED+1))
      return 1
    fi

    # Poll for running status (configurable timeout via STARTUP_TIMEOUT env var)
    echo "Waiting for container to start (timeout: ${STARTUP_TIMEOUT}s)..."
    local status="unknown"
    local spindb_output=""
    for i in $(seq 1 "$STARTUP_TIMEOUT"); do
      # Capture both stdout and exit status
      if spindb_output=$(spindb info "$container_name" --json 2>&1); then
        # Command succeeded, parse status
        status=$(echo "$spindb_output" | jq -r '.status' 2>/dev/null || echo "parse_error")
        [ "$status" = "running" ] && break
      else
        # Command itself failed - log warning but keep retrying
        # (container might still be initializing)
        [ $((i % 10)) -eq 0 ] && echo "  Still waiting... ($i/${STARTUP_TIMEOUT}s)"
        status="command_error"
      fi
      sleep 1
    done

    # If we exited the loop due to repeated spindb failures, log the last output
    if [ "$status" = "command_error" ]; then
      echo "WARNING: spindb info failed repeatedly after ${STARTUP_TIMEOUT}s. Last output: $spindb_output"
    fi

    # Verify container is running
    echo "Verifying container status..."
    if [ "$status" != "running" ]; then
      echo "FAILED: Container status is '$status', expected 'running'"
      spindb stop "$container_name" 2>/dev/null || true
      spindb delete "$container_name" --yes 2>/dev/null || true
      record_result "$engine" "$version" "FAILED" "Status: $status"
      FAILED=$((FAILED+1))
      return 1
    fi
  fi

  # Run a simple query to verify database is working
  echo "Testing database connectivity..."
  case $engine in
    postgresql)
      if ! spindb run "$container_name" -c "SELECT 1 as test;"; then
        echo "FAILED: Could not run PostgreSQL query"
        spindb stop "$container_name" 2>/dev/null || true
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "Query failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
    mysql|mariadb)
      if ! spindb run "$container_name" -c "SELECT 1 as test;"; then
        echo "FAILED: Could not run $engine query"
        spindb stop "$container_name" 2>/dev/null || true
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "Query failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
    mongodb)
      if ! spindb run "$container_name" -c "db.runCommand({ping: 1})"; then
        echo "FAILED: Could not run MongoDB command"
        spindb stop "$container_name" 2>/dev/null || true
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "Ping failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
    redis)
      if ! spindb run "$container_name" -c "PING"; then
        echo "FAILED: Could not run Redis command"
        spindb stop "$container_name" 2>/dev/null || true
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "PING failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
    valkey)
      if ! spindb run "$container_name" -c "PING"; then
        echo "FAILED: Could not run Valkey command"
        spindb stop "$container_name" 2>/dev/null || true
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "PING failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
    sqlite)
      if ! spindb run "$container_name" -c "SELECT 1 as test;"; then
        echo "FAILED: Could not run SQLite query"
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "Query failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
    duckdb)
      if ! spindb run "$container_name" -c "SELECT 1 as test;"; then
        echo "FAILED: Could not run DuckDB query"
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "Query failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
    clickhouse)
      if ! spindb run "$container_name" -c "SELECT 1 as test;"; then
        echo "FAILED: Could not run ClickHouse query"
        spindb stop "$container_name" 2>/dev/null || true
        spindb delete "$container_name" --yes 2>/dev/null || true
        record_result "$engine" "$version" "FAILED" "Query failed"
        FAILED=$((FAILED+1))
        return 1
      fi
      ;;
  esac

  # Stop container (skip for sqlite/duckdb - they're embedded)
  if [ "$engine" != "sqlite" ] && [ "$engine" != "duckdb" ]; then
    echo "Stopping container..."
    if ! spindb stop "$container_name"; then
      echo "WARNING: Could not stop $container_name gracefully"
    fi
  fi

  # Delete container
  echo "Cleaning up..."
  if ! spindb delete "$container_name" --yes; then
    echo "WARNING: Could not delete $container_name"
  fi

  echo "PASSED: $engine v$version"
  record_result "$engine" "$version" "PASSED" ""
  PASSED=$((PASSED+1))
  return 0
}

# Get default versions from engines.json
get_default_version() {
  local engine=$1
  spindb engines supported --json 2>/dev/null | jq -r ".engines.$engine.defaultVersion" 2>/dev/null || echo ""
}

# Print results table
# Uses column -t -s '|' to handle Unicode characters (✓/✗) correctly
print_results_table() {
  echo ""
  # Build table with pipe separators, then format with column
  {
    echo "Engine|Version|Status|Error"
    echo "------|-------|------|-----"
    for i in "${!RESULTS_ENGINE[@]}"; do
      local engine="${RESULTS_ENGINE[$i]}"
      local version="${RESULTS_VERSION[$i]}"
      local status="${RESULTS_STATUS[$i]}"
      local error="${RESULTS_ERROR[$i]}"

      # Add status indicator
      if [ "$status" = "PASSED" ]; then
        status="✓ PASS"
      else
        status="✗ FAIL"
      fi

      # Truncate error if too long
      if [ ${#error} -gt 15 ]; then
        error="${error:0:12}..."
      fi

      printf "%s|%s|%s|%s\n" "$engine" "$version" "$status" "$error"
    done
  } | if command -v column &>/dev/null; then
    column -t -s '|'
  else
    # Fallback: simple table without column alignment
    while IFS='|' read -r c1 c2 c3 c4; do
      printf "%-12s %-10s %-10s %s\n" "$c1" "$c2" "$c3" "$c4"
    done
  fi
}

# Run tests for each engine
echo "=== Running E2E Tests ==="

# PostgreSQL
PG_VERSION=$(get_default_version postgresql)
[ -n "$PG_VERSION" ] && run_test postgresql "$PG_VERSION" || echo "Skipping PostgreSQL (no default version)"

# MySQL
MYSQL_VERSION=$(get_default_version mysql)
[ -n "$MYSQL_VERSION" ] && run_test mysql "$MYSQL_VERSION" || echo "Skipping MySQL (no default version)"

# MariaDB
MARIADB_VERSION=$(get_default_version mariadb)
[ -n "$MARIADB_VERSION" ] && run_test mariadb "$MARIADB_VERSION" || echo "Skipping MariaDB (no default version)"

# SQLite
SQLITE_VERSION=$(get_default_version sqlite)
[ -n "$SQLITE_VERSION" ] && run_test sqlite "$SQLITE_VERSION" || echo "Skipping SQLite (no default version)"

# MongoDB
MONGODB_VERSION=$(get_default_version mongodb)
[ -n "$MONGODB_VERSION" ] && run_test mongodb "$MONGODB_VERSION" || echo "Skipping MongoDB (no default version)"

# Redis
REDIS_VERSION=$(get_default_version redis)
[ -n "$REDIS_VERSION" ] && run_test redis "$REDIS_VERSION" || echo "Skipping Redis (no default version)"

# Valkey
VALKEY_VERSION=$(get_default_version valkey)
[ -n "$VALKEY_VERSION" ] && run_test valkey "$VALKEY_VERSION" || echo "Skipping Valkey (no default version)"

# ClickHouse
CLICKHOUSE_VERSION=$(get_default_version clickhouse)
[ -n "$CLICKHOUSE_VERSION" ] && run_test clickhouse "$CLICKHOUSE_VERSION" || echo "Skipping ClickHouse (no default version)"

# DuckDB
DUCKDB_VERSION=$(get_default_version duckdb)
[ -n "$DUCKDB_VERSION" ] && run_test duckdb "$DUCKDB_VERSION" || echo "Skipping DuckDB (no default version)"

# Summary
echo ""
echo "═══════════════════════════════════════════════════════"
echo "                  E2E TEST RESULTS                      "
echo "═══════════════════════════════════════════════════════"

print_results_table

echo ""
echo "Summary: $PASSED passed, $FAILED failed"
echo ""

if [ $FAILED -gt 0 ]; then
  echo "❌ SOME TESTS FAILED"
  exit 1
else
  echo "✅ ALL TESTS PASSED"
  exit 0
fi
