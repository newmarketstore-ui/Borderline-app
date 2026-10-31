-- CreateTable
CREATE TABLE "SupportConfig" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-5-5',
    "dailyBudgetCents" INTEGER NOT NULL DEFAULT 1500,
    "perVisitorHourly" INTEGER NOT NULL DEFAULT 30,
    "perIpHourly" INTEGER NOT NULL DEFAULT 80,
    "maxTurns" INTEGER NOT NULL DEFAULT 40,
    "staffEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "greetingEn" TEXT NOT NULL DEFAULT 'Hi! Ask me about sizing, stock at our stores, shipping, returns or your order.',
    "greetingFr" TEXT NOT NULL DEFAULT 'Bonjour ! Posez-moi vos questions sur les tailles, le stock en magasin, la livraison, les retours ou votre commande.',
    "extraPrompt" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportKbDoc" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'policy',
    "body" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportKbDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportConversation" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "customerGid" TEXT,
    "memberId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "pageUrl" TEXT,
    "productHandle" TEXT,
    "ipHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "handoffReason" TEXT,
    "handoffSummary" TEXT,
    "handoffAt" TIMESTAMP(3),
    "lastUserAt" TIMESTAMP(3),
    "lastStaffAt" TIMESTAMP(3),
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagNote" TEXT,
    "assignedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta" JSONB,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "deliveredVia" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportUsageDay" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SupportUsageDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportConfig_shopDomain_key" ON "SupportConfig"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "SupportKbDoc_shopDomain_key_key" ON "SupportKbDoc"("shopDomain", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SupportConversation_token_key" ON "SupportConversation"("token");

-- CreateIndex
CREATE INDEX "SupportConversation_shopDomain_status_updatedAt_idx" ON "SupportConversation"("shopDomain", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportConversation_shopDomain_visitorId_createdAt_idx" ON "SupportConversation"("shopDomain", "visitorId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportConversation_shopDomain_ipHash_createdAt_idx" ON "SupportConversation"("shopDomain", "ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "SupportConversation_customerGid_idx" ON "SupportConversation"("customerGid");

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportUsageDay_shopDomain_day_key" ON "SupportUsageDay"("shopDomain", "day");

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

