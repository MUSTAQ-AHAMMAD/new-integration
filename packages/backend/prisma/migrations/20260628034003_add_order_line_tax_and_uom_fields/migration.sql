-- AlterTable
ALTER TABLE "BackupIbqOrderLine" ADD COLUMN     "taxIds" TEXT,
ADD COLUMN     "baseUomId" INTEGER,
ADD COLUMN     "baseUomName" TEXT,
ADD COLUMN     "productUomId" INTEGER,
ADD COLUMN     "productUomName" TEXT;

-- AlterTable
ALTER TABLE "BackupOdooOrderLine" ADD COLUMN     "taxIds" TEXT,
ADD COLUMN     "baseUomId" INTEGER,
ADD COLUMN     "baseUomName" TEXT,
ADD COLUMN     "productUomId" INTEGER,
ADD COLUMN     "productUomName" TEXT;
