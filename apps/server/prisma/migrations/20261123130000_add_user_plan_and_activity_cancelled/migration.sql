-- 最终收尾新增：
-- 1) ActivityStatus 增加 CANCELLED（主办人取消活动，与 CLOSED「已结束」语义分开）
-- 2) 新表 cg_user_plan：生活规划保存（条件与结果均为保存时刻 JSON 快照）
-- 增量变更：不删表、不删列、不动任何已有数据。

-- AlterTable
ALTER TABLE `cg_partner_activity` MODIFY `status` ENUM('OPEN', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE `cg_user_plan` (
    `id` CHAR(25) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `conditions` JSON NOT NULL,
    `result` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cg_user_plan_user_id_created_at_idx`(`user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 与 F-2 口径一致：先统一到库默认 utf8mb4_0900_ai_ci，再加外键（外键两侧排序规则必须一致）
ALTER TABLE `cg_user_plan` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- AddForeignKey
ALTER TABLE `cg_user_plan` ADD CONSTRAINT `cg_user_plan_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;