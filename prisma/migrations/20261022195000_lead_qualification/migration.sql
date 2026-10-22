-- PostgreSQL supplies the constant default for existing rows without a table rewrite.
-- Keep lock acquisition bounded; retry the release if a long transaction holds the table.
SET lock_timeout = '5s';
ALTER TABLE "leads" ADD COLUMN "qualification" JSONB NOT NULL DEFAULT '{}';
RESET lock_timeout;

-- Application rollback can leave this additive column in place, preserving saved facts.
