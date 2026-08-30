-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('EVIDENCE_MAP', 'LITERATURE_REVIEW', 'SYSTEMATIC_REVIEW');

-- CreateEnum
CREATE TYPE "ProjectVisibility" AS ENUM ('PRIVATE', 'WORKSPACE');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "type" "ProjectType" NOT NULL DEFAULT 'LITERATURE_REVIEW',
ADD COLUMN     "visibility" "ProjectVisibility" NOT NULL DEFAULT 'PRIVATE';
