-- Enforce at most one active default tariff plan per facility. The service unsets
-- other defaults in-transaction on create/update; this partial unique index is the
-- DB-level backstop against a concurrent race leaving two active defaults. Soft-
-- deleted plans (isActive = false) are excluded so deactivating a default never
-- blocks promoting a replacement.
CREATE UNIQUE INDEX "TariffPlan_facility_active_default_key"
  ON "TariffPlan" ("facilityId")
  WHERE "isDefault" AND "isActive";
