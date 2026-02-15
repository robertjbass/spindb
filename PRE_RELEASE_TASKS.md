# Pre-Release Tasks

Tasks that must be addressed before the next release.

## Registry

- [ ] **Re-enable GitHub fallback** — Set `ENABLE_GITHUB_FALLBACK` to `true` in `core/hostdb-client.ts` so that binary downloads and `releases.json` fetches fall back to the GitHub hostdb repository when `registry.layerbase.host` is unavailable.
- [ ] **Document registry data files** — Ensure that `databases.json`, `releases.json`, and `downloads.json` are clearly documented (what each file contains, where it's fetched from, and how it's used) so that we can minimize the requirement to be online to use SpinDB. Consider caching strategies for offline/degraded network scenarios.
