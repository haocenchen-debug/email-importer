# Email Importer

A local plugin that imports email from Gmail and QQ Mail via IMAP and writes the result into your vault as Markdown notes.

## What it does
- Import email from Gmail
- Import email from QQ Mail
- Test IMAP connection before syncing
- Support `UNSEEN` / `ALL` style search conditions
- Avoid duplicate imports based on `Message-ID`
- Auto-create a standard folder structure for email capture
- Support per-account output folders
- Run sync directly inside the app
- Save PDF/image attachments and link them from the generated note
- Organize imported mail by sender name and sender email
- Show 20-second clickable in-app new mail toasts
- Show system desktop notifications for new mail on Windows/macOS
- Show clear green/red connection test button feedback

## Current scope
This is an MVP-first plugin focused on making the import workflow usable:
- connect mailboxes
- test credentials
- pull messages
- save them as Markdown

The plugin includes MIME text cleanup, attachment export, sender-based folders, filtering, and automatic duplicate prevention. AI summarization and deeper classification can be added later.

## Installation
1. Put the plugin folder into your plugins directory.
2. Open the app.
3. Go to:

```text
Settings → Community plugins
```

4. Disable Restricted mode if needed.
5. Enable:

```text
Email Importer
```

## Gmail configuration
Use these values:

```text
IMAP host: imap.gmail.com
Port: 993
Username: your Gmail address
Password: Google App Password
Folder: INBOX
Search: UNSEEN
```

## QQ Mail configuration
Use these values:

```text
IMAP host: imap.qq.com
Port: 993
Username: your QQ Mail address
Password: QQ Mail authorization code
Folder: INBOX
Search: UNSEEN
```

## Recommended first-run setup
For the safest first run:

```text
Search condition: UNSEEN
Max emails per sync: 5
Mark as read after sync: Off
```

## Folder behavior
The plugin can auto-create a standard folder structure.

Default root folder:

```text
个人笔记/邮件入库
```

Default subfolders:

```text
个人笔记/邮件入库/待整理
个人笔记/邮件入库/账单凭证
个人笔记/邮件入库/项目沟通
个人笔记/邮件入库/账号通知
个人笔记/邮件入库/精华摘要
```

You can also customize the root folder and assign different output folders to Gmail and QQ Mail.

Imported messages are grouped under each account by read state and sender, while the state folder names stay fixed in English:

```text
个人笔记/邮件入库/40933085QQ邮箱/Unread Mail/Sender Name sender@example.com/mail.md
个人笔记/邮件入库/40933085QQ邮箱/Read Mail/Sender Name sender@example.com/mail.md
个人笔记/邮件入库/40933085QQ邮箱/Unread Mail/Sender Name sender@example.com/Attachments/Mail Subject/file.pdf
```

## License
This project is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International** license.

In plain English:
- ✅ You may share and adapt this project
- ✅ You must give attribution
- ✅ You must use the same license for derivatives
- ❌ You may not use it for commercial purposes without separate permission

Official license page:
https://creativecommons.org/licenses/by-nc-sa/4.0/

## Attribution guidance
If you share or adapt this project, include:
- project name
- original author
- a link to the original repository or source page
- a reference to the CC BY-NC-SA 4.0 license
- a note describing whether you modified it

Recommended attribution format:

```text
Based on Email Importer by [Author Name], licensed under CC BY-NC-SA 4.0.
Changes were made to the original project.
```

## Notes
- Gmail usually requires an App Password instead of your normal password.
- QQ Mail usually requires IMAP/SMTP to be enabled and an authorization code instead of the account password.
- If the plugin does not appear in the app, fully restart the app after installing or updating it.


## Recent improvements
- App Passwords copied with spaces are normalized automatically before IMAP login.
- QQ large-attachment messages are recognized and converted into readable download links.
- Image attachments are rendered as embedded previews in generated notes when appropriate.
- Connection test buttons now show visible success/failure colors.
- New mail can trigger both an in-app toast and a desktop notification.
