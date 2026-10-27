ALTER TABLE "restaurants" ADD COLUMN "aiEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "aiProvider" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "aiBaseUrl" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "aiTokenSealed" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "aiHistoryDays" INTEGER NOT NULL DEFAULT 28;
ALTER TABLE "restaurants" ADD COLUMN "aiHorizonDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "restaurants" ADD COLUMN "aiLeadTimeDays" INTEGER;
ALTER TABLE "restaurants" ADD COLUMN "weatherBaseUrl" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "weatherApiKeySealed" TEXT;

ALTER TABLE "ingredients" ADD COLUMN "leadTimeDays" DECIMAL(6,2);

CREATE TABLE "demand_forecasts" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "forecastNumber" TEXT NOT NULL,
  "historyDays" INTEGER NOT NULL,
  "horizonDays" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  "model" TEXT,
  "weatherUsed" BOOLEAN NOT NULL DEFAULT false,
  "modelError" TEXT,
  "generatedById" TEXT NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "demand_forecasts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "demand_forecasts_branchId_forecastNumber_key" ON "demand_forecasts"("branchId", "forecastNumber");
CREATE INDEX "demand_forecasts_branchId_idx" ON "demand_forecasts"("branchId");
ALTER TABLE "demand_forecasts" ADD CONSTRAINT "demand_forecasts_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "demand_forecasts" ADD CONSTRAINT "demand_forecasts_generatedById_fkey"
  FOREIGN KEY ("generatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "demand_forecast_lines" (
  "id" TEXT NOT NULL,
  "forecastId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "menuItemId" TEXT,
  "ingredientId" TEXT,
  "name" TEXT NOT NULL,
  "unit" TEXT,
  "historyQty" DECIMAL(12,3) NOT NULL,
  "dailyVelocity" DECIMAL(12,3) NOT NULL,
  "localForecastQty" DECIMAL(12,3) NOT NULL,
  "modelForecastQty" DECIMAL(12,3),
  "forecastQty" DECIMAL(12,3) NOT NULL,
  "leadTimeDays" DECIMAL(6,2),
  "currentStock" DECIMAL(12,3),
  "suggestedReorderQty" DECIMAL(12,3),
  CONSTRAINT "demand_forecast_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "demand_forecast_lines_forecastId_idx" ON "demand_forecast_lines"("forecastId");
ALTER TABLE "demand_forecast_lines" ADD CONSTRAINT "demand_forecast_lines_forecastId_fkey"
  FOREIGN KEY ("forecastId") REFERENCES "demand_forecasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "demand_forecast_lines" ADD CONSTRAINT "demand_forecast_lines_menuItemId_fkey"
  FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "demand_forecast_lines" ADD CONSTRAINT "demand_forecast_lines_ingredientId_fkey"
  FOREIGN KEY ("ingredientId") REFERENCES "ingredients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
