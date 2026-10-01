-- Web Push subscriptions: one row per phone that turned notifications on.
--
-- Keyed on device_id, not endpoint: a phone holds at most one subscription, and when iOS
-- rotates it the new endpoint REPLACES the old row instead of leaving a dead one behind
-- for every upload to fan out to.
--
-- HARD-deleted, unlike cats and sightings. Those tombstone because a recycled rowid
-- would re-point an offline client's cached record at a different cat; no client ever
-- caches a subscription id, so there is nothing for a recycled one to corrupt.
--
-- OMISSION LOG: the UNIQUE on device_id is the only index, and it is an upsert key
-- rather than a read optimisation. Rows change only when a phone toggles notifications
-- or its endpoint rotates, so its write cost rounds to zero. The table is read whole on
-- every upload, but it holds a handful of rows (capped by MAX_PUSH_SUBSCRIPTIONS), so a
-- bare SELECT is the right plan.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT    NOT NULL UNIQUE,
  endpoint    TEXT    NOT NULL,
  p256dh      TEXT    NOT NULL,   -- the phone's ECDH public key, base64url
  auth        TEXT    NOT NULL,   -- the phone's 16-byte auth secret, base64url
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
