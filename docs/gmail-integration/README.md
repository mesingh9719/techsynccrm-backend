# Gmail integration

Research date: **23 October 2026 (India)**. Status: **Option A approved; local MVP implemented; Google Cloud setup and live validation pending**.

Recommendation: pilot a reliable Gmail send/reply/history integration with email-using Growth
customers. Keep WhatsApp/call follow-up work ahead of broad email automation for the general
clinic/coaching audience. Two-way Gmail access needs a funded verification/security-assessment
plan; a send-only pilot is a smaller alternative, not the requested two-way MVP.

1. [Market review and competitor matrix](market-review.md)
2. [Short PRD and approval choices](prd.md)
3. [Technical design and Google verification plan](technical-design.md)
4. [QA results and deployment checklists](qa-deployment.md)
5. [Operator setup instructions](setup.md)
6. [Implementation notes and remaining limits](implementation.md)

The user approved full two-way scope A and the recommended privacy/retention defaults with “proceed with A”. Backend and frontend implementation lives on `feat/gmail-integration`. The user subsequently confirmed that Google Cloud is not configured and requested local implementation plus setup instructions. Both server flags default off; no production migration, cloud provisioning or real-mail operation was performed.

The older M19 communication-channels specification in the workspace documentation remains a broader
roadmap. This proposal covers its Gmail slice, with explicit changes for narrow scopes,
privacy, safe sending and a smaller launch. It does not approve all of M19.
