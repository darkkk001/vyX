-- Group volume step ("lot multiplier"). Null = the symbol's own step. Additive only.
ALTER TABLE "Group" ADD COLUMN "lotStep" DECIMAL(10,2);
