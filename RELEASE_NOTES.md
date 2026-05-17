# Release Notes

## v0.1.1
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

