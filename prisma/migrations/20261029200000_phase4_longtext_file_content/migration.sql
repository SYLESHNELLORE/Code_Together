-- File contents can exceed MySQL TEXT's 64 KiB limit. LONGTEXT keeps the
-- existing column, data and foreign keys while raising the capacity to 4 GiB.
-- The API still enforces a 1 MB per-file limit.
ALTER TABLE `project_files` MODIFY `content` LONGTEXT NOT NULL;
