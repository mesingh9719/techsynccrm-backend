# Google Workspace integration program

The implementation includes the shared connection foundation plus **Calendar, scheduled Google Meet and native Google Sheets tools**, requested by the owner on 25 October 2026. Planning documents 01–10 preserve the broader roadmap; the current bounded implementation is documented separately.

**Owner's updated setup choice: reuse the existing Google Console account, project and web OAuth client.** The current setup/implementation guides support this directly. Shared-project disconnects erase local credentials; full project access removal is user-led at Google Account connections. This supersedes earlier separate-project requirements in the planning material.

- [Implementation and API contract](12-phase-0-implementation.md)
- [Calendar, Meet and Sheets implementation](14-calendar-meet-sheets.md)
- [Pending Google Cloud Console setup](11-google-cloud-console-setup.md)
- [Foundation QA evidence](13-phase-0-qa.md) and [current content checks](evidence/content-checks.txt)
- [Roadmap](06-roadmap.md) and [decision log](09-decision-log.md)

CRM-to-Google meeting scheduling, Meet links, app-created spreadsheet editing and explicit lead exports are available. Two-way calendar sync, arbitrary Google spreadsheet imports, Drive attachments and Sheets automation remain later phases. Local Excel/CSV import and export remain available through the transfer module.
