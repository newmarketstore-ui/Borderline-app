-- CreateTable
CREATE TABLE "ServiceStore" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopifyLocationId" TEXT,
    "tagMin" INTEGER NOT NULL,
    "tagMax" INTEGER NOT NULL,
    "techsPerDay" INTEGER NOT NULL DEFAULT 1,
    "etaRules" JSONB,
    "openHour" INTEGER NOT NULL DEFAULT 10,
    "closeHour" INTEGER NOT NULL DEFAULT 19,
    "timezone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "address" TEXT,
    "hoursText" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceType" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL DEFAULT 30,
    "priceCents" INTEGER,
    "memberPriceCents" INTEGER,
    "needsEdgeAngle" BOOLEAN NOT NULL DEFAULT false,
    "needsBodyMetrics" BOOLEAN NOT NULL DEFAULT false,
    "stores" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceTicket" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "tagNumber" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "customerName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "shopifyCustomerId" TEXT,
    "memberId" TEXT,
    "services" JSONB NOT NULL,
    "equipment" TEXT,
    "boardInfo" TEXT,
    "edgeAngle" TEXT,
    "heightCm" INTEGER,
    "weightKg" INTEGER,
    "din" TEXT,
    "stanceFront" TEXT,
    "stanceBack" TEXT,
    "stanceWidth" TEXT,
    "customerNotes" TEXT,
    "staffNotes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'qr',
    "consentSms" BOOLEAN NOT NULL DEFAULT true,
    "consentEmail" BOOLEAN NOT NULL DEFAULT true,
    "orderId" TEXT,
    "orderName" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "etaAt" TIMESTAMP(3),
    "etaNote" TEXT,
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "delayCount" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceNotification" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "toEmail" TEXT,
    "toPhone" TEXT,
    "payload" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceStore_shopDomain_key_key" ON "ServiceStore"("shopDomain", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceType_shopDomain_key_key" ON "ServiceType"("shopDomain", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceTicket_token_key" ON "ServiceTicket"("token");

-- CreateIndex
CREATE INDEX "ServiceTicket_shopDomain_storeKey_status_createdAt_idx" ON "ServiceTicket"("shopDomain", "storeKey", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceTicket_shopDomain_storeKey_tagNumber_idx" ON "ServiceTicket"("shopDomain", "storeKey", "tagNumber");

-- CreateIndex
CREATE INDEX "ServiceTicket_shopDomain_email_idx" ON "ServiceTicket"("shopDomain", "email");

-- CreateIndex
CREATE INDEX "ServiceTicket_shopDomain_phone_idx" ON "ServiceTicket"("shopDomain", "phone");

-- CreateIndex
CREATE INDEX "ServiceTicket_shopifyCustomerId_idx" ON "ServiceTicket"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "ServiceNotification_ticketId_createdAt_idx" ON "ServiceNotification"("ticketId", "createdAt");

-- AddForeignKey
ALTER TABLE "ServiceNotification" ADD CONSTRAINT "ServiceNotification_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ServiceTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

