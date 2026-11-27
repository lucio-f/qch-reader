# Changelog

## 0.1.0

Initial release.

- Load every `.qch` file from configured folders, the workspace, or files opened from the Explorer.
- Contents tree, keyword index and BM25-ranked full-text search with phrases, prefixes, exclusions, `OR`, `title:` and `doc:`.
- Documentation viewer with history, breadcrumbs, find in page, search-term highlighting, zoom and themed/original page styles.
- Cross-links between documents resolved like Qt Assistant (by virtual folder across namespaces).
- Filters: filters declared by the documentation, components, versions and your own filters.
- Context help (`Shift+F1`), symbol hovers and clickable `qthelp://` links in editors.
- Pure TypeScript SQLite reader: no native modules, no WebAssembly.
