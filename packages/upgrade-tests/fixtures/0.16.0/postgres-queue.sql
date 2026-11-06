-- Written by packages/upgrade-tests/generate/0.16.0.mjs --backend postgres. Do not edit.
CREATE FUNCTION public.gnl_owner_unplace() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
   BEGIN
     IF NEW.value IS DISTINCT FROM OLD.value AND NEW.owner IS NOT DISTINCT FROM OLD.owner THEN NEW.owner := NULL; END IF;
     RETURN NEW;
   END $$;

CREATE FUNCTION public.gnl_run_unplace() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
   BEGIN
     IF TG_OP = 'UPDATE' AND NEW.value IS NOT DISTINCT FROM OLD.value THEN RETURN NULL; END IF;
     -- The table of the schema that fired it, not the writer's search_path (a data-only restore runs with an empty one).
     -- Unconditional: under REPEATABLE READ a writer that waited on the relations step still sees the run
     -- as unplaced; 'WHERE resource_id IS NOT NULL' matched nothing in that snapshot and left the step's
     -- placement standing under the old person. Updating the row it cannot see changed makes Postgres
     -- refuse the write (40001) instead — surfaced, retried by its caller.
     EXECUTE format('UPDATE %I.gnl_runs SET resource_id = NULL, thread_id = NULL WHERE run_id = $1', TG_TABLE_SCHEMA)
       USING left(NEW.key, length(NEW.key) - 6);
     RETURN NULL;
   END $_$;

CREATE TABLE public.gnl_cache (
    key text NOT NULL,
    value text NOT NULL,
    expires_at bigint
);

CREATE TABLE public.gnl_counters (
    key text NOT NULL,
    field text NOT NULL,
    value double precision NOT NULL
);

CREATE TABLE public.gnl_message_batches (
    thread_id text NOT NULL,
    batch_key text NOT NULL,
    seq_from integer NOT NULL,
    seq_to integer NOT NULL,
    ts bigint NOT NULL
);

CREATE TABLE public.gnl_messages (
    thread_id text NOT NULL,
    seq integer NOT NULL,
    role text NOT NULL,
    text text,
    embedding text,
    metadata text,
    ts bigint NOT NULL,
    message text NOT NULL
);

CREATE TABLE public.gnl_meta (
    k text NOT NULL,
    v text NOT NULL
);

CREATE TABLE public.gnl_observations (
    thread_id text NOT NULL,
    obs text NOT NULL
);

CREATE SEQUENCE public.gnl_run_journal_ord
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.gnl_run_journal (
    key text NOT NULL,
    run_id text,
    kind text,
    suspended boolean DEFAULT false NOT NULL,
    value text NOT NULL,
    created_at bigint NOT NULL,
    owner text,
    ord bigint DEFAULT nextval('public.gnl_run_journal_ord'::regclass) NOT NULL
);

CREATE TABLE public.gnl_runs (
    run_id text NOT NULL,
    model_steps integer DEFAULT 0 NOT NULL,
    tool_calls integer DEFAULT 0 NOT NULL,
    suspended_count integer DEFAULT 0 NOT NULL,
    outcome text,
    status text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    thread_id text,
    resource_id text
);

