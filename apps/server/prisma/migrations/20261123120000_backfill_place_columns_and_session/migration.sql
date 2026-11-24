-- 最终收尾补记迁移：把此前两次用 `prisma db push` 落库、未进迁移历史的变更补记进来。
-- 本文件对活库是「已存在对象」的如实记录（执行方式为 migrate resolve --applied，不重复执行）；
-- 对新库按序重放时，本文件真实创建这些对象，结果与活库一致。
-- 不删表、不删列、不动任何数据。

-- 1) 阶段6：cg_campus_place 四个可空列与 campus 索引（独立地图页取消后作为地点数据保留）
ALTER TABLE `cg_campus_place`
    ADD COLUMN `address` VARCHAR(200) NULL,
    ADD COLUMN `campus` VARCHAR(32) NULL,
    ADD COLUMN `latitude` DECIMAL(10, 7) NULL,
    ADD COLUMN `longitude` DECIMAL(10, 7) NULL;

CREATE INDEX `cg_campus_place_campus_idx` ON `cg_campus_place`(`campus`);

-- 2) 阶段4.6：登录会话表
CREATE TABLE `cg_session` (
    `id` CHAR(25) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `user_id` CHAR(25) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cg_session_token_key`(`token` ASC),
    INDEX `cg_session_user_id_idx`(`user_id` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 与 F-2 口径一致：先统一到库默认 utf8mb4_0900_ai_ci，再加外键（外键两侧排序规则必须一致；活库实测已是该排序规则）
ALTER TABLE `cg_session` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

ALTER TABLE `cg_session` ADD CONSTRAINT `cg_session_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `cg_user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;