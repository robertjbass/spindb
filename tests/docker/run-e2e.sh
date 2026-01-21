#!/bin/bash
# SpinDB Docker Linux E2E Test Script
#
# PURPOSE: Verify hostdb binaries work on minimal Linux systems.
# Catches library dependency issues that wouldn't appear on well-provisioned systems.
#
# MODES:
#   SMOKE TEST (default, SMOKE_TEST=true): ~5-7 minutes
#     - Downloads binaries, starts containers, runs basic query, cleans up
#     - Validates library dependencies work (the primary purpose of this test)
#     - Skips: backup/restore, rename, clone, self-update (covered by other CI jobs)
#
#   FULL TEST (SMOKE_TEST=false): ~26 minutes
#     - All phases: download, lifecycle, backup/restore, rename, clone, self-update
#     - Useful for comprehensive local testing
#
# Usage:
#   ./run-e2e.sh                         # Smoke test all engines
#   ./run-e2e.sh postgresql              # Smoke test PostgreSQL only
#   SMOKE_TEST=false ./run-e2e.sh        # Full test all engines
#   SMOKE_TEST=false ./run-e2e.sh postgresql  # Full test PostgreSQL only

set -e

# ============================================================================
# CONFIGURATION
# ============================================================================

# Parse command line arguments
ENGINE_FILTER="${1:-}"
VERBOSE="${VERBOSE:-false}"
# Smoke test mode: only download + start + query + cleanup (skip backup/restore/rename/clone)
# Set SMOKE_TEST=false for full test with all phases
SMOKE_TEST="${SMOKE_TEST:-true}"

# Valid engines and utility tests
VALID_ENGINES="postgresql mysql mariadb sqlite mongodb redis valkey clickhouse duckdb"
VALID_UTILITY_TESTS="self-update"
VALID_ALL="$VALID_ENGINES $VALID_UTILITY_TESTS"

# Validate filter (accepts engine names OR utility test names)
if [ -n "$ENGINE_FILTER" ]; then
  if ! echo "$VALID_ALL" | grep -qw "$ENGINE_FILTER"; then
    echo "Error: Invalid test '$ENGINE_FILTER'"
    echo "Valid engines: $VALID_ENGINES"
    echo "Valid utility tests: $VALID_UTILITY_TESTS"
    exit 1
  fi
fi

# Timeouts
STARTUP_TIMEOUT=${STARTUP_TIMEOUT:-60}

# Directories
BACKUP_DIR=$(mktemp -d)

# Track current container for cleanup on interrupt
CURRENT_CONTAINER=""

# Track if we created a temp SPINDB_HOME (for cleanup)
CREATED_TEMP_SPINDB_HOME=""

# Cleanup function for graceful exit
cleanup() {
  local exit_code=$?
  echo ""
  echo "Cleaning up..."

  # Stop and delete any running test container
  if [ -n "$CURRENT_CONTAINER" ]; then
    spindb stop "$CURRENT_CONTAINER" &>/dev/null || true
    spindb delete "$CURRENT_CONTAINER" --yes &>/dev/null || true
  fi

  # Clean up backup directory
  rm -rf "$BACKUP_DIR" 2>/dev/null || true

  # Clean up temp SPINDB_HOME if we created one (non-CI mode)
  if [ -n "$CREATED_TEMP_SPINDB_HOME" ]; then
    rm -rf "$CREATED_TEMP_SPINDB_HOME" 2>/dev/null || true
  fi

  exit $exit_code
}

# Handle interrupts gracefully
handle_interrupt() {
  # Disable further signal handling to prevent recursion
  trap - INT TERM
  echo ""
  echo "Interrupted by user"
  # Kill any child processes - try pkill first, fall back to process group kill
  if command -v pkill >/dev/null 2>&1; then
    pkill -P $$ 2>/dev/null || true
  else
    # Fall back to killing the process group (works on minimal systems without pkill)
    # Get our process group ID and kill all processes in it except ourselves
    local pgid
    pgid=$(ps -o pgid= $$ 2>/dev/null | tr -d ' ')
    if [ -n "$pgid" ] && [ "$pgid" != "$$" ]; then
      kill -TERM -"$pgid" 2>/dev/null || true
    fi
  fi
  exit 130
}
trap handle_interrupt INT TERM
trap cleanup EXIT
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/../fixtures"

# Expected counts and backup formats
# Format names are engine-specific semantic names (no longer sql|dump for all)
declare -A EXPECTED_COUNTS=(
  [postgresql]=5 [mysql]=5 [mariadb]=5 [mongodb]=5
  [redis]=6 [valkey]=6 [clickhouse]=5 [sqlite]=5 [duckdb]=5
)
declare -A BACKUP_FORMATS=(
  [postgresql]="sql|custom"
  [mysql]="sql|compressed"
  [mariadb]="sql|compressed"
  [mongodb]="bson|archive"
  [redis]="text|rdb"
  [valkey]="text|rdb"
  [clickhouse]="sql"
  [sqlite]="sql|binary"
  [duckdb]="sql|binary"
)

# Results tracking
PASSED=0
FAILED=0
declare -a RESULTS_ENGINE RESULTS_VERSION RESULTS_STATUS RESULTS_ERROR RESULTS_DETAILS

# ============================================================================
# LOGGING UTILITIES
# ============================================================================

# Colors (detect if terminal supports colors)
if [ -t 1 ] && command -v tput &>/dev/null; then
  RED=$(tput setaf 1)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  BLUE=$(tput setaf 4)
  MAGENTA=$(tput setaf 5)
  CYAN=$(tput setaf 6)
  DIM=$(tput dim)
  BOLD=$(tput bold)
  RESET=$(tput sgr0)
else
  RED="" GREEN="" YELLOW="" BLUE="" MAGENTA="" CYAN="" DIM="" BOLD="" RESET=""
fi

