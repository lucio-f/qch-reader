# Changelog

## Unreleased

- Documentation locations can be committed with a project: **Add Documentation Folder…** lets you choose user, workspace or folder settings and stores paths relative to the workspace.
- `qchReader.folders` values from user, workspace and folder settings are combined instead of overriding each other.
- Relative paths resolve against the settings file that contains them; `${workspaceFolder:name}` and per-folder settings in multi-root workspaces are supported.
- Workspace locations wait for workspace trust, with a notice explaining why.

## 0.1.0

Initial release.

- Load every `.qch` file from configured folders, the workspace, or files opened from the Explorer.
- Contents tree, keyword index and BM25-ranked full-text search with phrases, prefixes, exclusions, `OR`, `title:` and `doc:`.
- Documentation viewer with history, breadcrumbs, find in page, search-term highlighting, zoom and themed/original page styles.
- Cross-links between documents resolved like Qt Assistant (by virtual folder across namespaces).
- Filters: filters declared by the documentation, components, versions and your own filters.
- Context help (`Shift+F1`), symbol hovers and clickable `qthelp://` links in editors.
- Pure TypeScript SQLite reader: no native modules, no WebAssembly.
