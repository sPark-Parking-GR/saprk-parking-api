#!/usr/bin/env bash
set -euo pipefail

# Filters `prisma migrate diff --script` output down to genuinely new drift.
#
# Three divergences between prisma/schema.prisma and the hand-written migration SQL
# are permanent, not bugs: Prisma's schema language has no syntax for
#   1. GENERATED ALWAYS ... STORED columns (Facility.geog, RawPlace.geog)
#   2. an operator-class GIN index (Facility_name_trgm_idx uses gin_trgm_ops)
#   3. an explicit array column default (TariffPlan.vehicleTypes DEFAULT ARRAY[]::...)
# so `prisma migrate diff` reports all three on every single run, forever. `--exit-code`
# only signals "some diff exists" and cannot allow-list specific entries, so this script
# greps the generated SQL for exactly those three signatures instead and fails only on
# whatever is left over afterwards — i.e. drift nobody has reviewed yet.

diff_file="${1:?usage: check-prisma-drift.sh <path to migrate-diff --script output>}"

if [ ! -s "$diff_file" ]; then
  echo "Prisma schema drift check: diff is empty, nothing to do."
  exit 0
fi

residual="$(
  grep -Ev '^[[:space:]]*(--.*)?[[:space:]]*$' "$diff_file" \
    | grep -Fv '"geog"' \
    | grep -Fv 'Facility_name_trgm_idx' \
    | grep -Fv '"vehicleTypes"' \
    || true
)"

if [ -n "$residual" ]; then
  echo "Unexpected Prisma schema drift found (beyond the 3 known, allow-listed divergences):"
  echo "$residual"
  echo
  echo "Full diff for context:"
  cat "$diff_file"
  echo
  echo "If this is new, intentional, hand-written SQL (like geog/trgm/array-default above)," \
       "extend the allow-list in this script. If it is not intentional, prisma migrate dev" \
       "would generate a corrective migration for it — do not run that; fix schema.prisma" \
       "or the migration by hand instead."
  exit 1
fi

echo "Prisma schema drift check passed: only the 3 known divergences are present"
echo "(PostGIS geog generated columns, Facility name trigram index, TariffPlan.vehicleTypes default)."