# Logging functions
log_header() {
  echo ""
  echo "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo "${BOLD}${CYAN}  $1${RESET}"
  echo "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

log_section() {
  echo ""
  echo "${BOLD}▸ $1${RESET}"
}

log_step() {
  printf "  ${DIM}%-50s${RESET}" "$1"
}

log_step_ok() {
  echo " ${GREEN}✓${RESET}"
}

log_step_fail() {
  echo " ${RED}✗${RESET}"
}

log_step_skip() {
  echo " ${YELLOW}○${RESET}"
}

log_step_result() {
  local status=$1
  local detail=${2:-}
  if [ "$status" = "ok" ]; then
    if [ -n "$detail" ]; then
      echo " ${GREEN}✓${RESET} ${DIM}($detail)${RESET}"
    else
      echo " ${GREEN}✓${RESET}"
    fi
  elif [ "$status" = "fail" ]; then
    if [ -n "$detail" ]; then
      echo " ${RED}✗ $detail${RESET}"
    else
      echo " ${RED}✗${RESET}"
    fi
  elif [ "$status" = "skip" ]; then
    echo " ${YELLOW}○${RESET} ${DIM}skipped${RESET}"
  fi
}

log_detail() {
  echo "    ${DIM}$1${RESET}"
}

log_error() {
  echo "  ${RED}ERROR: $1${RESET}"
}

log_warning() {
  echo "  ${YELLOW}WARNING: $1${RESET}"
}

log_success() {
  echo "  ${GREEN}$1${RESET}"
}

log_verbose() {
  if [ "$VERBOSE" = "true" ]; then
    echo "    ${DIM}$1${RESET}"
  fi
}

# Engine result summary
print_engine_result() {
  local engine=$1
  local version=$2
  local status=$3
  local error=${4:-}

  echo ""
  echo "${DIM}************************************************************${RESET}"
  echo ""
  if [ "$status" = "PASSED" ]; then
    echo "  ${GREEN}${BOLD}✓ $engine v$version PASSED${RESET}"
  else
    echo "  ${RED}${BOLD}✗ $engine v$version FAILED${RESET}"
    if [ -n "$error" ]; then
      echo "  ${RED}Reason: $error${RESET}"
    fi
  fi
  echo ""
  echo "${DIM}************************************************************${RESET}"
}

# ============================================================================
# RECORD RESULTS
# ============================================================================

record_result() {
  local engine=$1 version=$2 status=$3 error=${4:-""} details=${5:-""}
  RESULTS_ENGINE+=("$engine")
  RESULTS_VERSION+=("$version")
  RESULTS_STATUS+=("$status")
  RESULTS_ERROR+=("$error")
  RESULTS_DETAILS+=("$details")
}

# ============================================================================
# DATA LIFECYCLE HELPERS
# ============================================================================

# Store last error for display
LAST_ERROR=""

# Run command and capture error on failure
run_cmd() {
  local output
  if output=$("$@" 2>&1); then
    return 0
  else
    LAST_ERROR="$output"
    return 1
  fi
}

insert_seed_data() {
  local engine=$1 container_name=$2
  local seed_file=""

  case $engine in
    postgresql)
      spindb run "$container_name" -c "CREATE DATABASE testdb;" -d postgres &>/dev/null || true
      seed_file="$FIXTURES_DIR/$engine/seeds/sample-db.sql"
      ;;
    mysql|mariadb)
      spindb run "$container_name" -c "CREATE DATABASE IF NOT EXISTS testdb;" -d mysql &>/dev/null || true
      seed_file="$FIXTURES_DIR/$engine/seeds/sample-db.sql"
      ;;
    clickhouse)
      spindb run "$container_name" -c "CREATE DATABASE IF NOT EXISTS testdb;" -d default &>/dev/null || true
      seed_file="$FIXTURES_DIR/$engine/seeds/sample-db.sql"
      ;;
    sqlite|duckdb)
      seed_file="$FIXTURES_DIR/$engine/seeds/sample-db.sql"
      ;;
    mongodb)
      seed_file="$FIXTURES_DIR/mongodb/seeds/sample-db.js"
      ;;
    redis)
      seed_file="$FIXTURES_DIR/redis/seeds/sample-db.redis"
      ;;
    valkey)
      seed_file="$FIXTURES_DIR/valkey/seeds/sample-db.valkey"
      ;;
  esac

  if [ ! -f "$seed_file" ]; then
    LAST_ERROR="Seed file not found: $seed_file"
    return 1
  fi

  case $engine in
    sqlite|duckdb|redis|valkey)
      run_cmd spindb run "$container_name" "$seed_file"
      ;;
    *)
      run_cmd spindb run "$container_name" "$seed_file" -d testdb
      ;;
  esac
}

get_data_count() {
  local engine=$1 container_name=$2 database=${3:-testdb}
  local output
  local error_output
  case $engine in
    postgresql|mysql|mariadb|clickhouse)
      output=$(spindb run "$container_name" -c "SELECT COUNT(*) FROM test_user;" -d "$database" 2>/dev/null)
      # Extract number from output (handles various formats with whitespace)
      echo "$output" | grep -oE '[0-9]+' | head -1
      ;;
    sqlite)
      # SQLite outputs plain number
      output=$(spindb run "$container_name" -c "SELECT COUNT(*) FROM test_user;" 2>/dev/null)
      echo "$output" | grep -oE '[0-9]+' | head -1
      ;;
    duckdb)
      # DuckDB outputs a table with box drawing chars, extract the count from data row
      # Find lines that contain a standalone integer (not "int64" header)
      output=$(spindb run "$container_name" -c "SELECT COUNT(*) FROM test_user;" 2>/dev/null)
      local count=""
      # Match lines with optional borders/whitespace around a number, excluding header
      count=$(echo "$output" | grep -v 'int64' | grep -oE '(^|[^0-9])[0-9]+([^0-9]|$)' | grep -oE '[0-9]+' | head -1)
      # If parsing fails, log output for debugging (only when VERBOSE) and return empty
      if [ -z "$count" ] && [ "$VERBOSE" = "true" ]; then
        echo "DEBUG: DuckDB output parsing failed. Raw output:" >&2
        echo "$output" >&2
      fi
      echo "$count"
      ;;
    mongodb)
      output=$(spindb run "$container_name" -c "db.test_user.countDocuments()" -d "$database" 2>/dev/null)
      echo "$output" | grep -oE '[0-9]+' | head -1
      ;;
    redis|valkey)
      output=$(spindb run "$container_name" -c "DBSIZE" -d "$database" 2>/dev/null)
      echo "$output" | grep -oE '[0-9]+' | head -1
      ;;
  esac
}

