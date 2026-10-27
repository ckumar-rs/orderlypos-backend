-- Optional half-portion price. Additive and nullable: existing items and old code are unaffected.
ALTER TABLE "menu_items" ADD COLUMN "halfPrice" DECIMAL(12,2);
