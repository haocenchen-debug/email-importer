# Publishing Guide

## Community plugin checklist

Before submitting or updating the plugin, make sure the repository has:

- root `README.md`
- root `LICENSE`
- root `manifest.json`
- root `versions.json`
- release tag exactly matching `manifest.json.version` (for example `0.1.4`, not `v0.1.4`)
- release assets: `manifest.json`, `main.js`, `styles.css`

## Naming rules

- Do not include `obsidian` in the plugin ID.
- Do not include `Obsidian` in the plugin description.
- Keep branding and release metadata aligned with community review rules.

## Suggested release workflow

1. Update `plugin/manifest.json` and root `manifest.json`.
2. Update `versions.json`.
3. Commit changes.
4. Create a Git tag that exactly matches the plugin version.
5. Create a GitHub release with the same tag.
6. Upload `manifest.json`, `main.js`, and `styles.css`.
7. Wait for review cache refresh if the review page still shows old results.

## Repository

Recommended repository name:

```text
email-importer
```

## Current public repository

```text
https://github.com/haocenchen-debug/email-importer
```