# Map format name to file extension (engine-specific)
# Based on config/backup-formats.ts with semantic format names
get_backup_extension() {
  local engine=$1 format=$2
  case $engine in
    postgresql)
      case $format in
        sql) echo ".sql" ;;
        custom) echo ".dump" ;;
      esac
      ;;
    mysql|mariadb)
      case $format in
        sql) echo ".sql" ;;
        compressed) echo ".sql.gz" ;;
      esac
      ;;
    sqlite)
      case $format in
        sql) echo ".sql" ;;
        binary) echo ".sqlite" ;;
      esac
      ;;
    duckdb)
      case $format in
        sql) echo ".sql" ;;
        binary) echo ".duckdb" ;;
      esac
      ;;
    mongodb)
      case $format in
        bson) echo "" ;;  # directory (BSON)
        archive) echo ".archive" ;;
      esac
      ;;
    redis)
      case $format in
        text) echo ".redis" ;;
        rdb) echo ".rdb" ;;
      esac
      ;;
    valkey)
      case $format in
        text) echo ".valkey" ;;
        rdb) echo ".rdb" ;;
      esac
      ;;
    clickhouse)
      echo ".sql" ;;
    *)
      echo ".$format" ;;
  esac
}

# Get full backup file path
get_backup_path() {
  local engine=$1 container_name=$2 format=$3
  local ext=$(get_backup_extension "$engine" "$format")
  echo "$BACKUP_DIR/${container_name}_backup${ext}"
}

create_backup() {
  local engine=$1 container_name=$2 format=$3
  local backup_name="${container_name}_backup"

  case $engine in
    postgresql|mysql|mariadb|clickhouse|mongodb)
      run_cmd spindb backup "$container_name" -d testdb --format "$format" -o "$BACKUP_DIR" -n "$backup_name"
      ;;
    redis|valkey)
      # Redis/Valkey: sql format = text commands (.redis/.valkey), dump format = RDB snapshot (.rdb)
      run_cmd spindb backup "$container_name" -d 0 --format "$format" -o "$BACKUP_DIR" -n "$backup_name"
      ;;
    sqlite|duckdb)
      run_cmd spindb backup "$container_name" --format "$format" -o "$BACKUP_DIR" -n "$backup_name"
      ;;
  esac
}

create_restore_target() {
  local engine=$1 container_name=$2
  case $engine in
    postgresql)
      run_cmd spindb run "$container_name" -c "CREATE DATABASE restored_db;" -d postgres
      ;;
    mysql|mariadb)
      run_cmd spindb run "$container_name" -c "CREATE DATABASE restored_db;" -d mysql
      ;;
    clickhouse)
      run_cmd spindb run "$container_name" -c "CREATE DATABASE IF NOT EXISTS restored_db;" -d default
      ;;
    sqlite|duckdb)
      local restored_container="restored_${container_name}"
      local restored_path="$BACKUP_DIR/restored_${engine}.db"
      run_cmd spindb create "$restored_container" --engine "$engine" --path "$restored_path" --no-start
      ;;
    *)
      # MongoDB, Redis, Valkey don't need explicit target creation
      return 0
      ;;
  esac
}

restore_backup() {
  local engine=$1 container_name=$2 format=$3
  local backup_file=$(get_backup_path "$engine" "$container_name" "$format")

  case $engine in
    postgresql|mysql|mariadb|clickhouse|mongodb)
      run_cmd spindb restore "$container_name" "$backup_file" -d restored_db --force
      ;;
    redis|valkey)
      # text format can be restored while running, rdb format requires stop/start
      if [ "$format" = "text" ]; then
        run_cmd spindb restore "$container_name" "$backup_file" -d 1 --force
      else
        spindb stop "$container_name" &>/dev/null || true
        # Wait for container to fully stop before restore
        local max_wait=30
        local waited=0
        while spindb info "$container_name" --json 2>/dev/null | grep -q '"status":"running"' && [ $waited -lt $max_wait ]; do
          sleep 1
          waited=$((waited + 1))
        done
        # Abort if stop timed out (container still running)
        if spindb info "$container_name" --json 2>/dev/null | grep -q '"status":"running"'; then
          echo "ERROR: Container $container_name did not stop within ${max_wait}s, cannot restore RDB"
          return 1
        fi
        if ! run_cmd spindb restore "$container_name" "$backup_file" --force; then
          return 1
        fi
        if ! run_cmd spindb start "$container_name"; then
          return 1
        fi
        # Give the container a moment to register as running
        sleep 2
        # Wait for container to be ready after start
        waited=0
        while ! spindb info "$container_name" --json 2>/dev/null | grep -q '"status":"running"' && [ $waited -lt $max_wait ]; do
          sleep 1
          waited=$((waited + 1))
        done
        # The container should be running by now - if not, just log for debugging
        # but don't fail since the data verification will catch actual issues
        if ! spindb info "$container_name" --json 2>/dev/null | grep -q '"status":"running"' && [ "$VERBOSE" = "true" ]; then
          log_verbose "Container $container_name status not 'running' after ${max_wait}s (may be false negative)"
        fi
      fi
      ;;
    sqlite|duckdb)
      local restored_container="restored_${container_name}"
      run_cmd spindb restore "$restored_container" "$backup_file" --force
      ;;
  esac
}

verify_restored_data() {
  local engine=$1 container_name=$2 format=$3
  local expected=${EXPECTED_COUNTS[$engine]}
  local actual=""

  case $engine in
    postgresql|mysql|mariadb|clickhouse|mongodb)
      actual=$(get_data_count "$engine" "$container_name" "restored_db")
      ;;
    redis|valkey)
      # text format restores to database 1, rdb format restores to database 0
      if [ "$format" = "text" ]; then
        actual=$(get_data_count "$engine" "$container_name" "1")
      else
        actual=$(get_data_count "$engine" "$container_name" "0")
      fi
      ;;
    sqlite|duckdb)
      actual=$(get_data_count "$engine" "restored_${container_name}")
      ;;
  esac

  actual=$(echo "$actual" | tr -d '[:space:]')
  [ "$actual" = "$expected" ]
}

