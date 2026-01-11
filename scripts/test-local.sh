#!/bin/bash
# SpinDB Local Test Script
# Run this before submitting PRs to verify the full user experience
#
# Usage:
#   ./scripts/test-local.sh              # Run all tests
#   ./scripts/test-local.sh --quick      # Quick smoke test (PostgreSQL only)
#   ./scripts/test-local.sh --engine pg  # Test specific engine
#   ./scripts/test-local.sh --fresh      # Simulate fresh install (wipes ~/.spindb)
#
# This script tests SpinDB as a real user would experience it, not through
# the development environment. It helps catch issues that unit/integration
# tests might miss.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
QUICK_MODE=false
FRESH_MODE=false
SPECIFIC_ENGINE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --quick)
      QUICK_MODE=true
      shift
      ;;
    --fresh)
      FRESH_MODE=true
      shift
      ;;
    --engine)
      if [ -z "$2" ] || [[ "$2" == -* ]]; then
        echo "Error: --engine requires a value"
        echo "Usage: $0 [--quick] [--fresh] [--engine <engine>]"
        echo "Available engines: postgresql, mysql, mariadb, sqlite, mongodb, redis"
        exit 1
      fi
      SPECIFIC_ENGINE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--quick] [--fresh] [--engine <engine>]"
      exit 1
      ;;
  esac
done

# Test counters
PASSED=0
FAILED=0
SKIPPED=0

# Results tracking
declare -a RESULTS

log_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

log_section() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
}

record_result() {
  local test_name=$1
  local status=$2
  local message=${3:-""}

  RESULTS+=("$status|$test_name|$message")

  if [ "$status" = "PASS" ]; then
    PASSED=$((PASSED + 1))
    log_success "$test_name"
  elif [ "$status" = "FAIL" ]; then
    FAILED=$((FAILED + 1))
    log_error "$test_name: $message"
  else
    SKIPPED=$((SKIPPED + 1))
    log_warning "$test_name: SKIPPED - $message"
  fi
}

