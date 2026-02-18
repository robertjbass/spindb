#!/bin/bash
# SpinDB Self-Update E2E Test
#
# Tests the full self-update flow:
#   1. Installs an older version of spindb globally
#   2. Verifies the old version is installed
#   3. Runs self-update using the local dev code
#   4. Verifies the version was updated
#
# Usage:
#   ./scripts/test-self-update.sh              # Use defaults (installs 0.36.2, updates to npm latest)
#   ./scripts/test-self-update.sh --old 0.35.0 # Specify which old version to install
#   ./scripts/test-self-update.sh --cleanup    # Just remove the global spindb install
#
# Prerequisites:
#   - pnpm installed globally
#   - Internet access (to install from npm and check for updates)
#
# What this tests:
#   - Package manager detection (should detect pnpm since we install via pnpm)
#   - Correct install command generation (pnpm add -g spindb@latest)
#   - Full update lifecycle: check → download → install → verify

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
GRAY='\033[0;90m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

OLD_VERSION="0.36.2"
CLEANUP_ONLY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --old)
      OLD_VERSION="$2"
      shift 2
      ;;
    --cleanup)
      CLEANUP_ONLY=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--old <version>] [--cleanup]"
      echo ""
      echo "Options:"
      echo "  --old <version>  Old version to install (default: 0.36.2)"
      echo "  --cleanup        Just remove global spindb install and exit"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

log_info()    { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_error()   { echo -e "${RED}✗${NC} $1"; }
log_step()    { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
log_dim()     { echo -e "${GRAY}  $1${NC}"; }

cleanup_global() {
  log_info "Removing global spindb install..."
  pnpm remove -g spindb 2>/dev/null || true
}

if [ "$CLEANUP_ONLY" = true ]; then
  cleanup_global
  log_success "Global spindb removed"
  exit 0
fi

# Returns the globally installed spindb version, or empty string if not installed
get_global_spindb_version() {
  pnpm list -g spindb --json 2>/dev/null | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const j=JSON.parse(d);console.log(j[0]?.dependencies?.spindb?.version||'')}
      catch{console.log('')}
    })
  " 2>/dev/null
}

# Record what was installed before so we can restore it
ORIGINAL_VERSION=$(get_global_spindb_version)
if [ -n "$ORIGINAL_VERSION" ]; then
  log_info "Found existing global spindb: v${ORIGINAL_VERSION}"
fi

LATEST_VERSION=$(npm view spindb version 2>/dev/null)
if [ -z "$LATEST_VERSION" ]; then
  log_error "Could not fetch latest version from npm registry"
  exit 1
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  SpinDB Self-Update E2E Test${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
log_dim "Old version to install: $OLD_VERSION"
log_dim "Expected after update:  $LATEST_VERSION (npm latest)"
log_dim "Dev version:            $(node -p "require('$PROJECT_DIR/package.json').version")"
echo ""

PASSED=0
FAILED=0

record_pass() { PASSED=$((PASSED + 1)); log_success "$1"; }
record_fail() { FAILED=$((FAILED + 1)); log_error "$1"; }

# ─── Step 1: Install old version ─────────────────────────────────────

log_step "Step 1: Install spindb@${OLD_VERSION} globally"

pnpm add -g "spindb@${OLD_VERSION}" 2>&1 | while IFS= read -r line; do log_dim "$line"; done

INSTALLED_VERSION=$(spindb --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

if [ "$INSTALLED_VERSION" = "$OLD_VERSION" ]; then
  record_pass "Installed spindb v${INSTALLED_VERSION}"
else
  record_fail "Expected v${OLD_VERSION}, got v${INSTALLED_VERSION:-unknown}"
  cleanup_global
  exit 1
fi

# ─── Step 2: Test PM detection from dev code ──────────────────────────

log_step "Step 2: Verify PM detection (dev code)"

# tsx -e runs as CJS, so use require() and async IIFE for top-level await
DETECTED_PM=$(cd "$PROJECT_DIR" && pnpm tsx -e "
  (async()=>{const{updateManager}=require('./core/update-manager');console.log(await updateManager.detectPackageManager())})()
" 2>/dev/null)

if [ "$DETECTED_PM" = "pnpm" ]; then
  record_pass "Detected package manager: ${DETECTED_PM}"
else
  record_fail "Expected pnpm, detected: ${DETECTED_PM:-nothing}"
fi

UA_PM=$(cd "$PROJECT_DIR" && pnpm tsx -e "
  const{parseUserAgent}=require('./core/update-manager');console.log(parseUserAgent(process.env.npm_config_user_agent))
" 2>/dev/null)

if [ "$UA_PM" = "pnpm" ]; then
  record_pass "parseUserAgent(npm_config_user_agent) = ${UA_PM}"
else
  record_fail "parseUserAgent expected pnpm, got: ${UA_PM:-null}"
fi

# ─── Step 3: Run self-update via dev code ─────────────────────────────

log_step "Step 3: Run self-update (dev code → global install)"

cd "$PROJECT_DIR"
# Use pnpm start to run the dev code's self-update with --force --yes
# --force is needed because dev version (e.g. 0.37.2) may be ahead of npm latest (0.37.1)
set +e
UPDATE_OUTPUT=$(pnpm start self-update --force --yes 2>&1)
UPDATE_EXIT=$?
set -e

log_dim "Exit code: $UPDATE_EXIT"
echo "$UPDATE_OUTPUT" | while IFS= read -r line; do log_dim "$line"; done

if [ $UPDATE_EXIT -eq 0 ]; then
  record_pass "self-update completed successfully"
else
  record_fail "self-update exited with code $UPDATE_EXIT"
fi

# ─── Step 4: Verify updated version ──────────────────────────────────

log_step "Step 4: Verify updated version"

NEW_VERSION=$(spindb --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

if [ -z "$NEW_VERSION" ]; then
  record_fail "Could not get version after update"
elif [ "$NEW_VERSION" = "$LATEST_VERSION" ]; then
  record_pass "Updated to v${NEW_VERSION} (matches npm latest)"
elif [ "$NEW_VERSION" != "$OLD_VERSION" ]; then
  # Version changed but doesn't match what npm reports — could be a race
  record_pass "Updated from v${OLD_VERSION} to v${NEW_VERSION} (npm reports ${LATEST_VERSION})"
else
  record_fail "Version unchanged: still v${NEW_VERSION} (expected ${LATEST_VERSION})"
fi

# ─── Restore original state ──────────────────────────────────────────

log_step "Cleanup"

if [ -n "$ORIGINAL_VERSION" ]; then
  log_info "Restoring original global spindb v${ORIGINAL_VERSION}..."
  if pnpm add -g "spindb@${ORIGINAL_VERSION}" 2>&1 | while IFS= read -r line; do log_dim "$line"; done; then
    RESTORED=$(spindb --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    if [ "$RESTORED" = "$ORIGINAL_VERSION" ]; then
      log_success "Restored v${ORIGINAL_VERSION}"
    else
      log_info "Global spindb is v${RESTORED:-unknown} (wanted ${ORIGINAL_VERSION})"
    fi
  else
    log_info "Could not restore v${ORIGINAL_VERSION} — global spindb is now v$(spindb --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  fi
else
  cleanup_global
  log_success "Removed global spindb (was not installed before test)"
fi

# ─── Summary ──────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
TOTAL=$((PASSED + FAILED))
echo -e "  Results: ${GREEN}${PASSED}/${TOTAL} passed${NC}"
if [ $FAILED -gt 0 ]; then
  echo -e "  ${RED}${FAILED} FAILED${NC}"
fi
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

if [ $FAILED -gt 0 ]; then
  exit 1
fi