# Same as verify_restored_data but echoes the actual count for debugging
verify_restored_data_with_count() {
  local engine=$1 container_name=$2 format=$3
  local expected=${EXPECTED_COUNTS[$engine]}
  local actual=""

  case $engine in
    postgresql|mysql|mariadb|clickhouse|mongodb)
      actual=$(get_data_count "$engine" "$container_name" "restored_db")
      ;;
    redis|valkey)
      # text format restores to database 1, rdb format restores to database 0
      if [ "$format" = "text" ]; then
        actual=$(get_data_count "$engine" "$container_name" "1")
      else
        actual=$(get_data_count "$engine" "$container_name" "0")
      fi
      ;;
    sqlite|duckdb)
      actual=$(get_data_count "$engine" "restored_${container_name}")
      ;;
  esac

  actual=$(echo "$actual" | tr -d '[:space:]')
  echo "$actual"
  [ "$actual" = "$expected" ]
}

cleanup_restore_target() {
  local engine=$1 container_name=$2
  case $engine in
    postgresql)
      spindb run "$container_name" -c "DROP DATABASE IF EXISTS restored_db;" -d postgres &>/dev/null || true
      ;;
    mysql|mariadb)
      spindb run "$container_name" -c "DROP DATABASE IF EXISTS restored_db;" -d mysql &>/dev/null || true
      ;;
    clickhouse)
      spindb run "$container_name" -c "DROP DATABASE IF EXISTS restored_db;" -d default &>/dev/null || true
      ;;
    sqlite|duckdb)
      spindb delete "restored_${container_name}" --yes &>/dev/null || true
      ;;
  esac
}

cleanup_data_lifecycle() {
  local engine=$1 container_name=$2
  case $engine in
    sqlite|duckdb)
      spindb delete "restored_${container_name}" --yes &>/dev/null || true
      ;;
  esac
  rm -rf "$BACKUP_DIR"/${container_name}_backup* &>/dev/null || true
}

# ============================================================================
# TEST BACKUP FORMAT
# ============================================================================

show_error_details() {
  if [ -n "$LAST_ERROR" ]; then
    echo ""
    echo "  ${RED}Error details:${RESET}"
    echo "$LAST_ERROR" | head -20 | sed 's/^/    /'
    echo ""
  fi
}

test_backup_format() {
  local engine=$1 container_name=$2 format=$3

  log_step "Backup ($format)"
  if ! create_backup "$engine" "$container_name" "$format"; then
    log_step_fail
    show_error_details
    return 1
  fi
  log_step_ok

  log_step "Create restore target"
  if ! create_restore_target "$engine" "$container_name"; then
    log_step_fail
    show_error_details
    return 1
  fi
  log_step_ok

  log_step "Restore ($format)"
  if ! restore_backup "$engine" "$container_name" "$format"; then
    log_step_fail
    show_error_details
    return 1
  fi
  log_step_ok

  log_step "Verify data integrity"
  local verify_result
  verify_result=$(verify_restored_data_with_count "$engine" "$container_name" "$format")
  local verify_status=$?
  if [ $verify_status -ne 0 ]; then
    log_step_result "fail" "got $verify_result, expected ${EXPECTED_COUNTS[$engine]}"
    return 1
  fi
  log_step_result "ok" "${EXPECTED_COUNTS[$engine]} records"

  # Cleanup for next format test
  cleanup_restore_target "$engine" "$container_name"
  return 0
}

# ============================================================================
# UTILITY TEST: SELF-UPDATE
# ============================================================================

