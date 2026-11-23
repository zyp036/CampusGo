-- CreateTable
CREATE TABLE `cg_user` (
    `id` CHAR(25) NOT NULL,
    `user_code` VARCHAR(24) NOT NULL,
    `nickname` VARCHAR(16) NOT NULL,
    `signature` VARCHAR(120) NOT NULL DEFAULT '',
    `school` VARCHAR(64) NOT NULL DEFAULT '江苏大学',
    `major` VARCHAR(64) NULL,
    `grade` VARCHAR(16) NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `total_exp` INTEGER NOT NULL DEFAULT 0,
    `points` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cg_user_user_code_key`(`user_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_user_preference` (
    `id` CHAR(25) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `group_key` VARCHAR(24) NOT NULL,
    `option_key` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_user_preference_user_id_group_key_enabled_idx`(`user_id`, `group_key`, `enabled`),
    UNIQUE INDEX `cg_user_preference_user_id_group_key_option_key_key`(`user_id`, `group_key`, `option_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_campus_place` (
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `category` VARCHAR(24) NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `best_time` VARCHAR(64) NULL,
    `duration_label` VARCHAR(32) NULL,
    `distance_label` VARCHAR(32) NULL,
    `cover_gradient` VARCHAR(32) NOT NULL,
    `rating` DECIMAL(2, 1) NOT NULL DEFAULT 0,
    `tags` JSON NOT NULL,
    `source` ENUM('DEMO', 'VERIFIED') NOT NULL DEFAULT 'DEMO',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_campus_place_category_idx`(`category`),
    INDEX `cg_campus_place_name_idx`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_challenge` (
    `id` VARCHAR(32) NOT NULL,
    `kind` ENUM('DAILY', 'EXPLORE') NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `description` VARCHAR(200) NOT NULL,
    `exp` INTEGER NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_challenge_kind_active_idx`(`kind`, `active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_user_challenge` (
    `id` CHAR(25) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `challenge_id` VARCHAR(32) NOT NULL,
    `exp_awarded` INTEGER NOT NULL,
    `points_awarded` INTEGER NOT NULL,
    `completed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_user_challenge_user_id_completed_at_idx`(`user_id`, `completed_at`),
    INDEX `cg_user_challenge_challenge_id_idx`(`challenge_id`),
    UNIQUE INDEX `cg_user_challenge_user_id_challenge_id_key`(`user_id`, `challenge_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_badge` (
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(32) NOT NULL,
    `description` VARCHAR(120) NOT NULL,
    `icon_key` VARCHAR(32) NOT NULL,
    `metric` ENUM('NONE', 'TASK', 'EXPLORE_TASK', 'ACTIVITY') NOT NULL DEFAULT 'NONE',
    `target` INTEGER NULL,
    `unlock_note` VARCHAR(255) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_badge_active_sort_order_idx`(`active`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_user_badge` (
    `id` CHAR(25) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `badge_id` VARCHAR(32) NOT NULL,
    `unlocked_at` DATETIME(3) NOT NULL,
    `source` ENUM('AUTO', 'SEED') NOT NULL DEFAULT 'AUTO',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_user_badge_badge_id_idx`(`badge_id`),
    UNIQUE INDEX `cg_user_badge_user_id_badge_id_key`(`user_id`, `badge_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_memory` (
    `id` CHAR(25) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `date_key` DATE NOT NULL,
    `place_id` VARCHAR(32) NULL,
    `location_label` VARCHAR(120) NOT NULL,
    `activity_type` VARCHAR(32) NOT NULL,
    `exp_gained` INTEGER NOT NULL DEFAULT 0,
    `photo_count` INTEGER NOT NULL DEFAULT 0,
    `cover_gradient` VARCHAR(32) NOT NULL,
    `note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_memory_user_id_date_key_idx`(`user_id`, `date_key`),
    INDEX `cg_memory_place_id_idx`(`place_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_partner_activity` (
    `id` VARCHAR(32) NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `host_user_id` CHAR(25) NULL,
    `host_display_name` VARCHAR(40) NOT NULL,
    `host_identity` VARCHAR(60) NULL,
    `category` VARCHAR(24) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `location` VARCHAR(120) NOT NULL,
    `starts_at` DATETIME(3) NULL,
    `date_label` VARCHAR(40) NOT NULL,
    `capacity` INTEGER NOT NULL,
    `interest_tags` JSON NOT NULL,
    `cover_gradient` VARCHAR(32) NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_partner_activity_category_status_idx`(`category`, `status`),
    INDEX `cg_partner_activity_starts_at_idx`(`starts_at`),
    INDEX `cg_partner_activity_host_user_id_idx`(`host_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_activity_participant` (
    `id` CHAR(25) NOT NULL,
    `activity_id` VARCHAR(32) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_activity_participant_user_id_joined_at_idx`(`user_id`, `joined_at`),
    UNIQUE INDEX `cg_activity_participant_activity_id_user_id_key`(`activity_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cg_user_favorite_place` (
    `id` CHAR(25) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `place_id` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_user_favorite_place_user_id_created_at_idx`(`user_id`, `created_at`),
    UNIQUE INDEX `cg_user_favorite_place_user_id_place_id_key`(`user_id`, `place_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cg_user_preference` ADD CONSTRAINT `cg_user_preference_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_user_challenge` ADD CONSTRAINT `cg_user_challenge_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_user_challenge` ADD CONSTRAINT `cg_user_challenge_challenge_id_fkey` FOREIGN KEY (`challenge_id`) REFERENCES `cg_challenge`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_user_badge` ADD CONSTRAINT `cg_user_badge_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_user_badge` ADD CONSTRAINT `cg_user_badge_badge_id_fkey` FOREIGN KEY (`badge_id`) REFERENCES `cg_badge`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_memory` ADD CONSTRAINT `cg_memory_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_memory` ADD CONSTRAINT `cg_memory_place_id_fkey` FOREIGN KEY (`place_id`) REFERENCES `cg_campus_place`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_partner_activity` ADD CONSTRAINT `cg_partner_activity_host_user_id_fkey` FOREIGN KEY (`host_user_id`) REFERENCES `cg_user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_activity_participant` ADD CONSTRAINT `cg_activity_participant_activity_id_fkey` FOREIGN KEY (`activity_id`) REFERENCES `cg_partner_activity`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_activity_participant` ADD CONSTRAINT `cg_activity_participant_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_user_favorite_place` ADD CONSTRAINT `cg_user_favorite_place_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_user_favorite_place` ADD CONSTRAINT `cg_user_favorite_place_place_id_fkey` FOREIGN KEY (`place_id`) REFERENCES `cg_campus_place`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

