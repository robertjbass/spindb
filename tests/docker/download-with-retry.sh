#!/bin/bash

# Retry only the download phase; lifecycle failures must remain failures.
download_with_retry() {
  local attempt output status
  for attempt in 1 2 3; do
    if output=$(spindb engines download "$@" 2>&1); then
      printf '%s\n' "$output"
      return 0
    else
      status=$?
    fi
    printf '%s\n' "$output" >&2
    # Do not turn cancellation or an externally killed process into a retry.
    if [ "$status" -ge 128 ] || [ "$attempt" -eq 3 ]; then
      return "$status"
    fi
    printf 'Download attempt %s failed (exit %s); retrying.\n' "$attempt" "$status" >&2
    sleep "$((attempt * 2))"
  done
}
