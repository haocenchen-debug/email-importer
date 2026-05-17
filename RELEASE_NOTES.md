# Release Notes

## v0.1.1
- Changed default filename layout to subject/date; account identity can be represented by the output folder name.
- Added {accountShort} filename token and changed default filename layout to subject/date/accountShort for cleaner file lists.
- Moved ribbon sync action lower and highlighted it for easier one-click access.
- Added an editor toolbar compatible sync command for Obsidian mobile/quick toolbars.
- Added prominent sync entry points in the ribbon and at the top of settings; trimmed leftover HTML tails from imported text.
- Strip leftover MIME boundaries and part headers from final imported text output.
- Added broader charset decoding for GBK/GB18030/GB2312/Big5 and filtered multipart placeholder text.
- Improved MIME decoding for multipart emails, quoted-printable bodies, base64 bodies, and HTML-to-text fallback.
- Fixed IMAP `FETCH` parsing bug where imported email body could become `A00xx OK FETCH Completed`.
- Changed full email retrieval to `BODY.PEEK[]` so headers and body are parsed from the same raw message.
- Added extraction of the first IMAP literal block before parsing message headers and readable body text.
- Documented cleanup/re-import workflow for bad imported notes.
## v0.1.0
- Initial MVP release
- Gmail import via IMAP
- QQ Mail import via IMAP
- Connection testing
- Standard folder auto-creation
- Per-account output folders
- Duplicate prevention using `Message-ID`
- Beginner-friendly documentation
- CC BY-NC-SA 4.0 license notes added









