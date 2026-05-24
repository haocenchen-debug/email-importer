# Publishing Guide

## 1. Create the GitHub repository
Recommended repository name:

```text
email-importer
```

## 2. Initialize Git locally
```bash
git init
git add -A
git commit -m "feat: initial public release of obsidian email importer"
```

## 3. Create the remote repository with GitHub CLI
```bash
gh repo create haocenchen-debug/email-importer --public --description "Import Gmail and QQ Mail into your vault via IMAP and save messages as Markdown notes." --source=. --remote=origin --push
```

## 4. Suggested first commit messages
```text
feat: initial public release of obsidian email importer
chore: add CC BY-NC-SA 4.0 license notes
Docs: add English setup guide and publishing notes
```

## 5. Suggested GitHub topics
```text
obsidian
obsidian-plugin
email
gmail
qq-mail
imap
markdown
knowledge-management
```
