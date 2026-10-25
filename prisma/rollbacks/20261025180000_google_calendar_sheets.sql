-- LOCAL EMPTY-SCHEMA VALIDATION ONLY. Production rollback preserves resource mappings.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM google_calendar_links)
 OR EXISTS(SELECT 1 FROM google_calendar_events)
 OR EXISTS(SELECT 1 FROM google_sheets) THEN
   RAISE EXCEPTION 'Refusing to remove populated Google resource mappings';
 END IF;
END $$;
DROP TABLE google_calendar_events, google_sheets, google_calendar_links;
DROP INDEX tasks_organization_id_id_key;
