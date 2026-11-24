-- 本轮新增两张表：时光记录的照片（cg_memory_photo）与意见反馈（cg_feedback）。
-- 只做 CREATE，不动任何已验收的表与数据；两条外键指向 cg_memory / cg_user，都是 ON DELETE CASCADE。
--
-- 排序规则：Prisma 的 migrate diff 给新表写死 utf8mb4_unicode_ci，不继承本库默认 utf8mb4_0900_ai_ci，
-- 而外键两侧的排序规则必须一致（阶段3.2 的 B3 实测过）。这里在建表时直接指定 0900_ai_ci，
-- 新表是空表，不需要 CONVERT TO，也不会影响既有表。

-- CreateTable
CREATE TABLE `cg_memory_photo` (
    `id` CHAR(25) NOT NULL,
    `memory_id` CHAR(25) NOT NULL,
    `stored_name` VARCHAR(80) NOT NULL,
    `file_name` VARCHAR(140) NOT NULL,
    `mime_type` VARCHAR(32) NOT NULL,
    `byte_size` INTEGER NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cg_memory_photo_stored_name_key`(`stored_name`),
    INDEX `cg_memory_photo_memory_id_sort_order_idx`(`memory_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- CreateTable
CREATE TABLE `cg_feedback` (
    `id` CHAR(25) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `category` VARCHAR(24) NOT NULL,
    `content` VARCHAR(500) NOT NULL,
    `contact` VARCHAR(60) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_feedback_user_id_created_at_idx`(`user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- AddForeignKey
ALTER TABLE `cg_memory_photo` ADD CONSTRAINT `cg_memory_photo_memory_id_fkey` FOREIGN KEY (`memory_id`) REFERENCES `cg_memory`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cg_feedback` ADD CONSTRAINT `cg_feedback_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
