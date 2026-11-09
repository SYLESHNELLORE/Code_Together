-- Phase 7: bounded execution job metadata.
-- Additive only. Full stdout/stderr streams are never persisted; these columns
-- hold capped previews enforced by the API process.
CREATE TABLE `execution_jobs` (
    `id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NOT NULL,
    `file_id` CHAR(36) NULL,
    `user_id` CHAR(36) NOT NULL,
    `language` VARCHAR(40) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `active_key` VARCHAR(80) NULL,
    `exit_code` INTEGER NULL,
    `signal` VARCHAR(32) NULL,
    `timed_out` BOOLEAN NOT NULL DEFAULT false,
    `cancelled` BOOLEAN NOT NULL DEFAULT false,
    `output_truncated` BOOLEAN NOT NULL DEFAULT false,
    `stdout` TEXT NOT NULL,
    `stderr` TEXT NOT NULL,
    `error_code` VARCHAR(64) NULL,
    `error_message` VARCHAR(500) NULL,
    `duration_ms` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,

    UNIQUE INDEX `execution_jobs_active_key_key`(`active_key`),
    INDEX `execution_jobs_project_id_created_at_idx`(`project_id`, `created_at`),
    INDEX `execution_jobs_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `execution_jobs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `execution_jobs` ADD CONSTRAINT `execution_jobs_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `execution_jobs` ADD CONSTRAINT `execution_jobs_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `project_files`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `execution_jobs` ADD CONSTRAINT `execution_jobs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
