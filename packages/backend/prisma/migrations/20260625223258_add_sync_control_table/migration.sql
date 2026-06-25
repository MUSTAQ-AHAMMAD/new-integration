-- CreateTable
CREATE TABLE "SyncControl" (
    "id" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncControl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncControl_serviceName_key" ON "SyncControl"("serviceName");

-- CreateIndex
CREATE INDEX "SyncControl_serviceName_idx" ON "SyncControl"("serviceName");

-- CreateIndex
CREATE INDEX "SyncControl_enabled_idx" ON "SyncControl"("enabled");
