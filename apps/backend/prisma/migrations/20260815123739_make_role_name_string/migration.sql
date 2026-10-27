/*
  `roles.name` changes from the fixed `StaffRoleName` enum to a plain TEXT
  column, so an Owner can create custom roles with any name beyond the
  seeded 11 (e.g. "Display", "Host", "Valet"). Hand-edited from Prisma's
  auto-generated drop-and-recreate version (which would have destroyed
  every existing role's `name` value) to an in-place ALTER COLUMN ... USING
  cast instead, which preserves both the data and the existing
  `roles_restaurantId_name_key` unique index untouched.
*/

-- AlterTable
ALTER TABLE "roles" ALTER COLUMN "name" TYPE TEXT USING "name"::text;

-- DropEnum
DROP TYPE "StaffRoleName";
