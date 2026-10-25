# Whole-schema inventory

Code inspection, 25 October 2026. This is not a database integrity certification. Prisma scalar IDs without relations rely on service validation; SQL-only partial/trigram/concurrent indexes and constraints require reading the migrations. Current schema includes inherited uncommitted template changes.

| Entity | Table | Tenant column | Declared keys and indexes |
|---|---|---|---|
| User | users | Global/child |  |
| Organization | organizations | Global/child | @@index([trialEndsAt]) |
| OrganizationUsage | organization_usage | Yes |  |
| PlanChange | plan_changes | Yes | @@index([organizationId, createdAt]) |
| Membership | memberships | Yes | @@unique([organizationId, userId]); @@index([userId, status]) |
| RecoveryCode | recovery_codes | Global/child | @@index([userId]) |
| Invitation | invitations | Yes | @@index([organizationId, email]); @@index([organizationId, createdAt]) |
| Team | teams | Yes | @@unique([organizationId, name]) |
| TeamMember | team_members | Global/child | @@id([teamId, userId]); @@index([userId]) |
| RefreshToken | refresh_tokens | Global/child | @@index([userId]); @@index([sessionId]) |
| UserToken | user_tokens | Global/child | @@index([userId, type]) |
| File | files | Yes | @@index([userId, createdAt(sort: Desc)], map: "files_user_id_created_at_idx"); @@index([organizationId]) |
| DomainEvent | domain_events | Yes | @@index([processedAt, createdAt]); @@index([organizationId, entityType, entityId]) |
| AuditLog | audit_logs | Yes | @@index([organizationId, createdAt(sort: Desc)]); @@index([organizationId, entityType, entityId]) |
| WorkerHeartbeat | worker_heartbeats | Global/child |  |
| ContactRequest | contact_requests | Global/child | @@index([status, createdAt(sort: Desc)]) |
| DemoRequest | demo_requests | Global/child | @@index([slotStart]); @@index([status, createdAt(sort: Desc)]) |
| InboundMessage | inbound_messages | Global/child | @@index([contactRequestId, createdAt]); @@index([demoRequestId, createdAt]); @@index([authorId]) |
| NewsletterSubscriber | newsletter_subscribers | Global/child | @@index([status, createdAt(sort: Desc)]) |
| Company | companies | Yes | @@index([organizationId, ownerId]); @@index([organizationId, domain]); @@index([organizationId, gstin]); @@index([organizationId, createdAt(sort: Desc)]); @@index([organizationId, importId]) |
| Contact | contacts | Yes | @@index([organizationId, ownerId]); @@index([organizationId, primaryPhoneE164]); @@index([organizationId, primaryEmail]); @@index([organizationId, createdAt(sort: Desc)]); @@index([organizationId, importId]); @@unique([organizationId, id]) |
| ContactPhone | contact_phones | Yes | @@id([contactId, e164]); @@index([organizationId, e164]) |
| ContactEmail | contact_emails | Yes | @@id([contactId, email]); @@index([organizationId, email]) |
| ContactCompany | contact_companies | Yes | @@id([contactId, companyId]); @@index([organizationId, companyId]) |
| Tag | tags | Yes | @@unique([organizationId, name]) |
| RecordTag | record_tags | Yes | @@id([tagId, entityType, entityId]); @@index([organizationId, entityType, entityId]) |
| CustomFieldDefinition | custom_field_definitions | Yes | @@unique([organizationId, entityType, key]); @@index([organizationId, entityType, position]) |
| LeadSource | lead_sources | Yes | @@unique([organizationId, name]); @@unique([organizationId, key]) |
| LostReason | lost_reasons | Yes | @@unique([organizationId, entityType, name]) |
| Lead | leads | Yes | @@index([organizationId, status, createdAt(sort: Desc)]); @@index([organizationId, ownerId, status]); @@index([organizationId, primaryPhoneE164]); @@index([organizationId, primaryEmail]); @@index([organizationId, sourceId]); @@index([organizationId, campaignId]); @@index([organizationId, importId]); @@index([webFormId]); @@unique([organizationId, id]) |
| Campaign | campaigns | Yes | @@unique([organizationId, id]); @@unique([organizationId, code]); @@unique([organizationId, externalPlatform, externalCampaignId]); @@index([organizationId, ownerId, status]); @@index([organizationId, createdAt(sort: Desc)]) |
| LeadPhone | lead_phones | Yes | @@id([leadId, e164]); @@index([organizationId, e164]) |
| LeadEmail | lead_emails | Yes | @@id([leadId, email]); @@index([organizationId, email]) |
| SavedView | saved_views | Yes | @@index([organizationId, entityType]) |
| Pipeline | pipelines | Yes | @@index([organizationId, position]) |
| PipelineStage | pipeline_stages | Yes | @@index([pipelineId, position]); @@index([organizationId]) |
| Deal | deals | Yes | @@index([organizationId, leadId]); @@index([organizationId, sourceId]); @@index([organizationId, pipelineId, stageId]); @@index([organizationId, ownerId, status]); @@index([organizationId, status, closedAt]); @@index([organizationId, companyId]); @@index([organizationId, importId]) |
| DealContact | deal_contacts | Yes | @@id([dealId, contactId]); @@index([organizationId, contactId]) |
| DealStageHistory | deal_stage_history | Yes | @@index([organizationId, toStageId, movedAt]); @@index([dealId, movedAt]) |
| Activity | activities | Yes | @@index([organizationId, entityType, entityId, occurredAt(sort: Desc)]); @@unique([organizationId, id]) |
| ActivityLink | activity_links | Yes | @@id([activityId, entityType, entityId]); @@index([organizationId, entityType, entityId, occurredAt(sort: Desc)]) |
| ActivityParticipant | activity_participants | Yes | @@index([activityId]); @@index([organizationId, contactId]) |
| Mention | mentions | Yes | @@unique([activityId, userId]); @@index([organizationId, userId, createdAt(sort: Desc)]) |
| Task | tasks | Yes | @@index([organizationId, assigneeId, status, dueAt]); @@index([organizationId, entityType, entityId]); @@index([status, dueAt]) |
| Notification | notifications | Yes | @@unique([organizationId, userId, sourceEventId]); @@index([organizationId, userId, inApp, readAt, createdAt(sort: Desc)]); @@index([emailPendingAt]) |
| NotificationPreference | notification_preferences | Yes | @@id([organizationId, userId, type]) |
| NotificationReceipt | notification_receipts | Yes | @@id([organizationId, userId, sourceEventId]); @@index([createdAt]) |
| NotificationEmailBatch | notification_email_batches | Yes | @@unique([organizationId, userId, kind, key]); @@index([organizationId, userId, kind, sentAt]); @@index([sentAt, availableAt]) |
| NotificationStreamTicket | notification_stream_tickets | Yes | @@index([organizationId, userId]); @@index([expiresAt]) |
| FileLink | file_links | Yes | @@id([fileId, entityType, entityId]); @@index([organizationId, entityType, entityId]) |
| ImportJob | import_jobs | Yes | @@index([organizationId, createdAt(sort: Desc)]) |
| ImportRecord | import_records | Yes | @@id([importId, rowIndex]); @@index([organizationId, entityType, entityId]) |
| ImportMapping | import_mappings | Yes | @@unique([organizationId, entityType, headersHash]) |
| ExportJob | export_jobs | Yes | @@index([organizationId, createdAt(sort: Desc)]) |
| FacebookConnection | facebook_connections | Yes | @@unique([id, organizationId]); @@index([connectedById]); @@index([facebookUserId]) |
| FacebookOAuthState | facebook_oauth_states | Yes | @@index([expiresAt]); @@index([organizationId, userId]); @@index([userId]) |
| FacebookPage | facebook_pages | Yes | @@unique([id, organizationId]); @@index([organizationId]); @@index([connectionId, organizationId]) |
| FacebookForm | facebook_forms | Yes | @@unique([pageId, facebookFormId]); @@index([organizationId, pageId]); @@index([defaultOwnerId]); @@index([syncStatus, syncLeaseUntil]); @@index([pageId, organizationId]) |
| FacebookLeadDelivery | facebook_lead_deliveries | Yes | @@unique([pageId, facebookLeadId]); @@index([organizationId, createdAt(sort: Desc)]); @@index([status, nextAttemptAt]); @@index([pageId, organizationId]); @@index([leadId]) |
| FacebookDeletionRequest | facebook_deletion_requests | Global/child | @@index([subjectHash, status]); @@index([status, nextAttemptAt, leaseUntil]); @@index([completedAt]) |
| GmailAccount | gmail_accounts | Yes | @@unique([organizationId, id]); @@index([organizationId, userId, createdAt(sort: Desc)]); @@index([organizationId, status]); @@index([organizationId, email]) |
| GmailOAuthState | gmail_oauth_states | Yes | @@index([organizationId, userId]); @@index([expiresAt]) |
| EmailThread | email_threads | Yes | @@unique([organizationId, id]); @@unique([organizationId, rootKey]); @@index([organizationId, lastMessageAt(sort: Desc), id]) |
| EmailRecordLink | email_record_links | Yes | @@unique([organizationId, threadId, leadId]); @@unique([organizationId, threadId, contactId]); @@index([organizationId, leadId, threadId]); @@index([organizationId, contactId, threadId]) |
| EmailMessage | email_messages | Yes | @@unique([organizationId, id]); @@unique([organizationId, fingerprint]); @@unique([organizationId, actorId, idempotencyKey]); @@index([organizationId, threadId, occurredAt, id]); @@index([organizationId, accountId, status]); @@index([status, nextAttemptAt]); @@index([organizationId, expiresAt]); @@index([organizationId, rfcMessageId]) |
| EmailMailboxCopy | email_mailbox_copies | Yes | @@unique([organizationId, accountId, gmailMessageId]); @@index([organizationId, accountId, gmailThreadId]); @@index([organizationId, messageId]) |
| EmailTemplate | email_templates | Yes | @@index([organizationId, shared, ownerId, updatedAt(sort: Desc), id]); @@index([organizationId, channel, archivedAt, updatedAt(sort: Desc), id], map: "email_templates_library_idx") |
| GmailSyncState | gmail_sync_states | Yes | @@unique([organizationId, accountId]); @@index([organizationId, nextAttemptAt]); @@index([nextAttemptAt]) |
| EmailSuppression | email_suppressions | Yes | @@unique([organizationId, recipientKey]) |
| WebForm | web_forms | Yes | @@unique([id, organizationId]); @@index([sourceId]); @@index([createdById]) |
| WebFormSubmission | web_form_submissions | Yes | @@index([formId, createdAt(sort: Desc)]); @@index([leadId]); @@index([organizationId, formId]) |
| AssignmentRule | assignment_rules | Yes | @@index([organizationId, position]) |
| WorkingHours | working_hours | Yes | @@index([fallbackOwnerId]) |
| OutOfOffice | out_of_office | Yes | @@index([organizationId, userId, endsAt]); @@index([userId]) |
| LeadSourceCatalog | lead_source_catalog | Global/child |  |
| TenantEmailSettings | tenant_email_settings | Yes |  |
| EmailAuditLog | email_audit_logs | Yes | @@index([organizationId, createdAt]); @@index([organizationId, targetUserId, action, createdAt]) |
| EmailTokenRevocation | email_token_revocations | Yes | @@index([organizationId, nextAttemptAt]) |

Enums: Plan, UserTokenType, MemberRole, MemberStatus, InboundStatus, NewsletterStatus, LeadStatus, DealStatus, StageType, ActivityType, TaskStatus, EmailVisibility, EmailAuditAction.

Review findings: Google login token SQL/schema drift fixed (PR-018); google_signin is now included in UserTokenType. Campaign→Lead and Deal→Lead have composite tenant FKs from previous sales work. ContactCompany stores organizationId but both relation endpoints still require explicit service/visibility checks; nested presentations now scope both endpoints (PR-014). Activity/Task polymorphic references are service-validated, not conventional FKs. No blanket conversion to composite FKs was attempted against existing data without an orphan audit. DomainEvent is retained and tenant/entity indexed; funnel history depends on that retention. Money uses BigInt; timeline IDs and UUID casts are parameterized. Lead status and Deal stage/type/status serve different lifecycles and are not interchangeable.