run_self_update_test() {
  # Version to install before testing self-update. Override via OLD_VERSION env var.
  # Bump this default when older versions become incompatible with current tests.
  local old_version="${OLD_VERSION:-0.19.4}"
  local test_name="self-update"

  log_header "Self-Update Test"

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 1: Install old version
  # ─────────────────────────────────────────────────────────────────────────
  log_section "Install Old Version"

  log_step "Install spindb@$old_version via pnpm"
  if ! run_cmd pnpm add -g "spindb@$old_version"; then
    log_step_fail
    show_error_details
    record_result "$test_name" "$old_version" "FAILED" "Failed to install old version"
    print_engine_result "$test_name" "$old_version" "FAILED" "Failed to install old version"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_ok

  log_step "Verify installed version"
  local installed_version
  installed_version=$(spindb version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ "$installed_version" != "$old_version" ]; then
    log_step_result "fail" "got $installed_version, expected $old_version"
    pnpm remove -g spindb &>/dev/null || true
    record_result "$test_name" "$old_version" "FAILED" "Version mismatch after install"
    print_engine_result "$test_name" "$old_version" "FAILED" "Version mismatch after install"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_result "ok" "v$installed_version"

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 2: Run self-update
  # ─────────────────────────────────────────────────────────────────────────
  log_section "Run Self-Update"

  log_step "Execute spindb update -y"
  if ! run_cmd spindb update -y; then
    log_step_fail
    show_error_details
    pnpm remove -g spindb &>/dev/null || true
    record_result "$test_name" "$old_version" "FAILED" "Self-update command failed"
    print_engine_result "$test_name" "$old_version" "FAILED" "Self-update command failed"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_ok

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 3: Verify update
  # ─────────────────────────────────────────────────────────────────────────
  log_section "Verify Update"

  log_step "Check version changed"
  local new_version
  new_version=$(spindb version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

  if [ -z "$new_version" ]; then
    log_step_result "fail" "could not get version"
    pnpm remove -g spindb &>/dev/null || true
    record_result "$test_name" "$old_version" "FAILED" "Version check failed after update"
    print_engine_result "$test_name" "$old_version" "FAILED" "Version check failed after update"
    FAILED=$((FAILED+1))
    return 1
  fi

  if [ "$new_version" = "$old_version" ]; then
    log_step_result "fail" "still v$old_version"
    pnpm remove -g spindb &>/dev/null || true
    record_result "$test_name" "$old_version" "FAILED" "Version unchanged after update"
    print_engine_result "$test_name" "$old_version" "FAILED" "Version unchanged after update"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_result "ok" "v$old_version → v$new_version"

  log_step "Verify CLI still works"
  if ! spindb --help &>/dev/null; then
    log_step_fail
    pnpm remove -g spindb &>/dev/null || true
    record_result "$test_name" "$old_version" "FAILED" "CLI broken after update"
    print_engine_result "$test_name" "$old_version" "FAILED" "CLI broken after update"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_ok

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 4: Cleanup
  # ─────────────────────────────────────────────────────────────────────────
  log_section "Cleanup"

  log_step "Uninstall spindb"
  pnpm remove -g spindb &>/dev/null || true
  log_step_ok

  # ─────────────────────────────────────────────────────────────────────────
  # Success!
  # ─────────────────────────────────────────────────────────────────────────
  record_result "$test_name" "$old_version → $new_version" "PASSED" "" "updated successfully"
  print_engine_result "$test_name" "$old_version → $new_version" "PASSED"
  PASSED=$((PASSED+1))
  return 0
}

# ============================================================================
# MAIN TEST FUNCTION
# ============================================================================

run_test() {
  local engine=$1
  local version=$2
  local container_name="e2e_${engine}_$$"
  local test_details=""
  local failure_reason=""
  local is_file_based=false

  # Set default test_details based on mode
  if [ "$SMOKE_TEST" = "true" ]; then
    test_details="smoke test"
  fi

  # Track for cleanup on interrupt
  CURRENT_CONTAINER="$container_name"

  [ "$engine" = "sqlite" ] || [ "$engine" = "duckdb" ] && is_file_based=true

  log_header "$engine v$version"

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 1: Download
  # ─────────────────────────────────────────────────────────────────────────
  log_section "Download Binaries"

  log_step "Download $engine $version from hostdb"
  if ! spindb engines download "$engine" "$version" &>/dev/null; then
    log_step_fail
    failure_reason="Binary download failed"
    record_result "$engine" "$version" "FAILED" "$failure_reason"
    print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_ok

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 2: Container Lifecycle
  # ─────────────────────────────────────────────────────────────────────────
  log_section "Container Lifecycle"

  log_step "Create container"
  if ! spindb create "$container_name" --engine "$engine" --db-version "$version" --no-start &>/dev/null; then
    log_step_fail
    failure_reason="Container creation failed"
    record_result "$engine" "$version" "FAILED" "$failure_reason"
    print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_ok

  if [ "$is_file_based" = "false" ]; then
    log_step "Start container"
    if ! spindb start "$container_name" &>/dev/null; then
      log_step_fail
      spindb delete "$container_name" --yes &>/dev/null || true
      failure_reason="Container start failed"
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_ok

    log_step "Wait for ready"
    local status="unknown"
    for i in $(seq 1 "$STARTUP_TIMEOUT"); do
      if status=$(spindb info "$container_name" --json 2>/dev/null | jq -r '.status' 2>/dev/null); then
        [ "$status" = "running" ] && break
      fi
      sleep 1
    done

    if [ "$status" != "running" ]; then
      log_step_result "fail" "timeout after ${STARTUP_TIMEOUT}s"
      spindb stop "$container_name" &>/dev/null || true
      spindb delete "$container_name" --yes &>/dev/null || true
      failure_reason="Container failed to become ready (status: $status)"
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_ok
  else
    log_step "Start container"
    log_step_result "skip"
  fi

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 3: Connectivity Test
  # ─────────────────────────────────────────────────────────────────────────
  log_section "Connectivity"

  log_step "Basic query test"
  local query_ok=false
  case $engine in
    postgresql|mysql|mariadb|sqlite|duckdb|clickhouse)
      spindb run "$container_name" -c "SELECT 1;" &>/dev/null && query_ok=true
      ;;
    mongodb)
      spindb run "$container_name" -c "db.runCommand({ping: 1})" &>/dev/null && query_ok=true
      ;;
    redis|valkey)
      spindb run "$container_name" -c "PING" &>/dev/null && query_ok=true
      ;;
  esac

  if [ "$query_ok" = "false" ]; then
    log_step_fail
    [ "$is_file_based" = "false" ] && spindb stop "$container_name" &>/dev/null || true
    spindb delete "$container_name" --yes &>/dev/null || true
    failure_reason="Basic query failed"
    record_result "$engine" "$version" "FAILED" "$failure_reason"
    print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_ok

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 4: Data Lifecycle (Seed → Backup → Restore → Verify)
  # Skipped in smoke test mode
  # ─────────────────────────────────────────────────────────────────────────
  if [ "$SMOKE_TEST" != "true" ]; then
  log_section "Data Lifecycle"

  log_step "Insert seed data"
  if ! insert_seed_data "$engine" "$container_name"; then
    log_step_fail
    show_error_details
    cleanup_data_lifecycle "$engine" "$container_name"
    [ "$is_file_based" = "false" ] && spindb stop "$container_name" &>/dev/null || true
    spindb delete "$container_name" --yes &>/dev/null || true
    failure_reason="Seed data insertion failed"
    record_result "$engine" "$version" "FAILED" "$failure_reason"
    print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_ok

  log_step "Verify seed data"
  local initial_count
  case $engine in
    sqlite|duckdb)
      initial_count=$(get_data_count "$engine" "$container_name")
      ;;
    redis|valkey)
      initial_count=$(get_data_count "$engine" "$container_name" "0")
      ;;
    *)
      initial_count=$(get_data_count "$engine" "$container_name" "testdb")
      ;;
  esac
  initial_count=$(echo "$initial_count" | tr -d '[:space:]')

  if [ "$initial_count" != "${EXPECTED_COUNTS[$engine]}" ]; then
    log_step_result "fail" "got $initial_count, expected ${EXPECTED_COUNTS[$engine]}"
    cleanup_data_lifecycle "$engine" "$container_name"
    [ "$is_file_based" = "false" ] && spindb stop "$container_name" &>/dev/null || true
    spindb delete "$container_name" --yes &>/dev/null || true
    failure_reason="Seed data verification failed"
    record_result "$engine" "$version" "FAILED" "$failure_reason"
    print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
    FAILED=$((FAILED+1))
    return 1
  fi
  log_step_result "ok" "$initial_count records"

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 5: Backup/Restore Tests
  # ─────────────────────────────────────────────────────────────────────────
  local formats="${BACKUP_FORMATS[$engine]}"
  local primary_format="${formats%%|*}"
  local secondary_format="${formats#*|}"

  # Format names are now semantic - no display name mapping needed
  log_section "Backup/Restore: $primary_format format"
  if ! test_backup_format "$engine" "$container_name" "$primary_format"; then
    cleanup_data_lifecycle "$engine" "$container_name"
    [ "$is_file_based" = "false" ] && spindb stop "$container_name" &>/dev/null || true
    spindb delete "$container_name" --yes &>/dev/null || true
    failure_reason="Backup/restore failed ($primary_format)"
    record_result "$engine" "$version" "FAILED" "$failure_reason"
    print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
    FAILED=$((FAILED+1))
    return 1
  fi
  test_details="$primary_format"

  if [ -n "$secondary_format" ] && [ "$secondary_format" != "$primary_format" ]; then
    log_section "Backup/Restore: $secondary_format format"
    if ! test_backup_format "$engine" "$container_name" "$secondary_format"; then
      cleanup_data_lifecycle "$engine" "$container_name"
      [ "$is_file_based" = "false" ] && spindb stop "$container_name" &>/dev/null || true
      spindb delete "$container_name" --yes &>/dev/null || true
      failure_reason="Backup/restore failed ($secondary_format)"
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    test_details="$primary_format, $secondary_format"
  fi

  fi # End SMOKE_TEST != true block (Data Lifecycle + Backup/Restore)

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 6: Idempotency Tests (Server Engines Only)
  # Skipped in smoke test mode
  # ─────────────────────────────────────────────────────────────────────────
  if [ "$SMOKE_TEST" != "true" ] && [ "$is_file_based" = "false" ]; then
    log_section "Idempotency Tests"

    log_step "Double-start (should warn, not error)"
    # Container is already running - starting again should not fail
    if spindb start "$container_name" &>/dev/null; then
      log_step_ok
    else
      log_step_result "fail" "double-start errored"
      failure_reason="Double-start caused error instead of warning"
      cleanup_data_lifecycle "$engine" "$container_name"
      spindb stop "$container_name" &>/dev/null || true
      spindb delete "$container_name" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi

    log_step "Stop container for double-stop test"
    spindb stop "$container_name" &>/dev/null || true
    # Wait for stop to complete
    local wait_count=0
    while spindb info "$container_name" --json 2>/dev/null | grep -q '"status":"running"' && [ $wait_count -lt 30 ]; do
      sleep 1
      wait_count=$((wait_count + 1))
    done
    log_step_ok

    log_step "Double-stop (should warn, not error)"
    # Container is already stopped - stopping again should not fail
    if spindb stop "$container_name" &>/dev/null; then
      log_step_ok
    else
      log_step_result "fail" "double-stop errored"
      failure_reason="Double-stop caused error instead of warning"
      cleanup_data_lifecycle "$engine" "$container_name"
      spindb delete "$container_name" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
  fi

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 7: Rename Tests (Server Engines Only)
  # Skipped in smoke test mode
  # ─────────────────────────────────────────────────────────────────────────
  if [ "$SMOKE_TEST" != "true" ] && [ "$is_file_based" = "false" ]; then
    log_section "Rename Tests"

    local renamed_container="${container_name}_renamed"

    log_step "Rename stopped container"
    if ! run_cmd spindb edit "$container_name" --name "$renamed_container"; then
      log_step_fail
      show_error_details
      failure_reason="Rename failed"
      cleanup_data_lifecycle "$engine" "$container_name"
      spindb delete "$container_name" --yes &>/dev/null || true
      spindb delete "$renamed_container" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_ok
    CURRENT_CONTAINER="$renamed_container"  # Update for cleanup on interrupt

    log_step "Start renamed container"
    if ! spindb start "$renamed_container" &>/dev/null; then
      log_step_fail
      failure_reason="Start after rename failed"
      spindb delete "$renamed_container" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    # Wait for container to be ready (especially important for ClickHouse)
    local wait_count=0
    while ! spindb info "$renamed_container" --json 2>/dev/null | grep -q '"status":"running"' && [ $wait_count -lt "$STARTUP_TIMEOUT" ]; do
      sleep 1
      wait_count=$((wait_count + 1))
    done
    # Extra wait for ClickHouse to fully initialize after showing as "running"
    if [ "$engine" = "clickhouse" ]; then
      sleep 3
    fi
    log_step_ok

    log_step "Verify data persists after rename"
    local renamed_count
    case $engine in
      redis|valkey)
        renamed_count=$(get_data_count "$engine" "$renamed_container" "0")
        ;;
      *)
        renamed_count=$(get_data_count "$engine" "$renamed_container" "testdb")
        ;;
    esac
    # Debug output for empty counts
    if [ -z "$renamed_count" ] && [ "$VERBOSE" = "true" ]; then
      log_verbose "Empty count returned, debugging query..."
      spindb run "$renamed_container" -c "SELECT COUNT(*) FROM test_user;" -d "testdb" 2>&1 || true
    fi
    renamed_count=$(echo "$renamed_count" | tr -d '[:space:]')
    if [ "$renamed_count" != "${EXPECTED_COUNTS[$engine]}" ]; then
      log_step_result "fail" "got $renamed_count, expected ${EXPECTED_COUNTS[$engine]}"
      failure_reason="Data lost after rename"
      spindb stop "$renamed_container" &>/dev/null || true
      spindb delete "$renamed_container" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_result "ok" "$renamed_count records"

    log_step "Verify old name doesn't exist"
    if spindb info "$container_name" --json &>/dev/null; then
      log_step_fail
      failure_reason="Old container name still exists after rename"
      spindb stop "$renamed_container" &>/dev/null || true
      spindb delete "$renamed_container" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_ok

    log_step "Stop renamed container"
    spindb stop "$renamed_container" &>/dev/null || true
    log_step_ok

    # Rename back for clone test
    log_step "Rename back for clone test"
    if ! run_cmd spindb edit "$renamed_container" --name "$container_name"; then
      log_step_fail
      show_error_details
      # Continue anyway - we'll use renamed_container for clone
      container_name="$renamed_container"
      # CURRENT_CONTAINER is already $renamed_container, so no update needed
    else
      log_step_ok
      CURRENT_CONTAINER="$container_name"  # Update for cleanup on interrupt
    fi
    test_details="$test_details, rename"
  fi

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 8: Clone Tests (Server Engines Only)
  # Skipped in smoke test mode
  # ─────────────────────────────────────────────────────────────────────────
  if [ "$SMOKE_TEST" != "true" ] && [ "$is_file_based" = "false" ]; then
    log_section "Clone Tests"

    local cloned_container="${container_name}_clone"

    log_step "Clone stopped container"
    if ! run_cmd spindb clone "$container_name" "$cloned_container"; then
      log_step_fail
      show_error_details
      failure_reason="Clone failed"
      spindb delete "$container_name" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_ok

    log_step "Start cloned container"
    if ! spindb start "$cloned_container" &>/dev/null; then
      log_step_fail
      failure_reason="Start cloned container failed"
      spindb delete "$container_name" --yes &>/dev/null || true
      spindb delete "$cloned_container" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    # Wait for container to be ready (especially important for ClickHouse)
    local wait_count=0
    while ! spindb info "$cloned_container" --json 2>/dev/null | grep -q '"status":"running"' && [ $wait_count -lt "$STARTUP_TIMEOUT" ]; do
      sleep 1
      wait_count=$((wait_count + 1))
    done
    # Extra wait for ClickHouse to fully initialize after showing as "running"
    if [ "$engine" = "clickhouse" ]; then
      sleep 3
    fi
    log_step_ok

    log_step "Verify cloned data matches source"
    local cloned_count
    case $engine in
      redis|valkey)
        cloned_count=$(get_data_count "$engine" "$cloned_container" "0")
        ;;
      *)
        cloned_count=$(get_data_count "$engine" "$cloned_container" "testdb")
        ;;
    esac
    cloned_count=$(echo "$cloned_count" | tr -d '[:space:]')
    if [ "$cloned_count" != "${EXPECTED_COUNTS[$engine]}" ]; then
      log_step_result "fail" "got $cloned_count, expected ${EXPECTED_COUNTS[$engine]}"
      failure_reason="Cloned data doesn't match source"
      spindb stop "$cloned_container" &>/dev/null || true
      spindb delete "$container_name" --yes &>/dev/null || true
      spindb delete "$cloned_container" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_result "ok" "$cloned_count records"

    log_step "Verify clonedFrom metadata"
    local cloned_from
    cloned_from=$(spindb info "$cloned_container" --json 2>/dev/null | jq -r '.clonedFrom' 2>/dev/null)
    if [ "$cloned_from" != "$container_name" ]; then
      log_step_result "fail" "clonedFrom='$cloned_from', expected '$container_name'"
      failure_reason="clonedFrom metadata incorrect"
      spindb stop "$cloned_container" &>/dev/null || true
      spindb delete "$container_name" --yes &>/dev/null || true
      spindb delete "$cloned_container" --yes &>/dev/null || true
      record_result "$engine" "$version" "FAILED" "$failure_reason"
      print_engine_result "$engine" "$version" "FAILED" "$failure_reason"
      FAILED=$((FAILED+1))
      return 1
    fi
    log_step_ok

    log_step "Stop and delete cloned container"
    spindb stop "$cloned_container" &>/dev/null || true
    spindb delete "$cloned_container" --yes &>/dev/null || true
    log_step_ok
    test_details="$test_details, clone"
  fi

  # ─────────────────────────────────────────────────────────────────────────
  # Phase 9: Cleanup
  # ─────────────────────────────────────────────────────────────────────────
  # NOTE: Redis/Valkey merge vs replace mode tests are skipped here because
  # the --flush flag is only available in the interactive menu, not via CLI.
  # The GH Actions test-redis-modes job tests this via direct engine calls.
  log_section "Cleanup"

  # Only cleanup data lifecycle artifacts if we ran those tests
  if [ "$SMOKE_TEST" != "true" ]; then
    cleanup_data_lifecycle "$engine" "$container_name"
  fi

  if [ "$is_file_based" = "false" ]; then
    log_step "Stop container"
    spindb stop "$container_name" &>/dev/null || true
    log_step_ok
  fi

  log_step "Delete container"
  spindb delete "$container_name" --yes &>/dev/null || true
  # Also cleanup any renamed/cloned containers that might be left over
  spindb delete "${container_name}_renamed" --yes &>/dev/null || true
  spindb delete "${container_name}_clone" --yes &>/dev/null || true
  log_step_ok

  # ─────────────────────────────────────────────────────────────────────────
  # Success!
  # ─────────────────────────────────────────────────────────────────────────
  CURRENT_CONTAINER=""  # Clear tracking - container deleted
  local result_details="$test_details"
  if [ "$SMOKE_TEST" != "true" ]; then
    result_details="formats: $test_details"
  fi
  record_result "$engine" "$version" "PASSED" "" "$result_details"
  print_engine_result "$engine" "$version" "PASSED"
  PASSED=$((PASSED+1))
  return 0
}

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

