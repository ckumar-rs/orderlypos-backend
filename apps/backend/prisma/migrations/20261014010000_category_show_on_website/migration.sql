-- Per-category switch: hide a category from the website / online ordering menu.
ALTER TABLE "menu_categories" ADD COLUMN "showOnWebsite" BOOLEAN NOT NULL DEFAULT true;
