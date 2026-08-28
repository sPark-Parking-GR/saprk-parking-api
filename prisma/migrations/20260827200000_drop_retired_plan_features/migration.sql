-- Strips two feature codes that no longer exist from the entitlement blobs that may still
-- name them.
--
-- SUBSCRIPTION_FEATURES is a closed set and entitlementsSchema is .strict(), so the codes it
-- no longer lists are not ignored on read — they fail the parse. resolveEffective parses on
-- EVERY call, and it is now on the booking quote path as well as the admin one, so a single
-- surviving 'api.access' or 'branding.custom' in a plan would turn every quote, facility
-- create, tariff create and staff-seat add for every operator on that plan into an uncaught
-- ZodError. Dropping a member from that union is therefore a data migration, not a type edit.
--
-- The codes stay retired: nothing here reintroduces them, it only removes them from storage.

-- 1. The catalog. jsonb_agg over the filtered elements rather than a '-' on the array,
-- because '-' takes an index and the position of a retired code is not known per row.
-- COALESCE covers the plan whose feature list was ONLY retired codes: jsonb_agg over an
-- empty set is NULL, and jsonb_set with NULL would erase the whole entitlements blob.
UPDATE "SubscriptionPlan"
SET "entitlements" = jsonb_set(
      "entitlements",
      '{features}',
      COALESCE(
        (
          SELECT jsonb_agg(feature)
          FROM jsonb_array_elements_text("entitlements" -> 'features') AS feature
          WHERE feature NOT IN ('api.access', 'branding.custom')
        ),
        '[]'::jsonb
      )
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "entitlements" -> 'features' @> '["api.access"]'::jsonb
   OR "entitlements" -> 'features' @> '["branding.custom"]'::jsonb;

-- 2. Negotiated deviations, which parse through the same shape (entitlementOverrideSchema is
-- entitlementsSchema.partial(), so it is strict and enum-checked too) and can carry a
-- features list of their own — 20260817400000 wrote exactly such an override for every live
-- tenant. An override that names `features` replaces the plan's list outright, so an empty
-- array after filtering is a real and correct value here rather than a missing key.
UPDATE "OperatorSubscription"
SET "entitlementOverride" = jsonb_set(
      "entitlementOverride",
      '{features}',
      COALESCE(
        (
          SELECT jsonb_agg(feature)
          FROM jsonb_array_elements_text("entitlementOverride" -> 'features') AS feature
          WHERE feature NOT IN ('api.access', 'branding.custom')
        ),
        '[]'::jsonb
      )
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "entitlementOverride" -> 'features' @> '["api.access"]'::jsonb
   OR "entitlementOverride" -> 'features' @> '["branding.custom"]'::jsonb;