print_summary() {
  log_section "TEST SUMMARY"

  echo ""
  echo "┌────────────────────────────────────────────────────────────┐"
  echo "│ Test Results                                               │"
  echo "├────────────────────────────────────────────────────────────┤"

  for result in "${RESULTS[@]}"; do
    IFS='|' read -r status name message <<< "$result"

    if [ "$status" = "PASS" ]; then
      icon="${GREEN}✓${NC}"
    elif [ "$status" = "FAIL" ]; then
      icon="${RED}✗${NC}"
    else
      icon="${YELLOW}○${NC}"
    fi

    printf "│ %b %-56s │\n" "$icon" "$name"
    if [ -n "$message" ] && [ "$status" != "PASS" ]; then
      printf "│   ${YELLOW}→ %s${NC}%*s│\n" "$message" $((52 - ${#message})) ""
    fi
  done

  echo "└────────────────────────────────────────────────────────────┘"
  echo ""
  echo -e "Summary: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}, ${YELLOW}$SKIPPED skipped${NC}"
  echo ""

  if [ $FAILED -gt 0 ]; then
    echo -e "${RED}❌ SOME TESTS FAILED${NC}"
    return 1
  else
    echo -e "${GREEN}✅ ALL TESTS PASSED${NC}"
    return 0
  fi
}

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

log_section "SpinDB Local Test Suite"
echo ""
log_info "Project directory: $PROJECT_DIR"
log_info "Quick mode: $QUICK_MODE"
log_info "Fresh mode: $FRESH_MODE"
log_info "Specific engine: ${SPECIFIC_ENGINE:-all}"
echo ""

# Change to project directory
cd "$PROJECT_DIR"

# Fresh mode - wipe ~/.spindb
if [ "$FRESH_MODE" = true ]; then
  log_warning "Fresh mode enabled - wiping ~/.spindb"
  rm -rf ~/.spindb
  log_success "Cleaned ~/.spindb"
fi

# ============================================
# Basic CLI Tests
# ============================================
log_section "Basic CLI Tests"

# Test version command
if pnpm start version > /dev/null 2>&1; then
  VERSION=$(pnpm start version 2>/dev/null | head -1)
  record_result "spindb version" "PASS" "$VERSION"
else
  record_result "spindb version" "FAIL" "Command failed"
fi

# Test help command
if pnpm start --help > /dev/null 2>&1; then
  record_result "spindb --help" "PASS"
else
  record_result "spindb --help" "FAIL" "Command failed"
fi

# Test list command (should work even with no containers)
if pnpm start list > /dev/null 2>&1; then
  record_result "spindb list" "PASS"
else
  record_result "spindb list" "FAIL" "Command failed"
fi

# Test engines supported
if pnpm start engines supported > /dev/null 2>&1; then
  record_result "spindb engines supported" "PASS"
else
  record_result "spindb engines supported" "FAIL" "Command failed"
fi

# ============================================
# Engine Download Tests
# ============================================
test_engine_download() {
  local engine=$1
  local version=$2

  log_info "Downloading $engine $version..."

  if pnpm start engines download "$engine" "$version" 2>&1; then
    record_result "Download $engine $version" "PASS"
    return 0
  else
    record_result "Download $engine $version" "FAIL" "Download failed"
    return 1
  fi
}

# ============================================
# Full Lifecycle Test
# ============================================
test_engine_lifecycle() {
  local engine=$1
  local version=$2
  local container_name="local-test-${engine}-$$"

  log_section "Testing $engine v$version Lifecycle"

  # Download engine (skip sqlite)
  if [ "$engine" != "sqlite" ]; then
    if ! test_engine_download "$engine" "$version"; then
      record_result "$engine lifecycle" "SKIP" "Download failed"
      return 1
    fi
  fi

  # Create container
  log_info "Creating container: $container_name"
  if ! pnpm start create "$container_name" --engine "$engine" --db-version "$version" --no-start 2>&1; then
    record_result "$engine create" "FAIL" "Create failed"
    return 1
  fi
  record_result "$engine create" "PASS"

  # Start container (skip for sqlite)
  if [ "$engine" != "sqlite" ]; then
    log_info "Starting container..."
    if ! pnpm start start "$container_name" 2>&1; then
      record_result "$engine start" "FAIL" "Start failed"
      pnpm start delete "$container_name" --yes 2>/dev/null || true
      return 1
    fi
    record_result "$engine start" "PASS"

    # Give it time to fully start
    sleep 2

    # Check status
    log_info "Checking container status..."
    local status
    # Use jq for JSON parsing if available, fallback to grep/cut
    if command -v jq &>/dev/null; then
      status=$(pnpm start info "$container_name" --json 2>/dev/null | jq -r '.status' 2>/dev/null || echo "unknown")
    else
      # Fallback: grep-based parsing (may fail on complex JSON)
      status=$(pnpm start info "$container_name" --json 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
    fi
    if [ "$status" = "running" ]; then
      record_result "$engine status check" "PASS"
    else
      record_result "$engine status check" "FAIL" "Status: $status"
    fi
  fi

  # Run a query
  log_info "Running test query..."
  local query_result=false
  case $engine in
    postgresql|mysql|mariadb|sqlite)
      if pnpm start run "$container_name" -c "SELECT 1 as test;" >/dev/null 2>&1; then
        query_result=true
      fi
      ;;
    mongodb)
      if pnpm start run "$container_name" -c "db.runCommand({ping: 1})" >/dev/null 2>&1; then
        query_result=true
      fi
      ;;
    redis)
      if pnpm start run "$container_name" -c "PING" >/dev/null 2>&1; then
        query_result=true
      fi
      ;;
  esac

  if [ "$query_result" = true ]; then
    record_result "$engine query" "PASS"
  else
    record_result "$engine query" "FAIL" "Query failed"
  fi

  # Stop container (skip for sqlite)
  if [ "$engine" != "sqlite" ]; then
    log_info "Stopping container..."
    if pnpm start stop "$container_name" 2>&1; then
      record_result "$engine stop" "PASS"
    else
      record_result "$engine stop" "FAIL" "Stop failed"
    fi
  fi

  # Delete container
  log_info "Deleting container..."
  if pnpm start delete "$container_name" --yes 2>&1; then
    record_result "$engine delete" "PASS"
  else
    record_result "$engine delete" "FAIL" "Delete failed"
  fi

  return 0
}

# ============================================
# Run Tests Based on Mode
# ============================================

# Disable errexit for test execution - test bodies should record failures,
# not exit the script. Re-enable after tests complete.
set +e

if [ -n "$SPECIFIC_ENGINE" ]; then
  # Test specific engine
  case $SPECIFIC_ENGINE in
    pg|postgresql)
      test_engine_lifecycle postgresql 18
      ;;
    mysql)
      test_engine_lifecycle mysql 9
      ;;
    mariadb)
      test_engine_lifecycle mariadb 11.8
      ;;
    sqlite)
      test_engine_lifecycle sqlite 3
      ;;
    mongodb)
      test_engine_lifecycle mongodb 8.0
      ;;
    redis)
      test_engine_lifecycle redis 8
      ;;
    *)
      log_error "Unknown engine: $SPECIFIC_ENGINE"
      echo "Available engines: postgresql, mysql, mariadb, sqlite, mongodb, redis"
      set -e
      exit 1
      ;;
  esac
elif [ "$QUICK_MODE" = true ]; then
  # Quick mode - just PostgreSQL
  test_engine_lifecycle postgresql 18
else
  # Full test - all engines
  test_engine_lifecycle postgresql 18
  test_engine_lifecycle mysql 9
  test_engine_lifecycle mariadb 11.8
  test_engine_lifecycle sqlite 3
  test_engine_lifecycle mongodb 8.0
  test_engine_lifecycle redis 8
fi

# Re-enable errexit for summary
set -e

# Print summary
print_summary
exit $?
