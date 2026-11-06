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
) ENGINE=InnoDB AUTO_INCREMENT=181 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo2-cx4dc:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769600893,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769600894,NULL,3);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo2-cx4dc:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000000e\"}}',1790769600871,NULL,1);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo7-3t90t:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769600940,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769600941,NULL,6);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeo7-3t90t:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000000f\"}}',1790769600919,NULL,4);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeog-ob6co:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601044,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601045,NULL,12);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeog-ob6co:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000011\"}}',1790769601023,NULL,10);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeol-x1n5k:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601095,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601096,NULL,15);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeol-x1n5k:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000012\"}}',1790769601074,NULL,13);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeoq-3nn6l:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601147,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601148,NULL,18);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeoq-3nn6l:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000013\"}}',1790769601126,NULL,16);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeov-au3lb:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601200,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601201,NULL,21);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeov-au3lb:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000014\"}}',1790769601179,NULL,19);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zep0-0wdy7:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601254,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601255,NULL,24);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zep0-0wdy7:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000015\"}}',1790769601233,NULL,22);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zep5-gsfn4:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601309,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601310,NULL,27);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zep5-gsfn4:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000016\"}}',1790769601288,NULL,25);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepa-flbxl:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601365,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601366,NULL,30);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepa-flbxl:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000017\"}}',1790769601344,NULL,28);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepf-jpjoy:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601422,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601423,NULL,33);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepf-jpjoy:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000018\"}}',1790769601401,NULL,31);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepk-iclf6:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601480,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601481,NULL,36);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepk-iclf6:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000019\"}}',1790769601459,NULL,34);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepp-b20ak:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601539,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601540,NULL,39);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepp-b20ak:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000001a\"}}',1790769601518,NULL,37);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepu-wcazd:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601599,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601600,NULL,42);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepu-wcazd:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000001b\"}}',1790769601578,NULL,40);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepz-c7yw5:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601660,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601661,NULL,45);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zepz-c7yw5:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000001c\"}}',1790769601639,NULL,43);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeq4-3omq7:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601722,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601723,NULL,48);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeq4-3omq7:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000001d\"}}',1790769601701,NULL,46);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeq9-8xhqz:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601785,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601786,NULL,51);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeq9-8xhqz:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000001e\"}}',1790769601764,NULL,49);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqe-9f7ve:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601849,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601850,NULL,54);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqe-9f7ve:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000001f\"}}',1790769601828,NULL,52);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqj-uletq:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601914,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601915,NULL,57);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqj-uletq:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000020\"}}',1790769601893,NULL,55);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqo-6wpjm:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769601980,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769601981,NULL,60);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqo-6wpjm:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000021\"}}',1790769601959,NULL,58);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqt-nuxoy:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602047,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602048,NULL,63);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqt-nuxoy:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000022\"}}',1790769602026,NULL,61);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqy-ygau7:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602115,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602116,NULL,66);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeqy-ygau7:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000023\"}}',1790769602094,NULL,64);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zer3-rbgjk:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602184,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602185,NULL,69);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zer3-rbgjk:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000024\"}}',1790769602163,NULL,67);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zer8-t976a:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602254,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602255,NULL,72);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zer8-t976a:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000025\"}}',1790769602233,NULL,70);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zerd-wcwtf:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602325,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602326,NULL,75);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zerd-wcwtf:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000026\"}}',1790769602304,NULL,73);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeri-w0wln:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602397,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602398,NULL,78);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeri-w0wln:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000027\"}}',1790769602376,NULL,76);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zern-j2ir4:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602470,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602471,NULL,81);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zern-j2ir4:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000028\"}}',1790769602449,NULL,79);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zers-931ny:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602544,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602545,NULL,84);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zers-931ny:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000029\"}}',1790769602523,NULL,82);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zerx-bkvz7:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602619,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602620,NULL,87);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zerx-bkvz7:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000002a\"}}',1790769602598,NULL,85);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zes2-zbyxf:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602695,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602696,NULL,90);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zes2-zbyxf:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000002b\"}}',1790769602674,NULL,88);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zes7-nihlz:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602772,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602773,NULL,93);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zes7-nihlz:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000002c\"}}',1790769602751,NULL,91);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesc-ul3xm:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602850,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602851,NULL,96);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesc-ul3xm:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000002d\"}}',1790769602829,NULL,94);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesh-qx9rk:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769602929,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769602930,NULL,99);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesh-qx9rk:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000002e\"}}',1790769602908,NULL,97);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesm-hpp5f:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603009,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603010,NULL,102);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesm-hpp5f:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000002f\"}}',1790769602988,NULL,100);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesr-5g6g2:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603090,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603091,NULL,105);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesr-5g6g2:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000030\"}}',1790769603069,NULL,103);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesw-qt4k0:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603172,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603173,NULL,108);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zesw-qt4k0:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000031\"}}',1790769603151,NULL,106);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zet1-1rd4y:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603255,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603256,NULL,111);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zet1-1rd4y:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000032\"}}',1790769603234,NULL,109);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zet6-crf1f:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603339,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603340,NULL,114);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zet6-crf1f:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000033\"}}',1790769603318,NULL,112);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetb-tk6x3:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603424,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603425,NULL,117);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetb-tk6x3:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000034\"}}',1790769603403,NULL,115);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetg-zaisz:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603510,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603511,NULL,120);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetg-zaisz:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000035\"}}',1790769603489,NULL,118);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetl-tiogq:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603597,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603598,NULL,123);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetl-tiogq:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000036\"}}',1790769603576,NULL,121);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetq-2lavf:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603685,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603686,NULL,126);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetq-2lavf:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000037\"}}',1790769603664,NULL,124);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetv-e06uf:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603774,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603775,NULL,129);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zetv-e06uf:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000038\"}}',1790769603753,NULL,127);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeu0-9l2dc:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603864,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603865,NULL,132);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeu0-9l2dc:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000039\"}}',1790769603843,NULL,130);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeu5-mqmm9:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769603955,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769603956,NULL,135);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeu5-mqmm9:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000003a\"}}',1790769603934,NULL,133);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeua-1kq38:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604047,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604048,NULL,138);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeua-1kq38:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000003b\"}}',1790769604026,NULL,136);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuf-y3d64:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604140,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604141,NULL,141);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuf-y3d64:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000003c\"}}',1790769604119,NULL,139);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuk-czk0d:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604234,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604235,NULL,144);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuk-czk0d:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000003d\"}}',1790769604213,NULL,142);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeup-5j3x8:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604329,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604330,NULL,147);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeup-5j3x8:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000003e\"}}',1790769604308,NULL,145);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuu-ltox5:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604425,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604426,NULL,150);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuu-ltox5:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-00000000003f\"}}',1790769604404,NULL,148);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuz-oabfq:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604525,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604526,NULL,153);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeuz-oabfq:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000040\"}}',1790769604504,NULL,151);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zev4-meot5:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604572,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604573,NULL,156);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zev4-meot5:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000041\"}}',1790769604551,NULL,154);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zev9-6h1mj:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604620,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604621,NULL,159);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zev9-6h1mj:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000042\"}}',1790769604599,NULL,157);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeve-tnifs:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604669,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604670,NULL,162);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zeve-tnifs:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000043\"}}',1790769604648,NULL,160);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevj-ie9cz:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604719,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604720,NULL,165);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevj-ie9cz:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000044\"}}',1790769604698,NULL,163);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevo-5yv68:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604770,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604771,NULL,168);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevo-5yv68:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000045\"}}',1790769604749,NULL,166);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevt-h6r95:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604822,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604823,NULL,171);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevt-h6r95:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000046\"}}',1790769604801,NULL,169);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevy-zu9le:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604875,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604876,NULL,174);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zevy-zu9le:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000047\"}}',1790769604854,NULL,172);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zew3-8pz16:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604929,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604930,NULL,177);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zew3-8pz16:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000048\"}}',1790769604908,NULL,175);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zew8-502o7:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769604984,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769604985,NULL,180);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:qjob-muo1zew8-502o7:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000049\"}}',1790769604963,NULL,178);
INSERT INTO `gnl_run_journal` VALUES (_binary 'job:~o~globex::00000000-0000-4000-8000-000000000001:lease:lock',NULL,NULL,0,_binary '{\"json\":{\"owner\":\"w-skl1hx\",\"expires\":0,\"token\":\"00000000-0000-4000-8000-000000000010\"}}',1790769600967,NULL,7);
INSERT INTO `gnl_run_journal` VALUES (_binary 'org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001:input',NULL,NULL,0,_binary '{\"json\":{\"at\":1790769600988,\"ownerKind\":\"unknown\",\"_v\":2}}',1790769600989,NULL,9);
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
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeo2-cx4dc',0,0,0,NULL,_binary 'completed',1790769600895,1790769600895,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeo7-3t90t',0,0,0,NULL,_binary 'completed',1790769600942,1790769600942,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeog-ob6co',0,0,0,NULL,_binary 'completed',1790769601046,1790769601046,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeol-x1n5k',0,0,0,NULL,_binary 'completed',1790769601097,1790769601097,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeoq-3nn6l',0,0,0,NULL,_binary 'completed',1790769601149,1790769601149,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeov-au3lb',0,0,0,NULL,_binary 'completed',1790769601202,1790769601202,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zep0-0wdy7',0,0,0,NULL,_binary 'completed',1790769601256,1790769601256,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zep5-gsfn4',0,0,0,NULL,_binary 'completed',1790769601311,1790769601311,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zepa-flbxl',0,0,0,NULL,_binary 'completed',1790769601367,1790769601367,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zepf-jpjoy',0,0,0,NULL,_binary 'completed',1790769601424,1790769601424,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zepk-iclf6',0,0,0,NULL,_binary 'completed',1790769601482,1790769601482,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zepp-b20ak',0,0,0,NULL,_binary 'completed',1790769601541,1790769601541,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zepu-wcazd',0,0,0,NULL,_binary 'completed',1790769601601,1790769601601,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zepz-c7yw5',0,0,0,NULL,_binary 'completed',1790769601662,1790769601662,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeq4-3omq7',0,0,0,NULL,_binary 'completed',1790769601724,1790769601724,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeq9-8xhqz',0,0,0,NULL,_binary 'completed',1790769601787,1790769601787,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeqe-9f7ve',0,0,0,NULL,_binary 'completed',1790769601851,1790769601851,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeqj-uletq',0,0,0,NULL,_binary 'completed',1790769601916,1790769601916,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeqo-6wpjm',0,0,0,NULL,_binary 'completed',1790769601982,1790769601982,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeqt-nuxoy',0,0,0,NULL,_binary 'completed',1790769602049,1790769602049,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeqy-ygau7',0,0,0,NULL,_binary 'completed',1790769602117,1790769602117,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zer3-rbgjk',0,0,0,NULL,_binary 'completed',1790769602186,1790769602186,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zer8-t976a',0,0,0,NULL,_binary 'completed',1790769602256,1790769602256,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zerd-wcwtf',0,0,0,NULL,_binary 'completed',1790769602327,1790769602327,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeri-w0wln',0,0,0,NULL,_binary 'completed',1790769602399,1790769602399,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zern-j2ir4',0,0,0,NULL,_binary 'completed',1790769602472,1790769602472,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zers-931ny',0,0,0,NULL,_binary 'completed',1790769602546,1790769602546,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zerx-bkvz7',0,0,0,NULL,_binary 'completed',1790769602621,1790769602621,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zes2-zbyxf',0,0,0,NULL,_binary 'completed',1790769602697,1790769602697,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zes7-nihlz',0,0,0,NULL,_binary 'completed',1790769602774,1790769602774,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zesc-ul3xm',0,0,0,NULL,_binary 'completed',1790769602852,1790769602852,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zesh-qx9rk',0,0,0,NULL,_binary 'completed',1790769602931,1790769602931,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zesm-hpp5f',0,0,0,NULL,_binary 'completed',1790769603011,1790769603011,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zesr-5g6g2',0,0,0,NULL,_binary 'completed',1790769603092,1790769603092,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zesw-qt4k0',0,0,0,NULL,_binary 'completed',1790769603174,1790769603174,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zet1-1rd4y',0,0,0,NULL,_binary 'completed',1790769603257,1790769603257,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zet6-crf1f',0,0,0,NULL,_binary 'completed',1790769603341,1790769603341,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zetb-tk6x3',0,0,0,NULL,_binary 'completed',1790769603426,1790769603426,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zetg-zaisz',0,0,0,NULL,_binary 'completed',1790769603512,1790769603512,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zetl-tiogq',0,0,0,NULL,_binary 'completed',1790769603599,1790769603599,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zetq-2lavf',0,0,0,NULL,_binary 'completed',1790769603687,1790769603687,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zetv-e06uf',0,0,0,NULL,_binary 'completed',1790769603776,1790769603776,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeu0-9l2dc',0,0,0,NULL,_binary 'completed',1790769603866,1790769603866,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeu5-mqmm9',0,0,0,NULL,_binary 'completed',1790769603957,1790769603957,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeua-1kq38',0,0,0,NULL,_binary 'completed',1790769604049,1790769604049,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeuf-y3d64',0,0,0,NULL,_binary 'completed',1790769604142,1790769604142,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeuk-czk0d',0,0,0,NULL,_binary 'completed',1790769604236,1790769604236,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeup-5j3x8',0,0,0,NULL,_binary 'completed',1790769604331,1790769604331,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeuu-ltox5',0,0,0,NULL,_binary 'completed',1790769604427,1790769604427,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeuz-oabfq',0,0,0,NULL,_binary 'completed',1790769604527,1790769604527,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zev4-meot5',0,0,0,NULL,_binary 'completed',1790769604574,1790769604574,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zev9-6h1mj',0,0,0,NULL,_binary 'completed',1790769604622,1790769604622,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zeve-tnifs',0,0,0,NULL,_binary 'completed',1790769604671,1790769604671,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zevj-ie9cz',0,0,0,NULL,_binary 'completed',1790769604721,1790769604721,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zevo-5yv68',0,0,0,NULL,_binary 'completed',1790769604772,1790769604772,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zevt-h6r95',0,0,0,NULL,_binary 'completed',1790769604824,1790769604824,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zevy-zu9le',0,0,0,NULL,_binary 'completed',1790769604877,1790769604877,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zew3-8pz16',0,0,0,NULL,_binary 'completed',1790769604931,1790769604931,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'job:qjob-muo1zew8-502o7',0,0,0,NULL,_binary 'completed',1790769604986,1790769604986,NULL,_binary '');
INSERT INTO `gnl_runs` VALUES (_binary 'org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001',0,0,0,NULL,_binary 'completed',1790769600990,1790769600990,NULL,_binary '');
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
INSERT INTO `gnl_work_kv` VALUES (_binary 'qcursor',_binary '{\"json\":\"w1:50:1790769600247:qjob-muo1zeuu-ltox5\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"at\":1790769600901,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"at\":1790769600948,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeog-ob6co',_binary '{\"json\":{\"at\":1790769601052,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeol-x1n5k',_binary '{\"json\":{\"at\":1790769601103,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeoq-3nn6l',_binary '{\"json\":{\"at\":1790769601155,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeov-au3lb',_binary '{\"json\":{\"at\":1790769601208,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zep0-0wdy7',_binary '{\"json\":{\"at\":1790769601262,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zep5-gsfn4',_binary '{\"json\":{\"at\":1790769601317,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zepa-flbxl',_binary '{\"json\":{\"at\":1790769601373,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zepf-jpjoy',_binary '{\"json\":{\"at\":1790769601430,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zepk-iclf6',_binary '{\"json\":{\"at\":1790769601488,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zepp-b20ak',_binary '{\"json\":{\"at\":1790769601547,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zepu-wcazd',_binary '{\"json\":{\"at\":1790769601607,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zepz-c7yw5',_binary '{\"json\":{\"at\":1790769601668,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeq4-3omq7',_binary '{\"json\":{\"at\":1790769601730,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeq9-8xhqz',_binary '{\"json\":{\"at\":1790769601793,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeqe-9f7ve',_binary '{\"json\":{\"at\":1790769601857,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeqj-uletq',_binary '{\"json\":{\"at\":1790769601922,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeqo-6wpjm',_binary '{\"json\":{\"at\":1790769601988,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeqt-nuxoy',_binary '{\"json\":{\"at\":1790769602055,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeqy-ygau7',_binary '{\"json\":{\"at\":1790769602123,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zer3-rbgjk',_binary '{\"json\":{\"at\":1790769602192,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zer8-t976a',_binary '{\"json\":{\"at\":1790769602262,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zerd-wcwtf',_binary '{\"json\":{\"at\":1790769602333,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeri-w0wln',_binary '{\"json\":{\"at\":1790769602405,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zern-j2ir4',_binary '{\"json\":{\"at\":1790769602478,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zers-931ny',_binary '{\"json\":{\"at\":1790769602552,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zerx-bkvz7',_binary '{\"json\":{\"at\":1790769602627,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zes2-zbyxf',_binary '{\"json\":{\"at\":1790769602703,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zes7-nihlz',_binary '{\"json\":{\"at\":1790769602780,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zesc-ul3xm',_binary '{\"json\":{\"at\":1790769602858,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zesh-qx9rk',_binary '{\"json\":{\"at\":1790769602937,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zesm-hpp5f',_binary '{\"json\":{\"at\":1790769603017,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zesr-5g6g2',_binary '{\"json\":{\"at\":1790769603098,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zesw-qt4k0',_binary '{\"json\":{\"at\":1790769603180,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zet1-1rd4y',_binary '{\"json\":{\"at\":1790769603263,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zet6-crf1f',_binary '{\"json\":{\"at\":1790769603347,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zetb-tk6x3',_binary '{\"json\":{\"at\":1790769603432,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zetg-zaisz',_binary '{\"json\":{\"at\":1790769603518,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zetl-tiogq',_binary '{\"json\":{\"at\":1790769603605,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zetq-2lavf',_binary '{\"json\":{\"at\":1790769603693,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zetv-e06uf',_binary '{\"json\":{\"at\":1790769603782,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeu0-9l2dc',_binary '{\"json\":{\"at\":1790769603872,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeu5-mqmm9',_binary '{\"json\":{\"at\":1790769603963,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeua-1kq38',_binary '{\"json\":{\"at\":1790769604055,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeuf-y3d64',_binary '{\"json\":{\"at\":1790769604148,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeuk-czk0d',_binary '{\"json\":{\"at\":1790769604242,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeup-5j3x8',_binary '{\"json\":{\"at\":1790769604337,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeuu-ltox5',_binary '{\"json\":{\"at\":1790769604433,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeuz-oabfq',_binary '{\"json\":{\"at\":1790769604533,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zev4-meot5',_binary '{\"json\":{\"at\":1790769604580,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zev9-6h1mj',_binary '{\"json\":{\"at\":1790769604628,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zeve-tnifs',_binary '{\"json\":{\"at\":1790769604677,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zevj-ie9cz',_binary '{\"json\":{\"at\":1790769604727,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zevo-5yv68',_binary '{\"json\":{\"at\":1790769604778,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zevt-h6r95',_binary '{\"json\":{\"at\":1790769604830,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zevy-zu9le',_binary '{\"json\":{\"at\":1790769604883,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zew3-8pz16',_binary '{\"json\":{\"at\":1790769604937,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qdone:qjob-muo1zew8-502o7',_binary '{\"json\":{\"at\":1790769604992,\"ok\":true}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qfail:~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":{\"error\":\"boom\",\"attempts\":1}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeo2-cx4dc',_binary '{\"json\":\"00000000-0000-4000-8000-00000000000e\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeo7-3t90t',_binary '{\"json\":\"00000000-0000-4000-8000-00000000000f\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeog-ob6co',_binary '{\"json\":\"00000000-0000-4000-8000-000000000011\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeol-x1n5k',_binary '{\"json\":\"00000000-0000-4000-8000-000000000012\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeoq-3nn6l',_binary '{\"json\":\"00000000-0000-4000-8000-000000000013\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeov-au3lb',_binary '{\"json\":\"00000000-0000-4000-8000-000000000014\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zep0-0wdy7',_binary '{\"json\":\"00000000-0000-4000-8000-000000000015\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zep5-gsfn4',_binary '{\"json\":\"00000000-0000-4000-8000-000000000016\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zepa-flbxl',_binary '{\"json\":\"00000000-0000-4000-8000-000000000017\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zepf-jpjoy',_binary '{\"json\":\"00000000-0000-4000-8000-000000000018\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zepk-iclf6',_binary '{\"json\":\"00000000-0000-4000-8000-000000000019\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zepp-b20ak',_binary '{\"json\":\"00000000-0000-4000-8000-00000000001a\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zepu-wcazd',_binary '{\"json\":\"00000000-0000-4000-8000-00000000001b\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zepz-c7yw5',_binary '{\"json\":\"00000000-0000-4000-8000-00000000001c\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeq4-3omq7',_binary '{\"json\":\"00000000-0000-4000-8000-00000000001d\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeq9-8xhqz',_binary '{\"json\":\"00000000-0000-4000-8000-00000000001e\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeqe-9f7ve',_binary '{\"json\":\"00000000-0000-4000-8000-00000000001f\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeqj-uletq',_binary '{\"json\":\"00000000-0000-4000-8000-000000000020\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeqo-6wpjm',_binary '{\"json\":\"00000000-0000-4000-8000-000000000021\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeqt-nuxoy',_binary '{\"json\":\"00000000-0000-4000-8000-000000000022\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeqy-ygau7',_binary '{\"json\":\"00000000-0000-4000-8000-000000000023\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zer3-rbgjk',_binary '{\"json\":\"00000000-0000-4000-8000-000000000024\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zer8-t976a',_binary '{\"json\":\"00000000-0000-4000-8000-000000000025\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zerd-wcwtf',_binary '{\"json\":\"00000000-0000-4000-8000-000000000026\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeri-w0wln',_binary '{\"json\":\"00000000-0000-4000-8000-000000000027\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zern-j2ir4',_binary '{\"json\":\"00000000-0000-4000-8000-000000000028\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zers-931ny',_binary '{\"json\":\"00000000-0000-4000-8000-000000000029\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zerx-bkvz7',_binary '{\"json\":\"00000000-0000-4000-8000-00000000002a\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zes2-zbyxf',_binary '{\"json\":\"00000000-0000-4000-8000-00000000002b\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zes7-nihlz',_binary '{\"json\":\"00000000-0000-4000-8000-00000000002c\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zesc-ul3xm',_binary '{\"json\":\"00000000-0000-4000-8000-00000000002d\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zesh-qx9rk',_binary '{\"json\":\"00000000-0000-4000-8000-00000000002e\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zesm-hpp5f',_binary '{\"json\":\"00000000-0000-4000-8000-00000000002f\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zesr-5g6g2',_binary '{\"json\":\"00000000-0000-4000-8000-000000000030\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zesw-qt4k0',_binary '{\"json\":\"00000000-0000-4000-8000-000000000031\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zet1-1rd4y',_binary '{\"json\":\"00000000-0000-4000-8000-000000000032\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zet6-crf1f',_binary '{\"json\":\"00000000-0000-4000-8000-000000000033\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zetb-tk6x3',_binary '{\"json\":\"00000000-0000-4000-8000-000000000034\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zetg-zaisz',_binary '{\"json\":\"00000000-0000-4000-8000-000000000035\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zetl-tiogq',_binary '{\"json\":\"00000000-0000-4000-8000-000000000036\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zetq-2lavf',_binary '{\"json\":\"00000000-0000-4000-8000-000000000037\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zetv-e06uf',_binary '{\"json\":\"00000000-0000-4000-8000-000000000038\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeu0-9l2dc',_binary '{\"json\":\"00000000-0000-4000-8000-000000000039\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeu5-mqmm9',_binary '{\"json\":\"00000000-0000-4000-8000-00000000003a\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeua-1kq38',_binary '{\"json\":\"00000000-0000-4000-8000-00000000003b\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeuf-y3d64',_binary '{\"json\":\"00000000-0000-4000-8000-00000000003c\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeuk-czk0d',_binary '{\"json\":\"00000000-0000-4000-8000-00000000003d\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeup-5j3x8',_binary '{\"json\":\"00000000-0000-4000-8000-00000000003e\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeuu-ltox5',_binary '{\"json\":\"00000000-0000-4000-8000-00000000003f\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeuz-oabfq',_binary '{\"json\":\"00000000-0000-4000-8000-000000000040\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zev4-meot5',_binary '{\"json\":\"00000000-0000-4000-8000-000000000041\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zev9-6h1mj',_binary '{\"json\":\"00000000-0000-4000-8000-000000000042\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zeve-tnifs',_binary '{\"json\":\"00000000-0000-4000-8000-000000000043\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zevj-ie9cz',_binary '{\"json\":\"00000000-0000-4000-8000-000000000044\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zevo-5yv68',_binary '{\"json\":\"00000000-0000-4000-8000-000000000045\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zevt-h6r95',_binary '{\"json\":\"00000000-0000-4000-8000-000000000046\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zevy-zu9le',_binary '{\"json\":\"00000000-0000-4000-8000-000000000047\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zew3-8pz16',_binary '{\"json\":\"00000000-0000-4000-8000-000000000048\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:qjob-muo1zew8-502o7',_binary '{\"json\":\"00000000-0000-4000-8000-000000000049\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qown:~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":\"00000000-0000-4000-8000-000000000010\"}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeog-ob6co',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeol-x1n5k',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeoq-3nn6l',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeov-au3lb',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zep0-0wdy7',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zep5-gsfn4',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zepa-flbxl',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zepf-jpjoy',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zepk-iclf6',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zepp-b20ak',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zepu-wcazd',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zepz-c7yw5',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeq4-3omq7',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeq9-8xhqz',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeqe-9f7ve',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeqj-uletq',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeqo-6wpjm',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeqt-nuxoy',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeqy-ygau7',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zer3-rbgjk',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zer8-t976a',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zerd-wcwtf',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeri-w0wln',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zern-j2ir4',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zers-931ny',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zerx-bkvz7',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zes2-zbyxf',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zes7-nihlz',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zesc-ul3xm',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zesh-qx9rk',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zesm-hpp5f',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zesr-5g6g2',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zesw-qt4k0',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zet1-1rd4y',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zet6-crf1f',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zetb-tk6x3',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zetg-zaisz',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zetl-tiogq',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zetq-2lavf',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zetv-e06uf',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeu0-9l2dc',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeu5-mqmm9',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeua-1kq38',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeuf-y3d64',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeuk-czk0d',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeup-5j3x8',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeuu-ltox5',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeuz-oabfq',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zev4-meot5',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zev9-6h1mj',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zeve-tnifs',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zevj-ie9cz',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zevo-5yv68',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zevt-h6r95',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zevy-zu9le',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zew3-8pz16',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
INSERT INTO `gnl_work_kv` VALUES (_binary 'qtry:qjob-muo1zew8-502o7',_binary '{\"json\":{\"attempts\":1,\"notBefore\":0}}');
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
) ENGINE=InnoDB AUTO_INCREMENT=347 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000002',_binary '{\"json\":{\"type\":\"t\"}}',1790769600808,0,324);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000003',_binary '{\"json\":{\"type\":\"t\"}}',1790769600812,0,326);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000004',_binary '{\"json\":{\"type\":\"t\"}}',1790769600816,0,328);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000005',_binary '{\"json\":{\"type\":\"t\"}}',1790769600820,0,330);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::00000000-0000-4000-8000-000000000006',_binary '{\"json\":{\"type\":\"t\"}}',1790769600824,0,332);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme::weekly-report',_binary '{\"json\":{\"type\":\"t\"}}',1790769600853,0,346);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:acme:qdepth',_binary '~o~acme:ayse:00000000-0000-4000-8000-00000000000c',_binary '{\"json\":{\"type\":\"t\"}}',1790769600848,0,344);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":{\"type\":\"t\"}}',1790769600014,0,6);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000007',_binary '{\"json\":{\"type\":\"t\"}}',1790769600828,0,334);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000008',_binary '{\"json\":{\"type\":\"t\"}}',1790769600832,0,336);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-000000000009',_binary '{\"json\":{\"type\":\"t\"}}',1790769600836,0,338);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-00000000000a',_binary '{\"json\":{\"type\":\"t\"}}',1790769600840,0,340);
INSERT INTO `gnl_work_log` VALUES (_binary 'org:globex:qdepth',_binary '~o~globex::00000000-0000-4000-8000-00000000000b',_binary '{\"json\":{\"type\":\"t\"}}',1790769600844,0,342);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"type\":\"t\"}}',1790769600005,0,2);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"type\":\"t\"}}',1790769600010,0,4);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeog-ob6co',_binary '{\"json\":{\"type\":\"t\"}}',1790769600019,0,8);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeol-x1n5k',_binary '{\"json\":{\"type\":\"t\"}}',1790769600024,0,10);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeoq-3nn6l',_binary '{\"json\":{\"type\":\"t\"}}',1790769600029,0,12);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeov-au3lb',_binary '{\"json\":{\"type\":\"t\"}}',1790769600034,0,14);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zep0-0wdy7',_binary '{\"json\":{\"type\":\"t\"}}',1790769600039,0,16);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zep5-gsfn4',_binary '{\"json\":{\"type\":\"t\"}}',1790769600044,0,18);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zepa-flbxl',_binary '{\"json\":{\"type\":\"t\"}}',1790769600049,0,20);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zepf-jpjoy',_binary '{\"json\":{\"type\":\"t\"}}',1790769600054,0,22);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zepk-iclf6',_binary '{\"json\":{\"type\":\"t\"}}',1790769600059,0,24);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zepp-b20ak',_binary '{\"json\":{\"type\":\"t\"}}',1790769600064,0,26);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zepu-wcazd',_binary '{\"json\":{\"type\":\"t\"}}',1790769600069,0,28);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zepz-c7yw5',_binary '{\"json\":{\"type\":\"t\"}}',1790769600074,0,30);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeq4-3omq7',_binary '{\"json\":{\"type\":\"t\"}}',1790769600079,0,32);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeq9-8xhqz',_binary '{\"json\":{\"type\":\"t\"}}',1790769600084,0,34);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeqe-9f7ve',_binary '{\"json\":{\"type\":\"t\"}}',1790769600089,0,36);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeqj-uletq',_binary '{\"json\":{\"type\":\"t\"}}',1790769600094,0,38);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeqo-6wpjm',_binary '{\"json\":{\"type\":\"t\"}}',1790769600099,0,40);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeqt-nuxoy',_binary '{\"json\":{\"type\":\"t\"}}',1790769600104,0,42);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeqy-ygau7',_binary '{\"json\":{\"type\":\"t\"}}',1790769600109,0,44);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zer3-rbgjk',_binary '{\"json\":{\"type\":\"t\"}}',1790769600114,0,46);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zer8-t976a',_binary '{\"json\":{\"type\":\"t\"}}',1790769600119,0,48);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zerd-wcwtf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600124,0,50);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeri-w0wln',_binary '{\"json\":{\"type\":\"t\"}}',1790769600129,0,52);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zern-j2ir4',_binary '{\"json\":{\"type\":\"t\"}}',1790769600134,0,54);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zers-931ny',_binary '{\"json\":{\"type\":\"t\"}}',1790769600139,0,56);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zerx-bkvz7',_binary '{\"json\":{\"type\":\"t\"}}',1790769600144,0,58);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zes2-zbyxf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600149,0,60);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zes7-nihlz',_binary '{\"json\":{\"type\":\"t\"}}',1790769600154,0,62);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zesc-ul3xm',_binary '{\"json\":{\"type\":\"t\"}}',1790769600159,0,64);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zesh-qx9rk',_binary '{\"json\":{\"type\":\"t\"}}',1790769600164,0,66);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zesm-hpp5f',_binary '{\"json\":{\"type\":\"t\"}}',1790769600169,0,68);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zesr-5g6g2',_binary '{\"json\":{\"type\":\"t\"}}',1790769600174,0,70);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zesw-qt4k0',_binary '{\"json\":{\"type\":\"t\"}}',1790769600179,0,72);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zet1-1rd4y',_binary '{\"json\":{\"type\":\"t\"}}',1790769600184,0,74);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zet6-crf1f',_binary '{\"json\":{\"type\":\"t\"}}',1790769600189,0,76);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zetb-tk6x3',_binary '{\"json\":{\"type\":\"t\"}}',1790769600194,0,78);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zetg-zaisz',_binary '{\"json\":{\"type\":\"t\"}}',1790769600199,0,80);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zetl-tiogq',_binary '{\"json\":{\"type\":\"t\"}}',1790769600204,0,82);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zetq-2lavf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600209,0,84);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zetv-e06uf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600214,0,86);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeu0-9l2dc',_binary '{\"json\":{\"type\":\"t\"}}',1790769600219,0,88);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeu5-mqmm9',_binary '{\"json\":{\"type\":\"t\"}}',1790769600224,0,90);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeua-1kq38',_binary '{\"json\":{\"type\":\"t\"}}',1790769600229,0,92);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeuf-y3d64',_binary '{\"json\":{\"type\":\"t\"}}',1790769600234,0,94);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeuk-czk0d',_binary '{\"json\":{\"type\":\"t\"}}',1790769600239,0,96);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeup-5j3x8',_binary '{\"json\":{\"type\":\"t\"}}',1790769600244,0,98);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeuu-ltox5',_binary '{\"json\":{\"type\":\"t\"}}',1790769600249,0,100);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeuz-oabfq',_binary '{\"json\":{\"type\":\"t\"}}',1790769600254,0,102);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zev4-meot5',_binary '{\"json\":{\"type\":\"t\"}}',1790769600259,0,104);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zev9-6h1mj',_binary '{\"json\":{\"type\":\"t\"}}',1790769600264,0,106);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeve-tnifs',_binary '{\"json\":{\"type\":\"t\"}}',1790769600269,0,108);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zevj-ie9cz',_binary '{\"json\":{\"type\":\"t\"}}',1790769600274,0,110);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zevo-5yv68',_binary '{\"json\":{\"type\":\"t\"}}',1790769600279,0,112);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zevt-h6r95',_binary '{\"json\":{\"type\":\"t\"}}',1790769600284,0,114);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zevy-zu9le',_binary '{\"json\":{\"type\":\"t\"}}',1790769600289,0,116);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zew3-8pz16',_binary '{\"json\":{\"type\":\"t\"}}',1790769600294,0,118);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zew8-502o7',_binary '{\"json\":{\"type\":\"t\"}}',1790769600299,0,120);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zewd-z9gu9',_binary '{\"json\":{\"type\":\"t\"}}',1790769600304,0,122);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zewi-u849l',_binary '{\"json\":{\"type\":\"t\"}}',1790769600309,0,124);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zewn-z3i0p',_binary '{\"json\":{\"type\":\"t\"}}',1790769600314,0,126);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zews-7964a',_binary '{\"json\":{\"type\":\"t\"}}',1790769600319,0,128);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zewx-gdfae',_binary '{\"json\":{\"type\":\"t\"}}',1790769600324,0,130);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zex2-4k9cd',_binary '{\"json\":{\"type\":\"t\"}}',1790769600329,0,132);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zex7-l4v91',_binary '{\"json\":{\"type\":\"t\"}}',1790769600334,0,134);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zexc-xbca4',_binary '{\"json\":{\"type\":\"t\"}}',1790769600339,0,136);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zexh-5q1hz',_binary '{\"json\":{\"type\":\"t\"}}',1790769600344,0,138);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zexm-7lu98',_binary '{\"json\":{\"type\":\"t\"}}',1790769600349,0,140);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zexr-7j7x8',_binary '{\"json\":{\"type\":\"t\"}}',1790769600354,0,142);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zexw-xad50',_binary '{\"json\":{\"type\":\"t\"}}',1790769600359,0,144);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zey1-hovml',_binary '{\"json\":{\"type\":\"t\"}}',1790769600364,0,146);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zey6-tzyii',_binary '{\"json\":{\"type\":\"t\"}}',1790769600369,0,148);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeyb-2oh2v',_binary '{\"json\":{\"type\":\"t\"}}',1790769600374,0,150);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeyg-62gjy',_binary '{\"json\":{\"type\":\"t\"}}',1790769600379,0,152);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeyl-7szyf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600384,0,154);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeyq-eqm1i',_binary '{\"json\":{\"type\":\"t\"}}',1790769600389,0,156);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeyv-3z88t',_binary '{\"json\":{\"type\":\"t\"}}',1790769600394,0,158);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zez0-c4kpt',_binary '{\"json\":{\"type\":\"t\"}}',1790769600399,0,160);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zez5-egeoi',_binary '{\"json\":{\"type\":\"t\"}}',1790769600404,0,162);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zeza-hczgf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600409,0,164);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zezf-cp4gh',_binary '{\"json\":{\"type\":\"t\"}}',1790769600414,0,166);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zezk-m4818',_binary '{\"json\":{\"type\":\"t\"}}',1790769600419,0,168);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zezp-02z77',_binary '{\"json\":{\"type\":\"t\"}}',1790769600424,0,170);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zezu-3hu3p',_binary '{\"json\":{\"type\":\"t\"}}',1790769600429,0,172);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zezz-nbvfy',_binary '{\"json\":{\"type\":\"t\"}}',1790769600434,0,174);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf04-rwkmz',_binary '{\"json\":{\"type\":\"t\"}}',1790769600439,0,176);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf09-vrikf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600444,0,178);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf0e-ha7kq',_binary '{\"json\":{\"type\":\"t\"}}',1790769600449,0,180);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf0j-9185n',_binary '{\"json\":{\"type\":\"t\"}}',1790769600454,0,182);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf0o-d93fp',_binary '{\"json\":{\"type\":\"t\"}}',1790769600459,0,184);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf0t-o8bdq',_binary '{\"json\":{\"type\":\"t\"}}',1790769600464,0,186);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf0y-lh0wf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600469,0,188);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf13-wrps3',_binary '{\"json\":{\"type\":\"t\"}}',1790769600474,0,190);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf18-pjbmo',_binary '{\"json\":{\"type\":\"t\"}}',1790769600479,0,192);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf1d-shoku',_binary '{\"json\":{\"type\":\"t\"}}',1790769600484,0,194);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf1i-82zem',_binary '{\"json\":{\"type\":\"t\"}}',1790769600489,0,196);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf1n-ecjci',_binary '{\"json\":{\"type\":\"t\"}}',1790769600494,0,198);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf1s-8jft4',_binary '{\"json\":{\"type\":\"t\"}}',1790769600499,0,200);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf1x-tntlr',_binary '{\"json\":{\"type\":\"t\"}}',1790769600504,0,202);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf22-sb0m2',_binary '{\"json\":{\"type\":\"t\"}}',1790769600509,0,204);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf27-c3k50',_binary '{\"json\":{\"type\":\"t\"}}',1790769600514,0,206);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf2c-a94st',_binary '{\"json\":{\"type\":\"t\"}}',1790769600519,0,208);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf2h-qbuah',_binary '{\"json\":{\"type\":\"t\"}}',1790769600524,0,210);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf2m-jd468',_binary '{\"json\":{\"type\":\"t\"}}',1790769600529,0,212);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf2r-tvrdd',_binary '{\"json\":{\"type\":\"t\"}}',1790769600534,0,214);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf2w-hubyr',_binary '{\"json\":{\"type\":\"t\"}}',1790769600539,0,216);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf31-h80jo',_binary '{\"json\":{\"type\":\"t\"}}',1790769600544,0,218);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf36-3mwz4',_binary '{\"json\":{\"type\":\"t\"}}',1790769600549,0,220);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf3b-kvb0q',_binary '{\"json\":{\"type\":\"t\"}}',1790769600554,0,222);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf3g-284ud',_binary '{\"json\":{\"type\":\"t\"}}',1790769600559,0,224);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf3l-dhpg9',_binary '{\"json\":{\"type\":\"t\"}}',1790769600564,0,226);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf3q-0kai7',_binary '{\"json\":{\"type\":\"t\"}}',1790769600569,0,228);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf3v-190v2',_binary '{\"json\":{\"type\":\"t\"}}',1790769600574,0,230);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf40-h9qwu',_binary '{\"json\":{\"type\":\"t\"}}',1790769600579,0,232);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf45-wzcd9',_binary '{\"json\":{\"type\":\"t\"}}',1790769600584,0,234);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf4a-ir86q',_binary '{\"json\":{\"type\":\"t\"}}',1790769600589,0,236);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf4f-wsov7',_binary '{\"json\":{\"type\":\"t\"}}',1790769600594,0,238);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf4k-6kazh',_binary '{\"json\":{\"type\":\"t\"}}',1790769600599,0,240);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf4p-kdigl',_binary '{\"json\":{\"type\":\"t\"}}',1790769600604,0,242);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf4u-p26d0',_binary '{\"json\":{\"type\":\"t\"}}',1790769600609,0,244);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf4z-9wkgk',_binary '{\"json\":{\"type\":\"t\"}}',1790769600614,0,246);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf54-lk5zg',_binary '{\"json\":{\"type\":\"t\"}}',1790769600619,0,248);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf59-4i8g0',_binary '{\"json\":{\"type\":\"t\"}}',1790769600624,0,250);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf5e-msary',_binary '{\"json\":{\"type\":\"t\"}}',1790769600629,0,252);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf5j-andz9',_binary '{\"json\":{\"type\":\"t\"}}',1790769600634,0,254);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf5o-3wn24',_binary '{\"json\":{\"type\":\"t\"}}',1790769600639,0,256);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf5t-f1krl',_binary '{\"json\":{\"type\":\"t\"}}',1790769600644,0,258);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf5y-g2l6p',_binary '{\"json\":{\"type\":\"t\"}}',1790769600649,0,260);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf63-pljq3',_binary '{\"json\":{\"type\":\"t\"}}',1790769600654,0,262);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf68-2h79c',_binary '{\"json\":{\"type\":\"t\"}}',1790769600659,0,264);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf6d-e0o86',_binary '{\"json\":{\"type\":\"t\"}}',1790769600664,0,266);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf6i-rtejy',_binary '{\"json\":{\"type\":\"t\"}}',1790769600669,0,268);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf6n-04rs8',_binary '{\"json\":{\"type\":\"t\"}}',1790769600674,0,270);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf6s-m6slb',_binary '{\"json\":{\"type\":\"t\"}}',1790769600679,0,272);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf6x-xtqpl',_binary '{\"json\":{\"type\":\"t\"}}',1790769600684,0,274);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf72-4e0lp',_binary '{\"json\":{\"type\":\"t\"}}',1790769600689,0,276);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf77-s60js',_binary '{\"json\":{\"type\":\"t\"}}',1790769600694,0,278);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf7c-81psj',_binary '{\"json\":{\"type\":\"t\"}}',1790769600699,0,280);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf7h-s9zgk',_binary '{\"json\":{\"type\":\"t\"}}',1790769600704,0,282);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf7m-tb7nw',_binary '{\"json\":{\"type\":\"t\"}}',1790769600709,0,284);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf7r-531l2',_binary '{\"json\":{\"type\":\"t\"}}',1790769600714,0,286);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf7w-zhlp6',_binary '{\"json\":{\"type\":\"t\"}}',1790769600719,0,288);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf81-akkmi',_binary '{\"json\":{\"type\":\"t\"}}',1790769600724,0,290);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf86-em50x',_binary '{\"json\":{\"type\":\"t\"}}',1790769600729,0,292);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf8b-qps68',_binary '{\"json\":{\"type\":\"t\"}}',1790769600734,0,294);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf8g-6g0as',_binary '{\"json\":{\"type\":\"t\"}}',1790769600739,0,296);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf8l-xlzsu',_binary '{\"json\":{\"type\":\"t\"}}',1790769600744,0,298);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf8q-lmsa0',_binary '{\"json\":{\"type\":\"t\"}}',1790769600749,0,300);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf8v-7mxxr',_binary '{\"json\":{\"type\":\"t\"}}',1790769600754,0,302);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf90-0fgcj',_binary '{\"json\":{\"type\":\"t\"}}',1790769600759,0,304);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf95-8nrjg',_binary '{\"json\":{\"type\":\"t\"}}',1790769600764,0,306);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf9a-jpykv',_binary '{\"json\":{\"type\":\"t\"}}',1790769600769,0,308);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf9f-dvlvf',_binary '{\"json\":{\"type\":\"t\"}}',1790769600774,0,310);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf9k-fdaai',_binary '{\"json\":{\"type\":\"t\"}}',1790769600779,0,312);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf9p-lrur4',_binary '{\"json\":{\"type\":\"t\"}}',1790769600784,0,314);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf9u-vkufx',_binary '{\"json\":{\"type\":\"t\"}}',1790769600789,0,316);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zf9z-t7zlt',_binary '{\"json\":{\"type\":\"t\"}}',1790769600794,0,318);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zfa4-bpicm',_binary '{\"json\":{\"type\":\"t\"}}',1790769600799,0,320);
INSERT INTO `gnl_work_log` VALUES (_binary 'qdepth',_binary 'qjob-muo1zfa9-cjqmn',_binary '{\"json\":{\"type\":\"t\"}}',1790769600804,0,322);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeo2-cx4dc',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s0\"}}}',1790769600003,1,1);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeo7-3t90t',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s1\"}}}',1790769600008,2,3);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeog-ob6co',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s2\"}}}',1790769600017,4,7);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeol-x1n5k',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s3\"}}}',1790769600022,5,9);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeoq-3nn6l',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s4\"}}}',1790769600027,6,11);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeov-au3lb',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s5\"}}}',1790769600032,7,13);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zep0-0wdy7',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s6\"}}}',1790769600037,8,15);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zep5-gsfn4',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s7\"}}}',1790769600042,9,17);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zepa-flbxl',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s8\"}}}',1790769600047,10,19);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zepf-jpjoy',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s9\"}}}',1790769600052,11,21);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zepk-iclf6',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s10\"}}}',1790769600057,12,23);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zepp-b20ak',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s11\"}}}',1790769600062,13,25);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zepu-wcazd',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s12\"}}}',1790769600067,14,27);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zepz-c7yw5',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s13\"}}}',1790769600072,15,29);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeq4-3omq7',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s14\"}}}',1790769600077,16,31);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeq9-8xhqz',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s15\"}}}',1790769600082,17,33);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeqe-9f7ve',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s16\"}}}',1790769600087,18,35);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeqj-uletq',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s17\"}}}',1790769600092,19,37);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeqo-6wpjm',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s18\"}}}',1790769600097,20,39);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeqt-nuxoy',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s19\"}}}',1790769600102,21,41);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeqy-ygau7',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s20\"}}}',1790769600107,22,43);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zer3-rbgjk',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s21\"}}}',1790769600112,23,45);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zer8-t976a',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s22\"}}}',1790769600117,24,47);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zerd-wcwtf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s23\"}}}',1790769600122,25,49);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeri-w0wln',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s24\"}}}',1790769600127,26,51);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zern-j2ir4',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s25\"}}}',1790769600132,27,53);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zers-931ny',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s26\"}}}',1790769600137,28,55);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zerx-bkvz7',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s27\"}}}',1790769600142,29,57);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zes2-zbyxf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s28\"}}}',1790769600147,30,59);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zes7-nihlz',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s29\"}}}',1790769600152,31,61);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zesc-ul3xm',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s30\"}}}',1790769600157,32,63);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zesh-qx9rk',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s31\"}}}',1790769600162,33,65);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zesm-hpp5f',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s32\"}}}',1790769600167,34,67);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zesr-5g6g2',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s33\"}}}',1790769600172,35,69);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zesw-qt4k0',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s34\"}}}',1790769600177,36,71);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zet1-1rd4y',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s35\"}}}',1790769600182,37,73);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zet6-crf1f',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s36\"}}}',1790769600187,38,75);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zetb-tk6x3',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s37\"}}}',1790769600192,39,77);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zetg-zaisz',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s38\"}}}',1790769600197,40,79);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zetl-tiogq',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s39\"}}}',1790769600202,41,81);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zetq-2lavf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s40\"}}}',1790769600207,42,83);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zetv-e06uf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s41\"}}}',1790769600212,43,85);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeu0-9l2dc',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s42\"}}}',1790769600217,44,87);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeu5-mqmm9',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s43\"}}}',1790769600222,45,89);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeua-1kq38',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s44\"}}}',1790769600227,46,91);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeuf-y3d64',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s45\"}}}',1790769600232,47,93);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeuk-czk0d',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s46\"}}}',1790769600237,48,95);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeup-5j3x8',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s47\"}}}',1790769600242,49,97);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeuu-ltox5',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s48\"}}}',1790769600247,50,99);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeuz-oabfq',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s49\"}}}',1790769600252,51,101);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zev4-meot5',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s50\"}}}',1790769600257,52,103);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zev9-6h1mj',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s51\"}}}',1790769600262,53,105);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeve-tnifs',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s52\"}}}',1790769600267,54,107);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zevj-ie9cz',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s53\"}}}',1790769600272,55,109);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zevo-5yv68',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s54\"}}}',1790769600277,56,111);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zevt-h6r95',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s55\"}}}',1790769600282,57,113);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zevy-zu9le',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s56\"}}}',1790769600287,58,115);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zew3-8pz16',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s57\"}}}',1790769600292,59,117);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zew8-502o7',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s58\"}}}',1790769600297,60,119);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zewd-z9gu9',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s59\"}}}',1790769600302,61,121);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zewi-u849l',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s60\"}}}',1790769600307,62,123);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zewn-z3i0p',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s61\"}}}',1790769600312,63,125);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zews-7964a',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s62\"}}}',1790769600317,64,127);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zewx-gdfae',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s63\"}}}',1790769600322,65,129);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zex2-4k9cd',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s64\"}}}',1790769600327,66,131);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zex7-l4v91',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s65\"}}}',1790769600332,67,133);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zexc-xbca4',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s66\"}}}',1790769600337,68,135);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zexh-5q1hz',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s67\"}}}',1790769600342,69,137);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zexm-7lu98',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s68\"}}}',1790769600347,70,139);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zexr-7j7x8',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s69\"}}}',1790769600352,71,141);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zexw-xad50',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s70\"}}}',1790769600357,72,143);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zey1-hovml',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s71\"}}}',1790769600362,73,145);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zey6-tzyii',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s72\"}}}',1790769600367,74,147);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeyb-2oh2v',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s73\"}}}',1790769600372,75,149);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeyg-62gjy',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s74\"}}}',1790769600377,76,151);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeyl-7szyf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s75\"}}}',1790769600382,77,153);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeyq-eqm1i',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s76\"}}}',1790769600387,78,155);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeyv-3z88t',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s77\"}}}',1790769600392,79,157);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zez0-c4kpt',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s78\"}}}',1790769600397,80,159);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zez5-egeoi',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s79\"}}}',1790769600402,81,161);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zeza-hczgf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s80\"}}}',1790769600407,82,163);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zezf-cp4gh',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s81\"}}}',1790769600412,83,165);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zezk-m4818',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s82\"}}}',1790769600417,84,167);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zezp-02z77',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s83\"}}}',1790769600422,85,169);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zezu-3hu3p',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s84\"}}}',1790769600427,86,171);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zezz-nbvfy',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s85\"}}}',1790769600432,87,173);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf04-rwkmz',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s86\"}}}',1790769600437,88,175);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf09-vrikf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s87\"}}}',1790769600442,89,177);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf0e-ha7kq',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s88\"}}}',1790769600447,90,179);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf0j-9185n',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s89\"}}}',1790769600452,91,181);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf0o-d93fp',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s90\"}}}',1790769600457,92,183);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf0t-o8bdq',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s91\"}}}',1790769600462,93,185);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf0y-lh0wf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s92\"}}}',1790769600467,94,187);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf13-wrps3',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s93\"}}}',1790769600472,95,189);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf18-pjbmo',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s94\"}}}',1790769600477,96,191);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf1d-shoku',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s95\"}}}',1790769600482,97,193);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf1i-82zem',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s96\"}}}',1790769600487,98,195);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf1n-ecjci',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s97\"}}}',1790769600492,99,197);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf1s-8jft4',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s98\"}}}',1790769600497,100,199);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf1x-tntlr',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s99\"}}}',1790769600502,101,201);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf22-sb0m2',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s100\"}}}',1790769600507,102,203);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf27-c3k50',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s101\"}}}',1790769600512,103,205);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf2c-a94st',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s102\"}}}',1790769600517,104,207);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf2h-qbuah',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s103\"}}}',1790769600522,105,209);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf2m-jd468',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s104\"}}}',1790769600527,106,211);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf2r-tvrdd',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s105\"}}}',1790769600532,107,213);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf2w-hubyr',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s106\"}}}',1790769600537,108,215);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf31-h80jo',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s107\"}}}',1790769600542,109,217);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf36-3mwz4',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s108\"}}}',1790769600547,110,219);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf3b-kvb0q',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s109\"}}}',1790769600552,111,221);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf3g-284ud',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s110\"}}}',1790769600557,112,223);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf3l-dhpg9',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s111\"}}}',1790769600562,113,225);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf3q-0kai7',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s112\"}}}',1790769600567,114,227);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf3v-190v2',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s113\"}}}',1790769600572,115,229);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf40-h9qwu',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s114\"}}}',1790769600577,116,231);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf45-wzcd9',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s115\"}}}',1790769600582,117,233);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf4a-ir86q',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s116\"}}}',1790769600587,118,235);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf4f-wsov7',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s117\"}}}',1790769600592,119,237);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf4k-6kazh',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s118\"}}}',1790769600597,120,239);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf4p-kdigl',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s119\"}}}',1790769600602,121,241);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf4u-p26d0',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s120\"}}}',1790769600607,122,243);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf4z-9wkgk',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s121\"}}}',1790769600612,123,245);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf54-lk5zg',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s122\"}}}',1790769600617,124,247);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf59-4i8g0',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s123\"}}}',1790769600622,125,249);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf5e-msary',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s124\"}}}',1790769600627,126,251);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf5j-andz9',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s125\"}}}',1790769600632,127,253);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf5o-3wn24',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s126\"}}}',1790769600637,128,255);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf5t-f1krl',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s127\"}}}',1790769600642,129,257);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf5y-g2l6p',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s128\"}}}',1790769600647,130,259);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf63-pljq3',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s129\"}}}',1790769600652,131,261);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf68-2h79c',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s130\"}}}',1790769600657,132,263);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf6d-e0o86',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s131\"}}}',1790769600662,133,265);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf6i-rtejy',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s132\"}}}',1790769600667,134,267);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf6n-04rs8',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s133\"}}}',1790769600672,135,269);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf6s-m6slb',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s134\"}}}',1790769600677,136,271);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf6x-xtqpl',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s135\"}}}',1790769600682,137,273);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf72-4e0lp',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s136\"}}}',1790769600687,138,275);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf77-s60js',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s137\"}}}',1790769600692,139,277);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf7c-81psj',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s138\"}}}',1790769600697,140,279);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf7h-s9zgk',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s139\"}}}',1790769600702,141,281);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf7m-tb7nw',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s140\"}}}',1790769600707,142,283);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf7r-531l2',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s141\"}}}',1790769600712,143,285);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf7w-zhlp6',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s142\"}}}',1790769600717,144,287);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf81-akkmi',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s143\"}}}',1790769600722,145,289);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf86-em50x',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s144\"}}}',1790769600727,146,291);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf8b-qps68',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s145\"}}}',1790769600732,147,293);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf8g-6g0as',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s146\"}}}',1790769600737,148,295);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf8l-xlzsu',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s147\"}}}',1790769600742,149,297);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf8q-lmsa0',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s148\"}}}',1790769600747,150,299);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf8v-7mxxr',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s149\"}}}',1790769600752,151,301);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf90-0fgcj',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s150\"}}}',1790769600757,152,303);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf95-8nrjg',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s151\"}}}',1790769600762,153,305);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf9a-jpykv',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s152\"}}}',1790769600767,154,307);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf9f-dvlvf',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s153\"}}}',1790769600772,155,309);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf9k-fdaai',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s154\"}}}',1790769600777,156,311);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf9p-lrur4',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s155\"}}}',1790769600782,157,313);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf9u-vkufx',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s156\"}}}',1790769600787,158,315);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zf9z-t7zlt',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s157\"}}}',1790769600792,159,317);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zfa4-bpicm',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s158\"}}}',1790769600797,160,319);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary 'qjob-muo1zfa9-cjqmn',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"s159\"}}}',1790769600802,161,321);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000002',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme0\"},\"orgId\":\"acme\"}}',1790769600806,162,323);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000003',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme1\"},\"orgId\":\"acme\"}}',1790769600810,163,325);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000004',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme2\"},\"orgId\":\"acme\"}}',1790769600814,164,327);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000005',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme3\"},\"orgId\":\"acme\"}}',1790769600818,165,329);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::00000000-0000-4000-8000-000000000006',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"acme4\"},\"orgId\":\"acme\"}}',1790769600822,166,331);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme::weekly-report',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"fixed\"},\"orgId\":\"acme\"}}',1790769600851,173,345);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~acme:ayse:00000000-0000-4000-8000-00000000000c',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"ayse0\"},\"resourceId\":\"ayse\",\"orgId\":\"acme\"}}',1790769600846,172,343);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000001',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"dead\",\"fail\":true},\"orgId\":\"globex\"}}',1790769600012,3,5);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000007',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex0\"},\"orgId\":\"globex\"}}',1790769600826,167,333);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000008',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex1\"},\"orgId\":\"globex\"}}',1790769600830,168,335);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-000000000009',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex2\"},\"orgId\":\"globex\"}}',1790769600834,169,337);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-00000000000a',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex3\"},\"orgId\":\"globex\"}}',1790769600838,170,339);
INSERT INTO `gnl_work_log` VALUES (_binary 'qjob',_binary '~o~globex::00000000-0000-4000-8000-00000000000b',_binary '{\"json\":{\"type\":\"t\",\"payload\":{\"n\":\"globex4\"},\"orgId\":\"globex\"}}',1790769600842,171,341);
CREATE TABLE `gnl_work_seq` (
  `ns` varbinary(1024) NOT NULL,
  `seq` bigint NOT NULL,
  PRIMARY KEY (`ns`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO `gnl_work_seq` VALUES (_binary 'qjob',173);
CREATE TABLE `gnl_working_memory` (
  `scope_id` varbinary(3072) NOT NULL,
  `data` longblob NOT NULL,
  `updated_at` bigint NOT NULL,
  PRIMARY KEY (`scope_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
