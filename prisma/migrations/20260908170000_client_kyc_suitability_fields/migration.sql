-- CreateEnum
CREATE TYPE "AnnualIncomeRange" AS ENUM ('UNDER_25K', 'RANGE_25K_50K', 'RANGE_50K_100K', 'RANGE_100K_250K', 'OVER_250K');

-- CreateEnum
CREATE TYPE "SourceOfFunds" AS ENUM ('SALARY', 'BUSINESS_INCOME', 'SAVINGS', 'INVESTMENTS', 'INHERITANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "TradingExperience" AS ENUM ('NONE', 'UNDER_1_YEAR', 'ONE_TO_3_YEARS', 'THREE_TO_5_YEARS', 'OVER_5_YEARS');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('EMPLOYED', 'SELF_EMPLOYED', 'UNEMPLOYED', 'STUDENT', 'RETIRED');

-- CreateEnum
CREATE TYPE "RiskTolerance" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
-- Suitability questionnaire -- nullable, see ClientKycRecord's own schema
-- comment. Nothing has ever written to this table yet, so this is a pure
-- additive change with nothing to backfill.
ALTER TABLE "ClientKycRecord" ADD COLUMN "annualIncome" "AnnualIncomeRange";
ALTER TABLE "ClientKycRecord" ADD COLUMN "sourceOfFunds" "SourceOfFunds";
ALTER TABLE "ClientKycRecord" ADD COLUMN "tradingExperience" "TradingExperience";
ALTER TABLE "ClientKycRecord" ADD COLUMN "employmentStatus" "EmploymentStatus";
ALTER TABLE "ClientKycRecord" ADD COLUMN "riskTolerance" "RiskTolerance";
