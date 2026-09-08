-- Profile fields on the person, not on the membership (P8/2, and §1 of the
-- member-lifecycle work).
--
-- `timezone` is the one with an immediate consumer: the start-of-day task
-- email has to know when somebody's day starts. An IANA name, never an
-- offset — an offset is wrong twice a year.

ALTER TABLE "users" ADD COLUMN "job_title" TEXT;
ALTER TABLE "users" ADD COLUMN "phone" TEXT;
ALTER TABLE "users" ADD COLUMN "timezone" TEXT;
ALTER TABLE "users" ADD COLUMN "locale" TEXT;