CREATE TABLE public.gnl_threads (
    id text NOT NULL,
    resource_id text NOT NULL,
    title text,
    parent_thread_id text,
    metadata text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

CREATE TABLE public.gnl_vectors (
    id text NOT NULL,
    text text NOT NULL,
    embedding text NOT NULL,
    metadata text,
    namespace text,
    created_at bigint NOT NULL,
    doc text,
    owner text,
    shared boolean
);

CREATE TABLE public.gnl_work_kv (
    key text NOT NULL,
    value text NOT NULL
);

CREATE SEQUENCE public.gnl_work_log_ord
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.gnl_work_log (
    ns text NOT NULL,
    id text NOT NULL,
    payload text NOT NULL,
    ts bigint NOT NULL,
    seq bigint DEFAULT 0 NOT NULL,
    ord bigint DEFAULT nextval('public.gnl_work_log_ord'::regclass) NOT NULL
);

CREATE TABLE public.gnl_work_seq (
    ns text NOT NULL,
    seq bigint NOT NULL
);

CREATE TABLE public.gnl_working_memory (
    scope_id text NOT NULL,
    data text NOT NULL,
    updated_at bigint NOT NULL
);

INSERT INTO public.gnl_meta VALUES ('schema_version', '1');

INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo0-cx4dc:input', NULL, NULL, false, '{"json":{"at":1790769600051,"ownerKind":"unknown","_v":2}}', 1790769600052, NULL, 3);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo0-cx4dc:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-0wdy75","expires":0,"token":"00000000-0000-4000-8000-00000000000e"}}', 1790769600047, NULL, 1);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo3-3t90t:input', NULL, NULL, false, '{"json":{"at":1790769600060,"ownerKind":"unknown","_v":2}}', 1790769600061, NULL, 6);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo3-3t90t:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-0wdy75","expires":0,"token":"00000000-0000-4000-8000-00000000000f"}}', 1790769600056, NULL, 4);
INSERT INTO public.gnl_run_journal VALUES ('org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001:input', NULL, NULL, false, '{"json":{"at":1790769600069,"ownerKind":"unknown","_v":2}}', 1790769600070, NULL, 9);
INSERT INTO public.gnl_run_journal VALUES ('job:~o~globex::00000000-0000-4000-8000-000000000001:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-0wdy75","expires":0,"token":"00000000-0000-4000-8000-000000000010"}}', 1790769600065, NULL, 7);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo8-ob6co:input', NULL, NULL, false, '{"json":{"at":1790769600077,"ownerKind":"unknown","_v":2}}', 1790769600078, NULL, 12);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo8-ob6co:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-0wdy75","expires":0,"token":"00000000-0000-4000-8000-000000000011"}}', 1790769600073, NULL, 10);

INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeo0-cx4dc', 0, 0, 0, NULL, 'completed', 1790769600053, 1790769600053, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeo3-3t90t', 0, 0, 0, NULL, 'completed', 1790769600062, 1790769600062, NULL, '');
INSERT INTO public.gnl_runs VALUES ('org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001', 0, 0, 0, NULL, 'completed', 1790769600071, 1790769600071, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeo8-ob6co', 0, 0, 0, NULL, 'completed', 1790769600079, 1790769600079, NULL, '');

INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeo0-cx4dc', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeo0-cx4dc', '{"json":"00000000-0000-4000-8000-00000000000e"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeo0-cx4dc', '{"json":{"at":1790769600054,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeo3-3t90t', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeo3-3t90t', '{"json":"00000000-0000-4000-8000-00000000000f"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeo3-3t90t', '{"json":{"at":1790769600063,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:~o~globex::00000000-0000-4000-8000-000000000001', '{"json":"00000000-0000-4000-8000-000000000010"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qfail:~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"error":"boom","attempts":1}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeo8-ob6co', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeo8-ob6co', '{"json":"00000000-0000-4000-8000-000000000011"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeo8-ob6co', '{"json":{"at":1790769600080,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('__qworkers__', '{"json":{}}');

INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeo0-cx4dc', '{"json":{"type":"t"}}', 1790769600002, 0, 2);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeo3-3t90t', '{"json":{"type":"t"}}', 1790769600005, 0, 4);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"type":"t"}}', 1790769600007, 0, 6);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeo8-ob6co', '{"json":{"type":"t"}}', 1790769600010, 0, 8);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeob-x1n5k', '{"json":{"type":"t"}}', 1790769600013, 0, 10);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeoe-3nn6l', '{"json":{"type":"t"}}', 1790769600016, 0, 12);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeoh-au3lb', '{"json":{"type":"t"}}', 1790769600019, 0, 14);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000002', '{"json":{"type":"t"}}', 1790769600021, 0, 16);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000003', '{"json":{"type":"t"}}', 1790769600023, 0, 18);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000004', '{"json":{"type":"t"}}', 1790769600025, 0, 20);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000005', '{"json":{"type":"t"}}', 1790769600027, 0, 22);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000006', '{"json":{"type":"t"}}', 1790769600029, 0, 24);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000007', '{"json":{"type":"t"}}', 1790769600031, 0, 26);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000008', '{"json":{"type":"t"}}', 1790769600033, 0, 28);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000009', '{"json":{"type":"t"}}', 1790769600035, 0, 30);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-00000000000a', '{"json":{"type":"t"}}', 1790769600037, 0, 32);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-00000000000b', '{"json":{"type":"t"}}', 1790769600039, 0, 34);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme:ayse:00000000-0000-4000-8000-00000000000c', '{"json":{"type":"t"}}', 1790769600041, 0, 36);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::weekly-report', '{"json":{"type":"t"}}', 1790769600043, 0, 38);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeo0-cx4dc', '{"json":{"type":"t","payload":{"n":"s0"}}}', 1790769600001, 1, 1);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeo3-3t90t', '{"json":{"type":"t","payload":{"n":"s1"}}}', 1790769600004, 2, 3);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"type":"t","payload":{"n":"dead","fail":true},"orgId":"globex"}}', 1790769600006, 3, 5);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeo8-ob6co', '{"json":{"type":"t","payload":{"n":"s2"}}}', 1790769600009, 4, 7);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeob-x1n5k', '{"json":{"type":"t","payload":{"n":"s3"}}}', 1790769600012, 5, 9);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeoe-3nn6l', '{"json":{"type":"t","payload":{"n":"s4"}}}', 1790769600015, 6, 11);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeoh-au3lb', '{"json":{"type":"t","payload":{"n":"s5"}}}', 1790769600018, 7, 13);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000002', '{"json":{"type":"t","payload":{"n":"acme0"},"orgId":"acme"}}', 1790769600020, 8, 15);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000003', '{"json":{"type":"t","payload":{"n":"acme1"},"orgId":"acme"}}', 1790769600022, 9, 17);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000004', '{"json":{"type":"t","payload":{"n":"acme2"},"orgId":"acme"}}', 1790769600024, 10, 19);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000005', '{"json":{"type":"t","payload":{"n":"acme3"},"orgId":"acme"}}', 1790769600026, 11, 21);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000006', '{"json":{"type":"t","payload":{"n":"acme4"},"orgId":"acme"}}', 1790769600028, 12, 23);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000007', '{"json":{"type":"t","payload":{"n":"globex0"},"orgId":"globex"}}', 1790769600030, 13, 25);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000008', '{"json":{"type":"t","payload":{"n":"globex1"},"orgId":"globex"}}', 1790769600032, 14, 27);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000009', '{"json":{"type":"t","payload":{"n":"globex2"},"orgId":"globex"}}', 1790769600034, 15, 29);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-00000000000a', '{"json":{"type":"t","payload":{"n":"globex3"},"orgId":"globex"}}', 1790769600036, 16, 31);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-00000000000b', '{"json":{"type":"t","payload":{"n":"globex4"},"orgId":"globex"}}', 1790769600038, 17, 33);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::weekly-report', '{"json":{"type":"t","payload":{"n":"fixed"},"orgId":"acme"}}', 1790769600042, 19, 37);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme:ayse:00000000-0000-4000-8000-00000000000c', '{"json":{"type":"t","payload":{"n":"ayse0"},"resourceId":"ayse","orgId":"acme"}}', 1790769600040, 18, 35);

INSERT INTO public.gnl_work_seq VALUES ('qjob', 19);

SELECT pg_catalog.setval('public.gnl_run_journal_ord', 12, true);

SELECT pg_catalog.setval('public.gnl_work_log_ord', 38, true);

