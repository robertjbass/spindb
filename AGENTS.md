# AGENTS.md

All agent instructions for this repository live in [CLAUDE.md](CLAUDE.md) —
read that file in full before making changes. Related authoritative docs:
[ENGINE_CHECKLIST.md](ENGINE_CHECKLIST.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[STYLEGUIDE.md](STYLEGUIDE.md), [docs/ENGINE_NOTES.md](docs/ENGINE_NOTES.md).

Cross-repo reminder: when updating spindb, check whether `~/dev/layerbase-cli`
needs a matching docs update. That CLI forwards non-layerbase commands verbatim
to spindb and documents spindb's command surface as its own, and its
`scripts/check-spindb-collisions.ts` validates layerbase verbs against
`spindb --help`. New spindb flags forward transparently, but new, renamed, or
removed top-level spindb commands can collide with layerbase verbs or leave its
docs stale.
