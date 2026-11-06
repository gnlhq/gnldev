-- Written by packages/upgrade-tests/generate/0.16.0.mjs --backend mysql. Do not edit.
CREATE TABLE `gnl_cache` (
  `key` varbinary(3072) NOT NULL,
  `value` longblob NOT NULL,
  `expires_at` bigint DEFAULT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `gnl_counters` (
  `key` varbinary(2560) NOT NULL,
  `field` varbinary(512) NOT NULL,
  `value` double NOT NULL,
  PRIMARY KEY (`key`,`field`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `gnl_message_batches` (
  `thread_id` varbinary(1024) NOT NULL,
  `batch_key` varbinary(2048) NOT NULL,
  `seq_from` int NOT NULL,
  `seq_to` int NOT NULL,
  `ts` bigint NOT NULL,
  PRIMARY KEY (`thread_id`,`batch_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `gnl_messages` (
  `thread_id` varbinary(1024) NOT NULL,
  `seq` int NOT NULL,
  `role` varbinary(64) NOT NULL,
  `text` longblob,
  `embedding` longblob,
  `metadata` longblob,
  `ts` bigint NOT NULL,
  `message` longblob NOT NULL,
  PRIMARY KEY (`thread_id`,`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `gnl_meta` (
  `k` varbinary(1024) NOT NULL,
  `v` longblob NOT NULL,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_meta` VALUES (_binary 'schema_version',_binary '1');
CREATE TABLE `gnl_observations` (
  `thread_id` varbinary(1024) NOT NULL,
  `obs` longblob NOT NULL,
  PRIMARY KEY (`thread_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `gnl_run_journal` (
  `key` varbinary(3072) NOT NULL,
  `run_id` varbinary(2048) DEFAULT NULL,
  `kind` varbinary(32) DEFAULT NULL,
  `suspended` tinyint(1) NOT NULL DEFAULT '0',
  `value` longblob NOT NULL,
  `created_at` bigint NOT NULL,
  `owner` varbinary(1024) DEFAULT NULL,
  `ord` bigint NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`key`),
  KEY `gnl_run_journal_ord` (`ord`),
  KEY `gnl_run_journal_run` (`run_id`,`created_at`),
  KEY `gnl_run_journal_owner` (`owner`,`key`(2000))
) ENGINE=InnoDB AUTO_INCREMENT=13 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo2-cx4dc:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769600123,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769600124,NULL,3);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo2-cx4dc:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-0wdy75\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000000e\"}}',1790769600101,NULL,1);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo7-3t90t:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769600170,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769600171,NULL,6);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo7-3t90t:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-0wdy75\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000000f\"}}',1790769600149,NULL,4);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeog-ob6co:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769600274,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769600275,NULL,12);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeog-ob6co:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-0wdy75\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000011\"}}',1790769600253,NULL,10);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:~o~globex::00000000-0000-4000-8000-000000000001:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-0wdy75\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000010\"}}',1790769600197,NULL,7);
INSERT INTO `gnl_run_journal` VALUES (_binary 'org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769600218,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769600219,NULL,9);
CREATE TABLE `gnl_runs` (
  `run_id` varbinary(2048) NOT NULL,
  `model_steps` int NOT NULL DEFAULT '0',
  `tool_calls` int NOT NULL DEFAULT '0',
  `suspended_count` int NOT NULL DEFAULT '0',
  `outcome` varbinary(32) DEFAULT NULL,
  `status` varbinary(32) NOT NULL,
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  `thread_id` varbinary(1000) DEFAULT NULL,
  `resource_id` varbinary(1000) DEFAULT NULL,
  PRIMARY KEY (`run_id`),
  KEY `gnl_runs_updated` (`updated_at`,`run_id`),
  KEY `gnl_runs_created` (`created_at`,`run_id`),
  KEY `gnl_runs_status` (`status`,`created_at`,`run_id`),
  KEY `gnl_runs_resource` (`resource_id`,`created_at`,`run_id`),
  KEY `gnl_runs_thread` (`thread_id`,`created_at`,`run_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeo2-cx4dc',0,0,0,NULL,_binary 'completed',1790769600125,1790769600125,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeo7-3t90t',0,0,0,NULL,_binary 'completed',1790769600172,1790769600172,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeog-ob6co',0,0,0,NULL,_binary 'completed',1790769600276,1790769600276,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001',0,0,0,NULL,_binary 'completed',1790769600220,1790769600220,NULL,_binary '');
CREATE TABLE `gnl_threads` (
  `id` varbinary(1024) NOT NULL,
  `resource_id` varbinary(1024) NOT NULL,
  `title` longblob,
  `parent_thread_id` varbinary(1024) DEFAULT NULL,
  `metadata` longblob,
  `created_at` bigint NOT NULL,
  `updated_at` bigint NOT NULL,
  `deleted_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `gnl_threads_res` (`resource_id`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `gnl_vectors` (
  `id` varbinary(3072) NOT NULL,
  `text` longblob NOT NULL,
  `embedding` longblob NOT NULL,
  `metadata` longblob,
  `namespace` varbinary(1024) DEFAULT NULL,
  `owner` varbinary(1024) DEFAULT NULL,
  `shared` tinyint(1) DEFAULT NULL,
  `created_at` bigint NOT NULL,
  `doc` varbinary(3072) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `gnl_vectors_doc` (`doc`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE `gnl_work_kv` (
  `key` varbinary(3072) NOT NULL,
  `value` longblob NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_work_kv` VALUES (_binary '__qworkers__',_binary '{\"json\":{}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"at\":1790769600131,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"at\":1790769600178,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeog-ob6co',_binary '{\"json\":{\"at\":1790769600282,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qfail:~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":{\"error\":\"boom\",\"attempts\":1}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeo2-cx4dc',_binary '{\"json\":\"00000000-0000-4000-8000-00000000000e\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeo7-3t90t',_binary '{\"json\":\"00000000-0000-4000-8000-00000000000f\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeog-ob6co',_binary '{\"json\":\"00000000-0000-4000-8000-000000000011\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":\"00000000-0000-4000-8000-000000000010\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeog-ob6co',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
CREATE TABLE `gnl_work_log` (
  `ns` varbinary(1024) NOT NULL,
  `id` varbinary(2048) NOT NULL,
  `payload` longblob NOT NULL,
  `ts` bigint NOT NULL,
  `seq` bigint NOT NULL DEFAULT '0',
  `ord` bigint NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`ns`,`id`),
  KEY `gnl_work_log_ord` (`ord`),
  KEY `gnl_work_log_ns` (`ns`,`ts`),
  KEY `gnl_work_log_seq` (`ns`,`seq`,`ts`,`id`(2000))
) ENGINE=InnoDB AUTO_INCREMENT=39 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000002',_binary '{\"json\":{\"type\":\"t\"}}',1790769600038,0,16);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000003',_binary '{\"json\":{\"type\":\"t\"}}',1790769600042,0,18);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000004',_binary '{\"json\":{\"type\":\"t\"}}',1790769600046,0,20);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000005',_binary '{\"json\":{\"type\":\"t\"}}',1790769600050,0,22);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000006',_binary '{\"json\":{\"type\":\"t\"}}',1790769600054,0,24);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::weekly-report',_binary '{\"json\":{\"type\":\"t\"}}',1790769600083,0,38);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme:ayse:00000000-0000-4000-8000-00000000000c',_binary '{\"json\":{\"type\":\"t\"}}',1790769600078,0,36);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":{\"type\":\"t\"}}',1790769600014,0,6);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000007',_binary '{\"json\":{\"type\":\"t\"}}',1790769600058,0,26);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000008',_binary '{\"json\":{\"type\":\"t\"}}',1790769600062,0,28);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000009',_binary '{\"json\":{\"type\":\"t\"}}',1790769600066,0,30);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-00000000000a',_binary '{\"json\":{\"type\":\"t\"}}',1790769600070,0,32);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-00000000000b',_binary '{\"json\":{\"type\":\"t\"}}',1790769600074,0,34);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"type\":\"t\"}}',1790769600005,0,2);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"type\":\"t\"}}',1790769600010,0,4);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeog-ob6co',_binary '{\"json\":{\"type\":\"t\"}}',1790769600019,0,8);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeol-x1n5k',_binary '{\"json\":{\"type\":\"t\"}}',1790769600024,0,10);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeoq-3nn6l',_binary '{\"json\":{\"type\":\"t\"}}',1790769600029,0,12);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeov-au3lb',_binary '{\"json\":{\"type\":\"t\"}}',1790769600034,0,14);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s0\"}}}',1790769600003,1,1);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s1\"}}}',1790769600008,2,3);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeog-ob6co',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s2\"}}}',1790769600017,4,7);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeol-x1n5k',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s3\"}}}',1790769600022,5,9);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeoq-3nn6l',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s4\"}}}',1790769600027,6,11);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeov-au3lb',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s5\"}}}',1790769600032,7,13);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000002',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme0\"},\"orgId\":\"acme\"}}',1790769600036,8,15);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000003',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme1\"},\"orgId\":\"acme\"}}',1790769600040,9,17);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000004',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme2\"},\"orgId\":\"acme\"}}',1790769600044,10,19);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000005',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme3\"},\"orgId\":\"acme\"}}',1790769600048,11,21);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000006',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme4\"},\"orgId\":\"acme\"}}',1790769600052,12,23);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::weekly-report',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"fixed\"},\"orgId\":\"acme\"}}',1790769600081,19,37);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme:ayse:00000000-0000-4000-8000-00000000000c',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"ayse0\"},\"resourceId\":\"ayse\",\"orgId\":\"acme\"}}',1790769600076,18,35);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"dead\",\"fail\":true},\"orgId\":\"globex\"}}',1790769600012,3,5);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000007',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex0\"},\"orgId\":\"globex\"}}',1790769600056,13,25);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000008',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex1\"},\"orgId\":\"globex\"}}',1790769600060,14,27);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000009',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex2\"},\"orgId\":\"globex\"}}',1790769600064,15,29);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-00000000000a',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex3\"},\"orgId\":\"globex\"}}',1790769600068,16,31);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-00000000000b',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex4\"},\"orgId\":\"globex\"}}',1790769600072,17,33);
CREATE TABLE `gnl_work_seq` (
  `ns` varbinary(1024) NOT NULL,
  `seq` bigint NOT NULL,
  PRIMARY KEY (`ns`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_work_seq` VALUES (_binary 'qjob',19);
CREATE TABLE `gnl_working_memory` (
  `scope_id` varbinary(3072) NOT NULL,
  `data` longblob NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`scope_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
