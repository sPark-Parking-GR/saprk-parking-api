-- Puts the team surface behind a plan, WITHOUT taking it from anyone who already has it.
--
-- Order matters here in one direction only: the grandfathering runs first, so that at no
-- point between statements does a live tenant resolve to a plan that grants fewer staff
-- seats than they are already using.
--
-- Note that assertUsageFitsEntitlements — the application guard that refuses a plan change
-- leaving a tenant over quota — does NOT run for raw SQL. That guard is exactly why this
-- change cannot be made by editing the catalog through the admin API, and exactly why the
-- grandfathering has to be part of this migration rather than a follow-up.

-- 1. Every tenant with a live agreement keeps precisely what they have today: unlimited
-- staff seats, plus the feature flag that from now on gates a surface they could already
-- use. A negotiated override rather than a bespoke plan, so these tenants still receive
-- later corrections to Starter's other terms.
--
-- CANCELLED subscriptions are excluded: they grant nothing to begin with, so there is no
-- capability to preserve.
UPDATE "OperatorSubscription"
SET "entitlementOverride" = '{"maxStaffSeats":null,"features":["team.management"]}'::jsonb
WHERE "status" <> 'CANCELLED'
  AND "entitlementOverride" IS NULL;

-- 2. Starter stops granting staff seats. Zero is a real limit that permits nothing, and is
-- deliberately distinguishable from null/unlimited — an operator on Starter now gets a
-- refusal that says the plan does not include team management, rather than one that says
-- they have run out of something they never bought.
UPDATE "SubscriptionPlan"
SET "entitlements" = '{"maxFacilities":1,"maxTariffPlans":null,"maxStaffSeats":0,"features":[],"commissionBps":0}'::jsonb,
    "description"  = 'One facility and unlimited tariff plans. Team management is not included.',
    "updatedAt"    = CURRENT_TIMESTAMP
WHERE "code" = 'starter';

-- 3. The plan that does include it. Fixed id for the same reason plan_starter has one: any
-- environment re-running this chain must agree on which row this is.
INSERT INTO "SubscriptionPlan" (
  "id", "code", "name", "description", "priceCents", "currency", "interval",
  "entitlements", "isPublic", "sortOrder", "createdAt", "updatedAt"
) VALUES (
  'plan_growth',
  'growth',
  'Growth',
  'Up to five facilities, unlimited tariff plans, and a team of up to ten with per-member permissions.',
  4900,
  'EUR',
  'MONTHLY',
  '{"maxFacilities":5,"maxTariffPlans":null,"maxStaffSeats":10,"features":["team.management"],"commissionBps":0}'::jsonb,
  true,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
