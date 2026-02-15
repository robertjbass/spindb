# Pre-Release Tasks

Tasks that must be addressed before the next release.

## Registry

- [ ] **Re-enable GitHub fallback** — Set `ENABLE_GITHUB_FALLBACK` to `true` in `core/hostdb-client.ts` so that binary downloads and `releases.json` fetches fall back to the GitHub hostdb repository when `registry.layerbase.host` is unavailable.
- [ ] **Document registry data files** — Ensure that `databases.json`, `releases.json`, and `downloads.json` are clearly documented (what each file contains, where it's fetched from, and how it's used) so that we can minimize the requirement to be online to use SpinDB. Consider caching strategies for offline/degraded network scenarios.

## hostdb Data Sync

SpinDB fetches three JSON files from hostdb at runtime: `databases.json`, `releases.json`, and `downloads.json`. Until the hostdb repo is merged into the spindb repo, these files should be regularly synced to ensure version maps and metadata stay current.

- [ ] **Set up GitHub Actions cron job** — Create a scheduled workflow (e.g., weekly) that copies `databases.json`, `releases.json`, and `downloads.json` from the [hostdb repo](https://github.com/robertjbass/hostdb) into the spindb repo (e.g., into a `data/` or `config/hostdb/` directory). This enables future offline-first operation and catches version drift early.
- [ ] **Merge hostdb into spindb** — Long-term goal: eliminate the separate hostdb repository entirely. Move all binary metadata and registry data into the spindb repo so there is a single source of truth. The cron sync is a bridge until this happens.
