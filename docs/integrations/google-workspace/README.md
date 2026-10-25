# Google Workspace integration program

The approved implementation in this branch is **Phase 0: shared connection foundation**. Planning documents 01–10 preserve the broader roadmap; later-phase prompts require their own bounded approval and are not executed here.

**Owner's updated setup choice: reuse the existing Google Console account, project and web OAuth client.** The current setup/implementation guides support this directly. Shared-project disconnects erase local credentials; full project access removal is user-led at Google Account connections. This supersedes earlier separate-project requirements in the planning material.

- [Implementation and API contract](12-phase-0-implementation.md)
- [Pending Google Cloud Console setup](11-google-cloud-console-setup.md)
- [QA evidence](13-phase-0-qa.md)
- [Roadmap](06-roadmap.md) and [decision log](09-decision-log.md)

Calendar content sync, Drive file operations and Google Sheets import/export/automation are pending later phases. Local Excel/CSV import and export remain available through the existing transfer module.