get_default_version() {
  spindb engines supported --json 2>/dev/null | jq -r ".engines.$1.defaultVersion" 2>/dev/null || echo ""
}

should_run_test() {
  [ -z "$ENGINE_FILTER" ] && return 0
  [ "$ENGINE_FILTER" = "$1" ] && return 0
  return 1
}

# ============================================================================
# FINAL SUMMARY
# ============================================================================

print_final_summary() {
  echo ""
  echo ""
  echo "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
  echo "${BOLD}${CYAN}                      E2E TEST SUMMARY                          ${RESET}"
  echo "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
  echo ""

  # Results table
  printf "  ${BOLD}%-12s %-10s %-8s %s${RESET}\n" "ENGINE" "VERSION" "STATUS" "DETAILS"
  printf "  ${DIM}%-12s %-10s %-8s %s${RESET}\n" "────────────" "──────────" "────────" "─────────────────────"

  for i in "${!RESULTS_ENGINE[@]}"; do
    local engine="${RESULTS_ENGINE[$i]}"
    local version="${RESULTS_VERSION[$i]}"
    local status="${RESULTS_STATUS[$i]}"
    local error="${RESULTS_ERROR[$i]}"
    local details="${RESULTS_DETAILS[$i]}"

    local status_display
    local detail_display
    if [ "$status" = "PASSED" ]; then
      status_display="${GREEN}✓ PASS${RESET}"
      detail_display="${DIM}$details${RESET}"
    else
      status_display="${RED}✗ FAIL${RESET}"
      detail_display="${RED}$error${RESET}"
    fi

    printf "  %-12s %-10s %-18s %s\n" "$engine" "$version" "$status_display" "$detail_display"
  done

  echo ""
  echo "  ${DIM}────────────────────────────────────────────────────────────${RESET}"

  local total=$((PASSED + FAILED))
  if [ $FAILED -eq 0 ]; then
    echo ""
    echo "  ${GREEN}${BOLD}✓ ALL $total TESTS PASSED${RESET}"
    echo ""
  else
    echo ""
    echo "  ${BOLD}Total: $total${RESET}  ${GREEN}Passed: $PASSED${RESET}  ${RED}Failed: $FAILED${RESET}"
    echo ""
    echo "  ${RED}${BOLD}✗ $FAILED TEST(S) FAILED${RESET}"
    echo ""
  fi
}

