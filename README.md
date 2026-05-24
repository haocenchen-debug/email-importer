# Email Importer

An plugin that imports email from Gmail and QQ Mail via IMAP and saves messages into your vault as Markdown notes.

## Highlights
- Gmail import
- QQ Mail import
- IMAP connection test
- `UNSEEN` / `ALL` search support
- Duplicate prevention using `Message-ID`
- Auto-create folder structure
- Separate output folders per account
- Run sync directly from the app
- Export attachments and link them from email notes
- Organize imported mail by sender name and sender email
- Show clickable in-app and desktop notifications for newly imported mail
- Keep read/unread/attachment folder names fixed in English

## Repository structure
```text
email-importer/
├── plugin/
│   ├── LICENSE
│   ├── README.md
│   ├── main.js
│   ├── manifest.json
│   └── styles.css
├── .gitignore
├── README.md
├── LICENSE.md
└── RELEASE_NOTES.md
```

## Plugin folder
The actual plugin files live in:

```text
plugin/
```

If you want to install it manually into your vault, copy the files from `plugin/` into your local plugin directory.

## Recommended GitHub repository metadata
**Repository name**
```text
email-importer
```

**Description**
```text
Import Gmail and QQ Mail into your vault via IMAP and save messages as Markdown notes.
```

**Suggested topics**
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

## License
This project uses:

```text
CC BY-NC-SA 4.0
```

Please read:
- `plugin/LICENSE`
- `LICENSE.md`

before publishing or reusing the project.

## Publishing suggestion
Do **not** publish your entire vault.
Only publish this extracted repository folder.


## Roadmap
- Better MIME parsing
- Attachment export
- Smarter HTML email cleanup
- Rule-based classification
- Optional AI summarization
- Better settings UI
- More mailbox providers

## Screenshot placeholders
You can later add screenshots for:
- plugin settings page
- Gmail configuration example
- QQ Mail configuration example
- imported Markdown note example
