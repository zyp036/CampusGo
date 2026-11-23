-- 阶段3.2 补充迁移：把 11 张业务表的排序规则统一到库默认 utf8mb4_0900_ai_ci。
--
-- 为什么要单独一条迁移：Prisma 6.19.3 生成 MySQL DDL 时给每张表硬编码
--   DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
-- 不继承 campusgo 的库默认（阶段3.1 F-2 已把库默认统一为 utf8mb4_0900_ai_ci）。
-- Schema 里没有能表达表级排序规则的属性，所以这一步只能以手写 SQL 进迁移历史，
-- 任何按本目录重放的库都会得到同样的结果，不依赖谁手工跑过 ALTER。
--
-- 不会被以后的迁移反复回退：本机实测 prisma migrate diff --from-url(真实库) --to-schema-datamodel(本 Schema)
-- 在转换前后都只输出「This is an empty migration」，说明 Prisma 的比较口径不含表级排序规则。
--
-- 只改排序规则：不删表、不删列、不改任何数据，此刻 11 张表都是 0 行。
-- CONVERT TO 会重建列，而互相引用的外键两侧排序规则必须一致，所以转换期间先关外键检查。

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE `cg_user` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_user_preference` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_campus_place` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_challenge` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_user_challenge` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_badge` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_user_badge` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_memory` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_partner_activity` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_activity_participant` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `cg_user_favorite_place` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

SET FOREIGN_KEY_CHECKS = 1;