# ============================================================================
# MAIN
# ============================================================================

# Header
echo ""
echo "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
echo "${BOLD}${CYAN}            SpinDB Docker Linux E2E Tests                       ${RESET}"
echo "${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}"
echo ""
if [ -n "$ENGINE_FILTER" ]; then
  echo "  ${BOLD}Filter:${RESET}    $ENGINE_FILTER"
fi
if [ "$SMOKE_TEST" = "true" ]; then
  echo "  ${BOLD}Mode:${RESET}      ${YELLOW}smoke test${RESET} (download + start + query only)"
else
  echo "  ${BOLD}Mode:${RESET}      full test (all phases)"
fi
echo "  ${BOLD}Node:${RESET}      $(node --version 2>/dev/null || echo 'not found')"
echo "  ${BOLD}Platform:${RESET}  $(uname -s) $(uname -m)"
echo "  ${BOLD}SpinDB:${RESET}    $(spindb version 2>/dev/null || echo 'not installed')"

# Check required tools
log_section "Checking Required Tools"
REQUIRED_TOOLS="jq node pnpm spindb"
for tool in $REQUIRED_TOOLS; do
  log_step "Check $tool"
  if command -v "$tool" &>/dev/null; then
    log_step_ok
  else
    log_step_fail
    log_error "$tool is required but not installed"
    exit 1
  fi
