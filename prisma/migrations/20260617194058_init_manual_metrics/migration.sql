-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualDailyMetric" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "locationId" TEXT NOT NULL,
    "locationName" TEXT,
    "storeVisitGroups" INTEGER NOT NULL DEFAULT 0,
    "channelWalkIn" INTEGER NOT NULL DEFAULT 0,
    "channelGoogleMaps" INTEGER NOT NULL DEFAULT 0,
    "channelMeta" INTEGER NOT NULL DEFAULT 0,
    "channelTiktok" INTEGER NOT NULL DEFAULT 0,
    "channelXiaohongshu" INTEGER NOT NULL DEFAULT 0,
    "channelReferral" INTEGER NOT NULL DEFAULT 0,
    "channelRepeatCustomer" INTEGER NOT NULL DEFAULT 0,
    "channelWebsite" INTEGER NOT NULL DEFAULT 0,
    "channelPhoneSms" INTEGER NOT NULL DEFAULT 0,
    "channelOther" INTEGER NOT NULL DEFAULT 0,
    "channelUnknown" INTEGER NOT NULL DEFAULT 0,
    "trafficFactors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "submittedByName" TEXT,
    "submittedByEmail" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualDailyMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualDailyMetricAudit" (
    "id" TEXT NOT NULL,
    "metricId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB NOT NULL,
    "actorName" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualDailyMetricAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualDailyMetric_shopDomain_businessDate_idx" ON "ManualDailyMetric"("shopDomain", "businessDate");

-- CreateIndex
CREATE INDEX "ManualDailyMetric_shopDomain_locationId_idx" ON "ManualDailyMetric"("shopDomain", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualDailyMetric_shopDomain_businessDate_locationId_key" ON "ManualDailyMetric"("shopDomain", "businessDate", "locationId");

-- CreateIndex
CREATE INDEX "ManualDailyMetricAudit_metricId_idx" ON "ManualDailyMetricAudit"("metricId");

-- CreateIndex
CREATE INDEX "ManualDailyMetricAudit_createdAt_idx" ON "ManualDailyMetricAudit"("createdAt");

-- AddForeignKey
ALTER TABLE "ManualDailyMetricAudit" ADD CONSTRAINT "ManualDailyMetricAudit_metricId_fkey" FOREIGN KEY ("metricId") REFERENCES "ManualDailyMetric"("id") ON DELETE CASCADE ON UPDATE CASCADE;
