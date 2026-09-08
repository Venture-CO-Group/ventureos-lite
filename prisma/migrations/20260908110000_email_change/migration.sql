-- Staged email changes (§4).
--
-- An email change changes the sign-in identity, so a typo in the new address
-- locks somebody out of their own account and nobody finds out until they try
-- to sign in. The change waits here until a link sent to the NEW address is
-- clicked; the old address keeps working until then.

CREATE TABLE "email_changes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "new_email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "requested_by" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_changes_token_hash_key" ON "email_changes"("token_hash");
CREATE INDEX "email_changes_user_id_confirmed_at_idx" ON "email_changes"("user_id", "confirmed_at");