done

# Clean state
log_section "Preparing Test Environment"
if [ -n "$CI" ]; then
  # In CI, safe to delete real home data
  log_step "Clear ~/.spindb (CI mode)"
  rm -rf ~/.spindb 2>/dev/null || true
  log_step_ok
else
  # Outside CI, use a temporary directory to avoid deleting real user data
  log_step "Create isolated SPINDB_HOME"
  CREATED_TEMP_SPINDB_HOME=$(mktemp -d)
  export SPINDB_HOME="$CREATED_TEMP_SPINDB_HOME"
  log_step_result "ok" "$SPINDB_HOME"
  log_warning "Running outside CI - using temp directory instead of ~/.spindb"
fi

# Check libraries
log_step "Check system libraries"
missing_libs=0

# Function to check if a library exists via file scan
check_lib_exists() {
  local lib="$1"
  local lib_dirs="/lib /lib64 /usr/lib /usr/lib64 /usr/local/lib"
  # Add architecture-specific directories (glibc and musl variants)
  for base in /lib /usr/lib; do
    for variant in "$base"/*-linux-gnu* "$base"/*-linux-musl*; do
      [ -d "$variant" ] && lib_dirs="$lib_dirs $variant"
    done
  done
  # Search for library files (e.g., libaio.so, libaio.so.1, libaio.a)
  for dir in $lib_dirs; do
    if [ -d "$dir" ] && ls "$dir"/${lib}.* "$dir"/${lib}-*.* 2>/dev/null | grep -q .; then
      return 0
    fi
  done
  return 1
}

for lib in libaio libnuma libncurses libssl; do
  if command -v ldconfig >/dev/null 2>&1; then
    # Use ldconfig if available (faster, more accurate)
    ldconfig -p 2>/dev/null | grep -q "$lib" || missing_libs=$((missing_libs+1))
  else
    # Fallback to file scan for systems without ldconfig (Alpine, minimal containers)
    check_lib_exists "$lib" || missing_libs=$((missing_libs+1))
  fi
done
if [ $missing_libs -eq 0 ]; then
  log_step_ok
else
  log_step_result "ok" "$missing_libs optional libs missing"
fi

# Run engine tests
for engine in postgresql mysql mariadb sqlite mongodb redis valkey clickhouse duckdb; do
  if should_run_test "$engine"; then
    version=$(get_default_version "$engine")
    if [ -n "$version" ]; then
      run_test "$engine" "$version"
    else
      log_header "$engine"
      echo "  ${YELLOW}Skipped: no default version configured${RESET}"
    fi
  fi
done

# Run utility tests (non-engine tests)
# Self-update test is skipped in smoke test mode
if [ "$SMOKE_TEST" != "true" ] && should_run_test "self-update"; then
  run_self_update_test
fi

# Summary
print_final_summary

# Exit code
[ $FAILED -gt 0 ] && exit 1
exit 0
