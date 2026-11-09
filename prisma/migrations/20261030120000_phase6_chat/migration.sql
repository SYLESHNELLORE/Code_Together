-- Phase 6: persistent project chat.
-- Additive only: the existing rooms/chat_messages tables and their data are
-- preserved. `rooms.project_id` becomes unique so each project has exactly one
-- canonical chat room and joins can safely upsert it.
ALTER TABLE `rooms` ADD UNIQUE INDEX `rooms_project_id_key`(`project_id`);

-- `client_message_id` is an idempotency key supplied by the client for a single
-- send attempt; the unique index makes reconnect retries create one row.
-- `deleted_at`/`deleted_by_id` provide a soft-delete audit trail.
ALTER TABLE `chat_messages` ADD COLUMN `client_message_id` VARCHAR(64) NULL,
    ADD COLUMN `deleted_at` DATETIME(3) NULL,
    ADD COLUMN `deleted_by_id` CHAR(36) NULL;

CREATE UNIQUE INDEX `chat_messages_room_id_client_message_id_key` ON `chat_messages`(`room_id`, `client_message_id`);
CREATE INDEX `chat_messages_deleted_by_id_idx` ON `chat_messages`(`deleted_by_id`);

ALTER TABLE `chat_messages` ADD CONSTRAINT `chat_messages_deleted_by_id_fkey` FOREIGN KEY (`deleted_by_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
