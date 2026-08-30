-- The serverless object plane stores private PDFs in the one approved
-- Supabase Storage bucket. Existing local rows remain representable only for
-- migration/reference tests; production creation must select this provider.
ALTER TYPE "AssetStorageProvider" ADD VALUE IF NOT EXISTS 'SUPABASE_STORAGE';
