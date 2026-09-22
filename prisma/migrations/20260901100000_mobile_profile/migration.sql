-- CreateTable
CREATE TABLE "MobileProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pushToken" TEXT,
    "locale" TEXT,
    "appVersion" TEXT,
    "lastActiveAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MobileProfile_userId_key" ON "MobileProfile"("userId");

-- AddForeignKey
ALTER TABLE "MobileProfile" ADD CONSTRAINT "MobileProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
