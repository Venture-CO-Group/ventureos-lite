-- An immediate-email channel for notifications (P8/2).
--
-- Nullable, like the other three: NULL means "no opinion — use the per-type
-- default in src/modules/notifications/types.ts". A column default would be a
-- second set of defaults that silently disagrees with the code's.

ALTER TABLE "notification_preferences" ADD COLUMN "email_now" BOOLEAN;