ALTER TABLE ONLY public.gnl_cache
    ADD CONSTRAINT gnl_cache_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.gnl_counters
    ADD CONSTRAINT gnl_counters_pkey PRIMARY KEY (key, field);

ALTER TABLE ONLY public.gnl_message_batches
    ADD CONSTRAINT gnl_message_batches_pkey PRIMARY KEY (thread_id, batch_key);

ALTER TABLE ONLY public.gnl_messages
    ADD CONSTRAINT gnl_messages_pkey PRIMARY KEY (thread_id, seq);

ALTER TABLE ONLY public.gnl_meta
    ADD CONSTRAINT gnl_meta_pkey PRIMARY KEY (k);

ALTER TABLE ONLY public.gnl_observations
    ADD CONSTRAINT gnl_observations_pkey PRIMARY KEY (thread_id);

ALTER TABLE ONLY public.gnl_run_journal
    ADD CONSTRAINT gnl_run_journal_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.gnl_runs
    ADD CONSTRAINT gnl_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.gnl_threads
    ADD CONSTRAINT gnl_threads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gnl_vectors
    ADD CONSTRAINT gnl_vectors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gnl_work_kv
    ADD CONSTRAINT gnl_work_kv_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.gnl_work_log
    ADD CONSTRAINT gnl_work_log_pkey PRIMARY KEY (ns, id);

ALTER TABLE ONLY public.gnl_work_seq
    ADD CONSTRAINT gnl_work_seq_pkey PRIMARY KEY (ns);

ALTER TABLE ONLY public.gnl_working_memory
    ADD CONSTRAINT gnl_working_memory_pkey PRIMARY KEY (scope_id);

CREATE INDEX gnl_counters_cprefix ON public.gnl_counters USING btree (key COLLATE "C");

CREATE INDEX gnl_run_journal_cprefix ON public.gnl_run_journal USING btree (key COLLATE "C");

CREATE INDEX gnl_run_journal_owner ON public.gnl_run_journal USING btree (owner, key) WHERE (key ~~ '%thread:%:owner'::text);

CREATE INDEX gnl_run_journal_run ON public.gnl_run_journal USING btree (run_id, created_at);

CREATE INDEX gnl_runs_cprefix ON public.gnl_runs USING btree (run_id COLLATE "C");

CREATE INDEX gnl_runs_created ON public.gnl_runs USING btree (created_at, run_id);

CREATE INDEX gnl_runs_open ON public.gnl_runs USING btree (created_at, run_id) WHERE (status <> 'completed'::text);

CREATE INDEX gnl_runs_resource ON public.gnl_runs USING btree (resource_id, created_at, run_id);

CREATE INDEX gnl_runs_status ON public.gnl_runs USING btree (status, created_at, run_id) WHERE (status <> 'completed'::text);

CREATE INDEX gnl_runs_thread ON public.gnl_runs USING btree (thread_id, created_at, run_id);

CREATE INDEX gnl_runs_updated ON public.gnl_runs USING btree (updated_at);

CREATE INDEX gnl_threads_res ON public.gnl_threads USING btree (resource_id, updated_at);

CREATE INDEX gnl_vectors_doc ON public.gnl_vectors USING btree (doc);

CREATE INDEX gnl_work_log_ns ON public.gnl_work_log USING btree (ns, ts);

CREATE INDEX gnl_work_log_seq ON public.gnl_work_log USING btree (ns, seq, ts, id);

CREATE TRIGGER gnl_owner_unplace BEFORE UPDATE ON public.gnl_run_journal FOR EACH ROW WHEN ((old.owner IS NOT NULL)) EXECUTE FUNCTION public.gnl_owner_unplace();

CREATE TRIGGER gnl_run_unplace AFTER INSERT OR UPDATE OF value ON public.gnl_run_journal FOR EACH ROW WHEN ((new.key ~~ '%:input'::text)) EXECUTE FUNCTION public.gnl_run_unplace();
