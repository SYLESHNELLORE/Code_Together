-- AlterTable
ALTER TABLE `project_members` MODIFY `role` ENUM('OWNER', 'ADMIN', 'EDITOR', 'VIEWER') NOT NULL DEFAULT 'EDITOR';

-- CreateTable
CREATE TABLE `project_invitations` (
    `id` CHAR(36) NOT NULL,
    `project_id` CHAR(36) NOT NULL,
    `invited_by_id` CHAR(36) NOT NULL,
    `accepted_by_id` CHAR(36) NULL,
    `email` VARCHAR(254) NULL,
    `role` ENUM('OWNER', 'ADMIN', 'EDITOR', 'VIEWER') NOT NULL DEFAULT 'EDITOR',
    `token_hash` VARCHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `used_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `project_invitations_token_hash_key`(`token_hash`),
    INDEX `project_invitations_project_id_created_at_idx`(`project_id`, `created_at`),
    INDEX `project_invitations_email_created_at_idx`(`email`, `created_at`),
    INDEX `project_invitations_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `project_invitations` ADD CONSTRAINT `project_invitations_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_invitations` ADD CONSTRAINT `project_invitations_invited_by_id_fkey` FOREIGN KEY (`invited_by_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_invitations` ADD CONSTRAINT `project_invitations_accepted_by_id_fkey` FOREIGN KEY (`accepted_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill owner membership rows so the project roster always contains the
-- owner. This is additive: existing memberships are kept and only promoted to
-- OWNER for the actual project owner.
INSERT INTO `project_members` (`project_id`, `user_id`, `role`, `joined_at`)
SELECT `id`, `owner_id`, 'OWNER', `created_at` FROM `projects`
ON DUPLICATE KEY UPDATE `role` = 'OWNER';
