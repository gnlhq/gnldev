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

INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo0-cx4dc:input', NULL, NULL, false, '{"json":{"at":1790769600513,"ownerKind":"unknown","_v":2}}', 1790769600514, NULL, 3);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo0-cx4dc:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000000e"}}', 1790769600509, NULL, 1);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo3-3t90t:input', NULL, NULL, false, '{"json":{"at":1790769600522,"ownerKind":"unknown","_v":2}}', 1790769600523, NULL, 6);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo3-3t90t:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000000f"}}', 1790769600518, NULL, 4);
INSERT INTO public.gnl_run_journal VALUES ('org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001:input', NULL, NULL, false, '{"json":{"at":1790769600531,"ownerKind":"unknown","_v":2}}', 1790769600532, NULL, 9);
INSERT INTO public.gnl_run_journal VALUES ('job:~o~globex::00000000-0000-4000-8000-000000000001:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000010"}}', 1790769600527, NULL, 7);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo8-ob6co:input', NULL, NULL, false, '{"json":{"at":1790769600539,"ownerKind":"unknown","_v":2}}', 1790769600540, NULL, 12);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeo8-ob6co:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000011"}}', 1790769600535, NULL, 10);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeob-x1n5k:input', NULL, NULL, false, '{"json":{"at":1790769600548,"ownerKind":"unknown","_v":2}}', 1790769600549, NULL, 15);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeob-x1n5k:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000012"}}', 1790769600544, NULL, 13);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoe-3nn6l:input', NULL, NULL, false, '{"json":{"at":1790769600557,"ownerKind":"unknown","_v":2}}', 1790769600558, NULL, 18);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoe-3nn6l:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000013"}}', 1790769600553, NULL, 16);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoh-au3lb:input', NULL, NULL, false, '{"json":{"at":1790769600566,"ownerKind":"unknown","_v":2}}', 1790769600567, NULL, 21);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoh-au3lb:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000014"}}', 1790769600562, NULL, 19);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeok-0wdy7:input', NULL, NULL, false, '{"json":{"at":1790769600575,"ownerKind":"unknown","_v":2}}', 1790769600576, NULL, 24);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeok-0wdy7:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000015"}}', 1790769600571, NULL, 22);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeon-gsfn4:input', NULL, NULL, false, '{"json":{"at":1790769600584,"ownerKind":"unknown","_v":2}}', 1790769600585, NULL, 27);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeon-gsfn4:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000016"}}', 1790769600580, NULL, 25);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoq-flbxl:input', NULL, NULL, false, '{"json":{"at":1790769600593,"ownerKind":"unknown","_v":2}}', 1790769600594, NULL, 30);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoq-flbxl:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000017"}}', 1790769600589, NULL, 28);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeot-jpjoy:input', NULL, NULL, false, '{"json":{"at":1790769600602,"ownerKind":"unknown","_v":2}}', 1790769600603, NULL, 33);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeot-jpjoy:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000018"}}', 1790769600598, NULL, 31);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeow-iclf6:input', NULL, NULL, false, '{"json":{"at":1790769600611,"ownerKind":"unknown","_v":2}}', 1790769600612, NULL, 36);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeow-iclf6:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000019"}}', 1790769600607, NULL, 34);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoz-b20ak:input', NULL, NULL, false, '{"json":{"at":1790769600620,"ownerKind":"unknown","_v":2}}', 1790769600621, NULL, 39);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeoz-b20ak:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000001a"}}', 1790769600616, NULL, 37);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zep2-wcazd:input', NULL, NULL, false, '{"json":{"at":1790769600629,"ownerKind":"unknown","_v":2}}', 1790769600630, NULL, 42);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zep2-wcazd:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000001b"}}', 1790769600625, NULL, 40);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zep5-c7yw5:input', NULL, NULL, false, '{"json":{"at":1790769600638,"ownerKind":"unknown","_v":2}}', 1790769600639, NULL, 45);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zep5-c7yw5:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000001c"}}', 1790769600634, NULL, 43);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zep8-3omq7:input', NULL, NULL, false, '{"json":{"at":1790769600647,"ownerKind":"unknown","_v":2}}', 1790769600648, NULL, 48);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zep8-3omq7:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000001d"}}', 1790769600643, NULL, 46);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepb-8xhqz:input', NULL, NULL, false, '{"json":{"at":1790769600656,"ownerKind":"unknown","_v":2}}', 1790769600657, NULL, 51);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepb-8xhqz:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000001e"}}', 1790769600652, NULL, 49);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepe-9f7ve:input', NULL, NULL, false, '{"json":{"at":1790769600665,"ownerKind":"unknown","_v":2}}', 1790769600666, NULL, 54);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepe-9f7ve:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000001f"}}', 1790769600661, NULL, 52);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeph-uletq:input', NULL, NULL, false, '{"json":{"at":1790769600674,"ownerKind":"unknown","_v":2}}', 1790769600675, NULL, 57);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeph-uletq:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000020"}}', 1790769600670, NULL, 55);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepk-6wpjm:input', NULL, NULL, false, '{"json":{"at":1790769600683,"ownerKind":"unknown","_v":2}}', 1790769600684, NULL, 60);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepk-6wpjm:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000021"}}', 1790769600679, NULL, 58);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepn-nuxoy:input', NULL, NULL, false, '{"json":{"at":1790769600692,"ownerKind":"unknown","_v":2}}', 1790769600693, NULL, 63);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepn-nuxoy:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000022"}}', 1790769600688, NULL, 61);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepq-ygau7:input', NULL, NULL, false, '{"json":{"at":1790769600701,"ownerKind":"unknown","_v":2}}', 1790769600702, NULL, 66);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepq-ygau7:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000023"}}', 1790769600697, NULL, 64);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zept-rbgjk:input', NULL, NULL, false, '{"json":{"at":1790769600710,"ownerKind":"unknown","_v":2}}', 1790769600711, NULL, 69);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zept-rbgjk:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000024"}}', 1790769600706, NULL, 67);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepw-t976a:input', NULL, NULL, false, '{"json":{"at":1790769600719,"ownerKind":"unknown","_v":2}}', 1790769600720, NULL, 72);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepw-t976a:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000025"}}', 1790769600715, NULL, 70);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepz-wcwtf:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000026"}}', 1790769600724, NULL, 73);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zepz-wcwtf:input', NULL, NULL, false, '{"json":{"at":1790769600728,"ownerKind":"unknown","_v":2}}', 1790769600729, NULL, 75);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeq2-w0wln:input', NULL, NULL, false, '{"json":{"at":1790769600737,"ownerKind":"unknown","_v":2}}', 1790769600738, NULL, 78);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeq2-w0wln:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000027"}}', 1790769600733, NULL, 76);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeq5-j2ir4:input', NULL, NULL, false, '{"json":{"at":1790769600746,"ownerKind":"unknown","_v":2}}', 1790769600747, NULL, 81);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeq5-j2ir4:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000028"}}', 1790769600742, NULL, 79);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeq8-931ny:input', NULL, NULL, false, '{"json":{"at":1790769600755,"ownerKind":"unknown","_v":2}}', 1790769600756, NULL, 84);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeq8-931ny:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000029"}}', 1790769600751, NULL, 82);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqb-bkvz7:input', NULL, NULL, false, '{"json":{"at":1790769600764,"ownerKind":"unknown","_v":2}}', 1790769600765, NULL, 87);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqb-bkvz7:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000002a"}}', 1790769600760, NULL, 85);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqe-zbyxf:input', NULL, NULL, false, '{"json":{"at":1790769600773,"ownerKind":"unknown","_v":2}}', 1790769600774, NULL, 90);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqe-zbyxf:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000002b"}}', 1790769600769, NULL, 88);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqh-nihlz:input', NULL, NULL, false, '{"json":{"at":1790769600782,"ownerKind":"unknown","_v":2}}', 1790769600783, NULL, 93);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqh-nihlz:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000002c"}}', 1790769600778, NULL, 91);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqk-ul3xm:input', NULL, NULL, false, '{"json":{"at":1790769600791,"ownerKind":"unknown","_v":2}}', 1790769600792, NULL, 96);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqk-ul3xm:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000002d"}}', 1790769600787, NULL, 94);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqn-qx9rk:input', NULL, NULL, false, '{"json":{"at":1790769600800,"ownerKind":"unknown","_v":2}}', 1790769600801, NULL, 99);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqn-qx9rk:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000002e"}}', 1790769600796, NULL, 97);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqq-hpp5f:input', NULL, NULL, false, '{"json":{"at":1790769600809,"ownerKind":"unknown","_v":2}}', 1790769600810, NULL, 102);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqq-hpp5f:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000002f"}}', 1790769600805, NULL, 100);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqt-5g6g2:input', NULL, NULL, false, '{"json":{"at":1790769600818,"ownerKind":"unknown","_v":2}}', 1790769600819, NULL, 105);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqt-5g6g2:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000030"}}', 1790769600814, NULL, 103);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqw-qt4k0:input', NULL, NULL, false, '{"json":{"at":1790769600827,"ownerKind":"unknown","_v":2}}', 1790769600828, NULL, 108);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqw-qt4k0:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000031"}}', 1790769600823, NULL, 106);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqz-1rd4y:input', NULL, NULL, false, '{"json":{"at":1790769600836,"ownerKind":"unknown","_v":2}}', 1790769600837, NULL, 111);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zeqz-1rd4y:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000032"}}', 1790769600832, NULL, 109);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zer2-crf1f:input', NULL, NULL, false, '{"json":{"at":1790769600845,"ownerKind":"unknown","_v":2}}', 1790769600846, NULL, 114);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zer2-crf1f:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000033"}}', 1790769600841, NULL, 112);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zer5-tk6x3:input', NULL, NULL, false, '{"json":{"at":1790769600854,"ownerKind":"unknown","_v":2}}', 1790769600855, NULL, 117);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zer5-tk6x3:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000034"}}', 1790769600850, NULL, 115);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zer8-zaisz:input', NULL, NULL, false, '{"json":{"at":1790769600863,"ownerKind":"unknown","_v":2}}', 1790769600864, NULL, 120);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zer8-zaisz:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000035"}}', 1790769600859, NULL, 118);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerb-tiogq:input', NULL, NULL, false, '{"json":{"at":1790769600872,"ownerKind":"unknown","_v":2}}', 1790769600873, NULL, 123);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerb-tiogq:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000036"}}', 1790769600868, NULL, 121);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zere-2lavf:input', NULL, NULL, false, '{"json":{"at":1790769600881,"ownerKind":"unknown","_v":2}}', 1790769600882, NULL, 126);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zere-2lavf:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000037"}}', 1790769600877, NULL, 124);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerh-e06uf:input', NULL, NULL, false, '{"json":{"at":1790769600890,"ownerKind":"unknown","_v":2}}', 1790769600891, NULL, 129);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerh-e06uf:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000038"}}', 1790769600886, NULL, 127);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerk-9l2dc:input', NULL, NULL, false, '{"json":{"at":1790769600899,"ownerKind":"unknown","_v":2}}', 1790769600900, NULL, 132);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerk-9l2dc:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000039"}}', 1790769600895, NULL, 130);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zern-mqmm9:input', NULL, NULL, false, '{"json":{"at":1790769600908,"ownerKind":"unknown","_v":2}}', 1790769600909, NULL, 135);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zern-mqmm9:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000003a"}}', 1790769600904, NULL, 133);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerq-1kq38:input', NULL, NULL, false, '{"json":{"at":1790769600917,"ownerKind":"unknown","_v":2}}', 1790769600918, NULL, 138);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerq-1kq38:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000003b"}}', 1790769600913, NULL, 136);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zert-y3d64:input', NULL, NULL, false, '{"json":{"at":1790769600926,"ownerKind":"unknown","_v":2}}', 1790769600927, NULL, 141);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zert-y3d64:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000003c"}}', 1790769600922, NULL, 139);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerw-czk0d:input', NULL, NULL, false, '{"json":{"at":1790769600935,"ownerKind":"unknown","_v":2}}', 1790769600936, NULL, 144);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerw-czk0d:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000003d"}}', 1790769600931, NULL, 142);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerz-5j3x8:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000003e"}}', 1790769600940, NULL, 145);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zerz-5j3x8:input', NULL, NULL, false, '{"json":{"at":1790769600944,"ownerKind":"unknown","_v":2}}', 1790769600945, NULL, 147);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zes2-ltox5:input', NULL, NULL, false, '{"json":{"at":1790769600953,"ownerKind":"unknown","_v":2}}', 1790769600954, NULL, 150);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zes2-ltox5:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-00000000003f"}}', 1790769600949, NULL, 148);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zes5-oabfq:input', NULL, NULL, false, '{"json":{"at":1790769600962,"ownerKind":"unknown","_v":2}}', 1790769600963, NULL, 153);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zes5-oabfq:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000040"}}', 1790769600958, NULL, 151);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zes8-meot5:input', NULL, NULL, false, '{"json":{"at":1790769600971,"ownerKind":"unknown","_v":2}}', 1790769600972, NULL, 156);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zes8-meot5:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000041"}}', 1790769600967, NULL, 154);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesb-6h1mj:input', NULL, NULL, false, '{"json":{"at":1790769600980,"ownerKind":"unknown","_v":2}}', 1790769600981, NULL, 159);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesb-6h1mj:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000042"}}', 1790769600976, NULL, 157);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zese-tnifs:input', NULL, NULL, false, '{"json":{"at":1790769600989,"ownerKind":"unknown","_v":2}}', 1790769600990, NULL, 162);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zese-tnifs:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000043"}}', 1790769600985, NULL, 160);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesh-ie9cz:input', NULL, NULL, false, '{"json":{"at":1790769600998,"ownerKind":"unknown","_v":2}}', 1790769600999, NULL, 165);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesh-ie9cz:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000044"}}', 1790769600994, NULL, 163);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesk-5yv68:input', NULL, NULL, false, '{"json":{"at":1790769601007,"ownerKind":"unknown","_v":2}}', 1790769601008, NULL, 168);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesk-5yv68:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000045"}}', 1790769601003, NULL, 166);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesn-h6r95:input', NULL, NULL, false, '{"json":{"at":1790769601016,"ownerKind":"unknown","_v":2}}', 1790769601017, NULL, 171);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesn-h6r95:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000046"}}', 1790769601012, NULL, 169);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesq-zu9le:input', NULL, NULL, false, '{"json":{"at":1790769601025,"ownerKind":"unknown","_v":2}}', 1790769601026, NULL, 174);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesq-zu9le:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000047"}}', 1790769601021, NULL, 172);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zest-8pz16:input', NULL, NULL, false, '{"json":{"at":1790769601034,"ownerKind":"unknown","_v":2}}', 1790769601035, NULL, 177);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zest-8pz16:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000048"}}', 1790769601030, NULL, 175);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesw-502o7:input', NULL, NULL, false, '{"json":{"at":1790769601043,"ownerKind":"unknown","_v":2}}', 1790769601044, NULL, 180);
INSERT INTO public.gnl_run_journal VALUES ('job:qjob-muo1zesw-502o7:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-skl1hx","expires":0,"token":"00000000-0000-4000-8000-000000000049"}}', 1790769601039, NULL, 178);

INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeo0-cx4dc', 0, 0, 0, NULL, 'completed', 1790769600515, 1790769600515, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeo3-3t90t', 0, 0, 0, NULL, 'completed', 1790769600524, 1790769600524, NULL, '');
INSERT INTO public.gnl_runs VALUES ('org:globex:job:~o~globex::00000000-0000-4000-8000-000000000001', 0, 0, 0, NULL, 'completed', 1790769600533, 1790769600533, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeo8-ob6co', 0, 0, 0, NULL, 'completed', 1790769600541, 1790769600541, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeob-x1n5k', 0, 0, 0, NULL, 'completed', 1790769600550, 1790769600550, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeoe-3nn6l', 0, 0, 0, NULL, 'completed', 1790769600559, 1790769600559, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeoh-au3lb', 0, 0, 0, NULL, 'completed', 1790769600568, 1790769600568, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeok-0wdy7', 0, 0, 0, NULL, 'completed', 1790769600577, 1790769600577, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeon-gsfn4', 0, 0, 0, NULL, 'completed', 1790769600586, 1790769600586, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeoq-flbxl', 0, 0, 0, NULL, 'completed', 1790769600595, 1790769600595, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeot-jpjoy', 0, 0, 0, NULL, 'completed', 1790769600604, 1790769600604, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeow-iclf6', 0, 0, 0, NULL, 'completed', 1790769600613, 1790769600613, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeoz-b20ak', 0, 0, 0, NULL, 'completed', 1790769600622, 1790769600622, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zep2-wcazd', 0, 0, 0, NULL, 'completed', 1790769600631, 1790769600631, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zep5-c7yw5', 0, 0, 0, NULL, 'completed', 1790769600640, 1790769600640, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zep8-3omq7', 0, 0, 0, NULL, 'completed', 1790769600649, 1790769600649, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zepb-8xhqz', 0, 0, 0, NULL, 'completed', 1790769600658, 1790769600658, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zepe-9f7ve', 0, 0, 0, NULL, 'completed', 1790769600667, 1790769600667, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeph-uletq', 0, 0, 0, NULL, 'completed', 1790769600676, 1790769600676, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zepk-6wpjm', 0, 0, 0, NULL, 'completed', 1790769600685, 1790769600685, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zepn-nuxoy', 0, 0, 0, NULL, 'completed', 1790769600694, 1790769600694, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zepq-ygau7', 0, 0, 0, NULL, 'completed', 1790769600703, 1790769600703, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zept-rbgjk', 0, 0, 0, NULL, 'completed', 1790769600712, 1790769600712, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zepw-t976a', 0, 0, 0, NULL, 'completed', 1790769600721, 1790769600721, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zepz-wcwtf', 0, 0, 0, NULL, 'completed', 1790769600730, 1790769600730, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeq2-w0wln', 0, 0, 0, NULL, 'completed', 1790769600739, 1790769600739, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeq5-j2ir4', 0, 0, 0, NULL, 'completed', 1790769600748, 1790769600748, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeq8-931ny', 0, 0, 0, NULL, 'completed', 1790769600757, 1790769600757, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqb-bkvz7', 0, 0, 0, NULL, 'completed', 1790769600766, 1790769600766, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqe-zbyxf', 0, 0, 0, NULL, 'completed', 1790769600775, 1790769600775, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqh-nihlz', 0, 0, 0, NULL, 'completed', 1790769600784, 1790769600784, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqk-ul3xm', 0, 0, 0, NULL, 'completed', 1790769600793, 1790769600793, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqn-qx9rk', 0, 0, 0, NULL, 'completed', 1790769600802, 1790769600802, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqq-hpp5f', 0, 0, 0, NULL, 'completed', 1790769600811, 1790769600811, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqt-5g6g2', 0, 0, 0, NULL, 'completed', 1790769600820, 1790769600820, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqw-qt4k0', 0, 0, 0, NULL, 'completed', 1790769600829, 1790769600829, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zeqz-1rd4y', 0, 0, 0, NULL, 'completed', 1790769600838, 1790769600838, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zer2-crf1f', 0, 0, 0, NULL, 'completed', 1790769600847, 1790769600847, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zer5-tk6x3', 0, 0, 0, NULL, 'completed', 1790769600856, 1790769600856, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zer8-zaisz', 0, 0, 0, NULL, 'completed', 1790769600865, 1790769600865, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zerb-tiogq', 0, 0, 0, NULL, 'completed', 1790769600874, 1790769600874, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zere-2lavf', 0, 0, 0, NULL, 'completed', 1790769600883, 1790769600883, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zerh-e06uf', 0, 0, 0, NULL, 'completed', 1790769600892, 1790769600892, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zerk-9l2dc', 0, 0, 0, NULL, 'completed', 1790769600901, 1790769600901, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zern-mqmm9', 0, 0, 0, NULL, 'completed', 1790769600910, 1790769600910, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zerq-1kq38', 0, 0, 0, NULL, 'completed', 1790769600919, 1790769600919, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zert-y3d64', 0, 0, 0, NULL, 'completed', 1790769600928, 1790769600928, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zerw-czk0d', 0, 0, 0, NULL, 'completed', 1790769600937, 1790769600937, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zerz-5j3x8', 0, 0, 0, NULL, 'completed', 1790769600946, 1790769600946, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zes2-ltox5', 0, 0, 0, NULL, 'completed', 1790769600955, 1790769600955, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zes5-oabfq', 0, 0, 0, NULL, 'completed', 1790769600964, 1790769600964, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zes8-meot5', 0, 0, 0, NULL, 'completed', 1790769600973, 1790769600973, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zesb-6h1mj', 0, 0, 0, NULL, 'completed', 1790769600982, 1790769600982, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zese-tnifs', 0, 0, 0, NULL, 'completed', 1790769600991, 1790769600991, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zesh-ie9cz', 0, 0, 0, NULL, 'completed', 1790769601000, 1790769601000, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zesk-5yv68', 0, 0, 0, NULL, 'completed', 1790769601009, 1790769601009, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zesn-h6r95', 0, 0, 0, NULL, 'completed', 1790769601018, 1790769601018, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zesq-zu9le', 0, 0, 0, NULL, 'completed', 1790769601027, 1790769601027, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zest-8pz16', 0, 0, 0, NULL, 'completed', 1790769601036, 1790769601036, NULL, '');
INSERT INTO public.gnl_runs VALUES ('job:qjob-muo1zesw-502o7', 0, 0, 0, NULL, 'completed', 1790769601045, 1790769601045, NULL, '');

INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zep2-wcazd', '{"json":"00000000-0000-4000-8000-00000000001b"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeo0-cx4dc', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeo0-cx4dc', '{"json":"00000000-0000-4000-8000-00000000000e"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeo0-cx4dc', '{"json":{"at":1790769600516,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zep2-wcazd', '{"json":{"at":1790769600632,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeo3-3t90t', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeo3-3t90t', '{"json":"00000000-0000-4000-8000-00000000000f"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeo3-3t90t', '{"json":{"at":1790769600525,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:~o~globex::00000000-0000-4000-8000-000000000001', '{"json":"00000000-0000-4000-8000-000000000010"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qfail:~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"error":"boom","attempts":1}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zepk-6wpjm', '{"json":"00000000-0000-4000-8000-000000000021"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeo8-ob6co', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeo8-ob6co', '{"json":"00000000-0000-4000-8000-000000000011"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeo8-ob6co', '{"json":{"at":1790769600542,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zep5-c7yw5', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeob-x1n5k', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeob-x1n5k', '{"json":"00000000-0000-4000-8000-000000000012"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeob-x1n5k', '{"json":{"at":1790769600551,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zep5-c7yw5', '{"json":"00000000-0000-4000-8000-00000000001c"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeoe-3nn6l', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeoe-3nn6l', '{"json":"00000000-0000-4000-8000-000000000013"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeoe-3nn6l', '{"json":{"at":1790769600560,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zep5-c7yw5', '{"json":{"at":1790769600641,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeoh-au3lb', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeoh-au3lb', '{"json":"00000000-0000-4000-8000-000000000014"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeoh-au3lb', '{"json":{"at":1790769600569,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeok-0wdy7', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeok-0wdy7', '{"json":"00000000-0000-4000-8000-000000000015"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeok-0wdy7', '{"json":{"at":1790769600578,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zepk-6wpjm', '{"json":{"at":1790769600686,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeon-gsfn4', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeon-gsfn4', '{"json":"00000000-0000-4000-8000-000000000016"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeon-gsfn4', '{"json":{"at":1790769600587,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zep8-3omq7', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeoq-flbxl', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeoq-flbxl', '{"json":"00000000-0000-4000-8000-000000000017"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeoq-flbxl', '{"json":{"at":1790769600596,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zep8-3omq7', '{"json":"00000000-0000-4000-8000-00000000001d"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeot-jpjoy', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeot-jpjoy', '{"json":"00000000-0000-4000-8000-000000000018"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeot-jpjoy', '{"json":{"at":1790769600605,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zep8-3omq7', '{"json":{"at":1790769600650,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeow-iclf6', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeow-iclf6', '{"json":"00000000-0000-4000-8000-000000000019"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeow-iclf6', '{"json":{"at":1790769600614,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeoz-b20ak', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeoz-b20ak', '{"json":"00000000-0000-4000-8000-00000000001a"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeoz-b20ak', '{"json":{"at":1790769600623,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zep2-wcazd', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zepb-8xhqz', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zepb-8xhqz', '{"json":"00000000-0000-4000-8000-00000000001e"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zepb-8xhqz', '{"json":{"at":1790769600659,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zepn-nuxoy', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zepe-9f7ve', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zepe-9f7ve', '{"json":"00000000-0000-4000-8000-00000000001f"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zepe-9f7ve', '{"json":{"at":1790769600668,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zepn-nuxoy', '{"json":"00000000-0000-4000-8000-000000000022"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeph-uletq', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeph-uletq', '{"json":"00000000-0000-4000-8000-000000000020"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeph-uletq', '{"json":{"at":1790769600677,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zepk-6wpjm', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zepn-nuxoy', '{"json":{"at":1790769600695,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zept-rbgjk', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zepq-ygau7', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zepq-ygau7', '{"json":"00000000-0000-4000-8000-000000000023"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zepq-ygau7', '{"json":{"at":1790769600704,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zept-rbgjk', '{"json":"00000000-0000-4000-8000-000000000024"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zept-rbgjk', '{"json":{"at":1790769600713,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zepw-t976a', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zepw-t976a', '{"json":"00000000-0000-4000-8000-000000000025"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zepw-t976a', '{"json":{"at":1790769600722,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zepz-wcwtf', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zepz-wcwtf', '{"json":"00000000-0000-4000-8000-000000000026"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zepz-wcwtf', '{"json":{"at":1790769600731,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('__qworkers__', '{"json":{}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeq2-w0wln', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeq2-w0wln', '{"json":"00000000-0000-4000-8000-000000000027"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeq2-w0wln', '{"json":{"at":1790769600740,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeq5-j2ir4', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeq5-j2ir4', '{"json":"00000000-0000-4000-8000-000000000028"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeq5-j2ir4', '{"json":{"at":1790769600749,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zerb-tiogq', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeq8-931ny', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeq8-931ny', '{"json":"00000000-0000-4000-8000-000000000029"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeq8-931ny', '{"json":{"at":1790769600758,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zerb-tiogq', '{"json":"00000000-0000-4000-8000-000000000036"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqb-bkvz7', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqb-bkvz7', '{"json":"00000000-0000-4000-8000-00000000002a"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqb-bkvz7', '{"json":{"at":1790769600767,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zerb-tiogq', '{"json":{"at":1790769600875,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqe-zbyxf', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqe-zbyxf', '{"json":"00000000-0000-4000-8000-00000000002b"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqe-zbyxf', '{"json":{"at":1790769600776,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqh-nihlz', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqh-nihlz', '{"json":"00000000-0000-4000-8000-00000000002c"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqh-nihlz', '{"json":{"at":1790769600785,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zerz-5j3x8', '{"json":"00000000-0000-4000-8000-00000000003e"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqk-ul3xm', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqk-ul3xm', '{"json":"00000000-0000-4000-8000-00000000002d"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqk-ul3xm', '{"json":{"at":1790769600794,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zere-2lavf', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqn-qx9rk', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqn-qx9rk', '{"json":"00000000-0000-4000-8000-00000000002e"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqn-qx9rk', '{"json":{"at":1790769600803,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zere-2lavf', '{"json":"00000000-0000-4000-8000-000000000037"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqq-hpp5f', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqq-hpp5f', '{"json":"00000000-0000-4000-8000-00000000002f"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqq-hpp5f', '{"json":{"at":1790769600812,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zere-2lavf', '{"json":{"at":1790769600884,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqt-5g6g2', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqt-5g6g2', '{"json":"00000000-0000-4000-8000-000000000030"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqt-5g6g2', '{"json":{"at":1790769600821,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqw-qt4k0', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqw-qt4k0', '{"json":"00000000-0000-4000-8000-000000000031"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqw-qt4k0', '{"json":{"at":1790769600830,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zert-y3d64', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zeqz-1rd4y', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zeqz-1rd4y', '{"json":"00000000-0000-4000-8000-000000000032"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zeqz-1rd4y', '{"json":{"at":1790769600839,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zerh-e06uf', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zer2-crf1f', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zer2-crf1f', '{"json":"00000000-0000-4000-8000-000000000033"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zer2-crf1f', '{"json":{"at":1790769600848,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zerh-e06uf', '{"json":"00000000-0000-4000-8000-000000000038"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zer5-tk6x3', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zer5-tk6x3', '{"json":"00000000-0000-4000-8000-000000000034"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zer5-tk6x3', '{"json":{"at":1790769600857,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zerh-e06uf', '{"json":{"at":1790769600893,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zer8-zaisz', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zer8-zaisz', '{"json":"00000000-0000-4000-8000-000000000035"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zer8-zaisz', '{"json":{"at":1790769600866,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zert-y3d64', '{"json":"00000000-0000-4000-8000-00000000003c"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zerk-9l2dc', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zerk-9l2dc', '{"json":"00000000-0000-4000-8000-000000000039"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zerk-9l2dc', '{"json":{"at":1790769600902,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zert-y3d64', '{"json":{"at":1790769600929,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zern-mqmm9', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zern-mqmm9', '{"json":"00000000-0000-4000-8000-00000000003a"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zern-mqmm9', '{"json":{"at":1790769600911,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zerq-1kq38', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zerq-1kq38', '{"json":"00000000-0000-4000-8000-00000000003b"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zerq-1kq38', '{"json":{"at":1790769600920,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zerz-5j3x8', '{"json":{"at":1790769600947,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zerw-czk0d', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zerw-czk0d', '{"json":"00000000-0000-4000-8000-00000000003d"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zerw-czk0d', '{"json":{"at":1790769600938,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zes2-ltox5', '{"json":"00000000-0000-4000-8000-00000000003f"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zerz-5j3x8', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qcursor', '{"json":"w1:50:1790769600147:qjob-muo1zes2-ltox5"}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zes2-ltox5', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zes2-ltox5', '{"json":{"at":1790769600956,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zes5-oabfq', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zes5-oabfq', '{"json":"00000000-0000-4000-8000-000000000040"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zes5-oabfq', '{"json":{"at":1790769600965,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zes8-meot5', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zes8-meot5', '{"json":"00000000-0000-4000-8000-000000000041"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zes8-meot5', '{"json":{"at":1790769600974,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zesb-6h1mj', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zesb-6h1mj', '{"json":"00000000-0000-4000-8000-000000000042"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zesb-6h1mj', '{"json":{"at":1790769600983,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zese-tnifs', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zese-tnifs', '{"json":"00000000-0000-4000-8000-000000000043"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zese-tnifs', '{"json":{"at":1790769600992,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zesh-ie9cz', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zesh-ie9cz', '{"json":"00000000-0000-4000-8000-000000000044"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zesh-ie9cz', '{"json":{"at":1790769601001,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zesk-5yv68', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zesk-5yv68', '{"json":"00000000-0000-4000-8000-000000000045"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zesk-5yv68', '{"json":{"at":1790769601010,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zesn-h6r95', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zesn-h6r95', '{"json":"00000000-0000-4000-8000-000000000046"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zesn-h6r95', '{"json":{"at":1790769601019,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zesq-zu9le', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zesq-zu9le', '{"json":"00000000-0000-4000-8000-000000000047"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zesq-zu9le', '{"json":{"at":1790769601028,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zest-8pz16', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zest-8pz16', '{"json":"00000000-0000-4000-8000-000000000048"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zest-8pz16', '{"json":{"at":1790769601037,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qtry:qjob-muo1zesw-502o7', '{"json":{"attempts":1,"notBefore":0}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:qjob-muo1zesw-502o7', '{"json":"00000000-0000-4000-8000-000000000049"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:qjob-muo1zesw-502o7', '{"json":{"at":1790769601046,"ok":true}}');

INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeo0-cx4dc', '{"json":{"type":"t"}}', 1790769600002, 0, 2);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeo3-3t90t', '{"json":{"type":"t"}}', 1790769600005, 0, 4);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"type":"t"}}', 1790769600007, 0, 6);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeo8-ob6co', '{"json":{"type":"t"}}', 1790769600010, 0, 8);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeob-x1n5k', '{"json":{"type":"t"}}', 1790769600013, 0, 10);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeoe-3nn6l', '{"json":{"type":"t"}}', 1790769600016, 0, 12);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeoh-au3lb', '{"json":{"type":"t"}}', 1790769600019, 0, 14);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeok-0wdy7', '{"json":{"type":"t"}}', 1790769600022, 0, 16);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeon-gsfn4', '{"json":{"type":"t"}}', 1790769600025, 0, 18);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeoq-flbxl', '{"json":{"type":"t"}}', 1790769600028, 0, 20);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeot-jpjoy', '{"json":{"type":"t"}}', 1790769600031, 0, 22);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeow-iclf6', '{"json":{"type":"t"}}', 1790769600034, 0, 24);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeoz-b20ak', '{"json":{"type":"t"}}', 1790769600037, 0, 26);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zep2-wcazd', '{"json":{"type":"t"}}', 1790769600040, 0, 28);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zep5-c7yw5', '{"json":{"type":"t"}}', 1790769600043, 0, 30);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zep8-3omq7', '{"json":{"type":"t"}}', 1790769600046, 0, 32);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zepb-8xhqz', '{"json":{"type":"t"}}', 1790769600049, 0, 34);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zepe-9f7ve', '{"json":{"type":"t"}}', 1790769600052, 0, 36);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeph-uletq', '{"json":{"type":"t"}}', 1790769600055, 0, 38);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zepk-6wpjm', '{"json":{"type":"t"}}', 1790769600058, 0, 40);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zepn-nuxoy', '{"json":{"type":"t"}}', 1790769600061, 0, 42);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zepq-ygau7', '{"json":{"type":"t"}}', 1790769600064, 0, 44);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zept-rbgjk', '{"json":{"type":"t"}}', 1790769600067, 0, 46);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zepw-t976a', '{"json":{"type":"t"}}', 1790769600070, 0, 48);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zepz-wcwtf', '{"json":{"type":"t"}}', 1790769600073, 0, 50);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeq2-w0wln', '{"json":{"type":"t"}}', 1790769600076, 0, 52);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeq5-j2ir4', '{"json":{"type":"t"}}', 1790769600079, 0, 54);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeq8-931ny', '{"json":{"type":"t"}}', 1790769600082, 0, 56);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqb-bkvz7', '{"json":{"type":"t"}}', 1790769600085, 0, 58);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqe-zbyxf', '{"json":{"type":"t"}}', 1790769600088, 0, 60);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqh-nihlz', '{"json":{"type":"t"}}', 1790769600091, 0, 62);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqk-ul3xm', '{"json":{"type":"t"}}', 1790769600094, 0, 64);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqn-qx9rk', '{"json":{"type":"t"}}', 1790769600097, 0, 66);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqq-hpp5f', '{"json":{"type":"t"}}', 1790769600100, 0, 68);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqt-5g6g2', '{"json":{"type":"t"}}', 1790769600103, 0, 70);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqw-qt4k0', '{"json":{"type":"t"}}', 1790769600106, 0, 72);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeqz-1rd4y', '{"json":{"type":"t"}}', 1790769600109, 0, 74);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zer2-crf1f', '{"json":{"type":"t"}}', 1790769600112, 0, 76);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zer5-tk6x3', '{"json":{"type":"t"}}', 1790769600115, 0, 78);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zer8-zaisz', '{"json":{"type":"t"}}', 1790769600118, 0, 80);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zerb-tiogq', '{"json":{"type":"t"}}', 1790769600121, 0, 82);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zere-2lavf', '{"json":{"type":"t"}}', 1790769600124, 0, 84);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zerh-e06uf', '{"json":{"type":"t"}}', 1790769600127, 0, 86);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zerk-9l2dc', '{"json":{"type":"t"}}', 1790769600130, 0, 88);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zern-mqmm9', '{"json":{"type":"t"}}', 1790769600133, 0, 90);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zerq-1kq38', '{"json":{"type":"t"}}', 1790769600136, 0, 92);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zert-y3d64', '{"json":{"type":"t"}}', 1790769600139, 0, 94);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zerw-czk0d', '{"json":{"type":"t"}}', 1790769600142, 0, 96);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zerz-5j3x8', '{"json":{"type":"t"}}', 1790769600145, 0, 98);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zes2-ltox5', '{"json":{"type":"t"}}', 1790769600148, 0, 100);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zes5-oabfq', '{"json":{"type":"t"}}', 1790769600151, 0, 102);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zes8-meot5', '{"json":{"type":"t"}}', 1790769600154, 0, 104);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zesb-6h1mj', '{"json":{"type":"t"}}', 1790769600157, 0, 106);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zese-tnifs', '{"json":{"type":"t"}}', 1790769600160, 0, 108);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zesh-ie9cz', '{"json":{"type":"t"}}', 1790769600163, 0, 110);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zesk-5yv68', '{"json":{"type":"t"}}', 1790769600166, 0, 112);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zesn-h6r95', '{"json":{"type":"t"}}', 1790769600169, 0, 114);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zesq-zu9le', '{"json":{"type":"t"}}', 1790769600172, 0, 116);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zest-8pz16', '{"json":{"type":"t"}}', 1790769600175, 0, 118);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zesw-502o7', '{"json":{"type":"t"}}', 1790769600178, 0, 120);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zesz-z9gu9', '{"json":{"type":"t"}}', 1790769600181, 0, 122);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zet2-u849l', '{"json":{"type":"t"}}', 1790769600184, 0, 124);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zet5-z3i0p', '{"json":{"type":"t"}}', 1790769600187, 0, 126);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zet8-7964a', '{"json":{"type":"t"}}', 1790769600190, 0, 128);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zetb-gdfae', '{"json":{"type":"t"}}', 1790769600193, 0, 130);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zete-4k9cd', '{"json":{"type":"t"}}', 1790769600196, 0, 132);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeth-l4v91', '{"json":{"type":"t"}}', 1790769600199, 0, 134);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zetk-xbca4', '{"json":{"type":"t"}}', 1790769600202, 0, 136);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zetn-5q1hz', '{"json":{"type":"t"}}', 1790769600205, 0, 138);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zetq-7lu98', '{"json":{"type":"t"}}', 1790769600208, 0, 140);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zett-7j7x8', '{"json":{"type":"t"}}', 1790769600211, 0, 142);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zetw-xad50', '{"json":{"type":"t"}}', 1790769600214, 0, 144);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zetz-hovml', '{"json":{"type":"t"}}', 1790769600217, 0, 146);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeu2-tzyii', '{"json":{"type":"t"}}', 1790769600220, 0, 148);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeu5-2oh2v', '{"json":{"type":"t"}}', 1790769600223, 0, 150);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeu8-62gjy', '{"json":{"type":"t"}}', 1790769600226, 0, 152);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeub-7szyf', '{"json":{"type":"t"}}', 1790769600229, 0, 154);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeue-eqm1i', '{"json":{"type":"t"}}', 1790769600232, 0, 156);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeuh-3z88t', '{"json":{"type":"t"}}', 1790769600235, 0, 158);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeuk-c4kpt', '{"json":{"type":"t"}}', 1790769600238, 0, 160);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeun-egeoi', '{"json":{"type":"t"}}', 1790769600241, 0, 162);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeuq-hczgf', '{"json":{"type":"t"}}', 1790769600244, 0, 164);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeut-cp4gh', '{"json":{"type":"t"}}', 1790769600247, 0, 166);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeuw-m4818', '{"json":{"type":"t"}}', 1790769600250, 0, 168);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeuz-02z77', '{"json":{"type":"t"}}', 1790769600253, 0, 170);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zev2-3hu3p', '{"json":{"type":"t"}}', 1790769600256, 0, 172);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zev5-nbvfy', '{"json":{"type":"t"}}', 1790769600259, 0, 174);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zev8-rwkmz', '{"json":{"type":"t"}}', 1790769600262, 0, 176);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevb-vrikf', '{"json":{"type":"t"}}', 1790769600265, 0, 178);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeve-ha7kq', '{"json":{"type":"t"}}', 1790769600268, 0, 180);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevh-9185n', '{"json":{"type":"t"}}', 1790769600271, 0, 182);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevk-d93fp', '{"json":{"type":"t"}}', 1790769600274, 0, 184);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevn-o8bdq', '{"json":{"type":"t"}}', 1790769600277, 0, 186);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevq-lh0wf', '{"json":{"type":"t"}}', 1790769600280, 0, 188);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevt-wrps3', '{"json":{"type":"t"}}', 1790769600283, 0, 190);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevw-pjbmo', '{"json":{"type":"t"}}', 1790769600286, 0, 192);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zevz-shoku', '{"json":{"type":"t"}}', 1790769600289, 0, 194);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zew2-82zem', '{"json":{"type":"t"}}', 1790769600292, 0, 196);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zew5-ecjci', '{"json":{"type":"t"}}', 1790769600295, 0, 198);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zew8-8jft4', '{"json":{"type":"t"}}', 1790769600298, 0, 200);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewb-tntlr', '{"json":{"type":"t"}}', 1790769600301, 0, 202);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewe-sb0m2', '{"json":{"type":"t"}}', 1790769600304, 0, 204);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewh-c3k50', '{"json":{"type":"t"}}', 1790769600307, 0, 206);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewk-a94st', '{"json":{"type":"t"}}', 1790769600310, 0, 208);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewn-qbuah', '{"json":{"type":"t"}}', 1790769600313, 0, 210);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewq-jd468', '{"json":{"type":"t"}}', 1790769600316, 0, 212);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewt-tvrdd', '{"json":{"type":"t"}}', 1790769600319, 0, 214);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeww-hubyr', '{"json":{"type":"t"}}', 1790769600322, 0, 216);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zewz-h80jo', '{"json":{"type":"t"}}', 1790769600325, 0, 218);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zex2-3mwz4', '{"json":{"type":"t"}}', 1790769600328, 0, 220);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zex5-kvb0q', '{"json":{"type":"t"}}', 1790769600331, 0, 222);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zex8-284ud', '{"json":{"type":"t"}}', 1790769600334, 0, 224);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexb-dhpg9', '{"json":{"type":"t"}}', 1790769600337, 0, 226);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexe-0kai7', '{"json":{"type":"t"}}', 1790769600340, 0, 228);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexh-190v2', '{"json":{"type":"t"}}', 1790769600343, 0, 230);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexk-h9qwu', '{"json":{"type":"t"}}', 1790769600346, 0, 232);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexn-wzcd9', '{"json":{"type":"t"}}', 1790769600349, 0, 234);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexq-ir86q', '{"json":{"type":"t"}}', 1790769600352, 0, 236);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zext-wsov7', '{"json":{"type":"t"}}', 1790769600355, 0, 238);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexw-6kazh', '{"json":{"type":"t"}}', 1790769600358, 0, 240);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zexz-kdigl', '{"json":{"type":"t"}}', 1790769600361, 0, 242);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zey2-p26d0', '{"json":{"type":"t"}}', 1790769600364, 0, 244);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zey5-9wkgk', '{"json":{"type":"t"}}', 1790769600367, 0, 246);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zey8-lk5zg', '{"json":{"type":"t"}}', 1790769600370, 0, 248);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyb-4i8g0', '{"json":{"type":"t"}}', 1790769600373, 0, 250);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeye-msary', '{"json":{"type":"t"}}', 1790769600376, 0, 252);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyh-andz9', '{"json":{"type":"t"}}', 1790769600379, 0, 254);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyk-3wn24', '{"json":{"type":"t"}}', 1790769600382, 0, 256);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyn-f1krl', '{"json":{"type":"t"}}', 1790769600385, 0, 258);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyq-g2l6p', '{"json":{"type":"t"}}', 1790769600388, 0, 260);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyt-pljq3', '{"json":{"type":"t"}}', 1790769600391, 0, 262);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyw-2h79c', '{"json":{"type":"t"}}', 1790769600394, 0, 264);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeyz-e0o86', '{"json":{"type":"t"}}', 1790769600397, 0, 266);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zez2-rtejy', '{"json":{"type":"t"}}', 1790769600400, 0, 268);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zez5-04rs8', '{"json":{"type":"t"}}', 1790769600403, 0, 270);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zez8-m6slb', '{"json":{"type":"t"}}', 1790769600406, 0, 272);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezb-xtqpl', '{"json":{"type":"t"}}', 1790769600409, 0, 274);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zeze-4e0lp', '{"json":{"type":"t"}}', 1790769600412, 0, 276);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezh-s60js', '{"json":{"type":"t"}}', 1790769600415, 0, 278);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezk-81psj', '{"json":{"type":"t"}}', 1790769600418, 0, 280);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezn-s9zgk', '{"json":{"type":"t"}}', 1790769600421, 0, 282);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezq-tb7nw', '{"json":{"type":"t"}}', 1790769600424, 0, 284);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezt-531l2', '{"json":{"type":"t"}}', 1790769600427, 0, 286);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezw-zhlp6', '{"json":{"type":"t"}}', 1790769600430, 0, 288);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zezz-akkmi', '{"json":{"type":"t"}}', 1790769600433, 0, 290);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf02-em50x', '{"json":{"type":"t"}}', 1790769600436, 0, 292);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf05-qps68', '{"json":{"type":"t"}}', 1790769600439, 0, 294);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf08-6g0as', '{"json":{"type":"t"}}', 1790769600442, 0, 296);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0b-xlzsu', '{"json":{"type":"t"}}', 1790769600445, 0, 298);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0e-lmsa0', '{"json":{"type":"t"}}', 1790769600448, 0, 300);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0h-7mxxr', '{"json":{"type":"t"}}', 1790769600451, 0, 302);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0k-0fgcj', '{"json":{"type":"t"}}', 1790769600454, 0, 304);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0n-8nrjg', '{"json":{"type":"t"}}', 1790769600457, 0, 306);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0q-jpykv', '{"json":{"type":"t"}}', 1790769600460, 0, 308);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0t-dvlvf', '{"json":{"type":"t"}}', 1790769600463, 0, 310);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0w-fdaai', '{"json":{"type":"t"}}', 1790769600466, 0, 312);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf0z-lrur4', '{"json":{"type":"t"}}', 1790769600469, 0, 314);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf12-vkufx', '{"json":{"type":"t"}}', 1790769600472, 0, 316);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf15-t7zlt', '{"json":{"type":"t"}}', 1790769600475, 0, 318);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf18-bpicm', '{"json":{"type":"t"}}', 1790769600478, 0, 320);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'qjob-muo1zf1b-cjqmn', '{"json":{"type":"t"}}', 1790769600481, 0, 322);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000002', '{"json":{"type":"t"}}', 1790769600483, 0, 324);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000003', '{"json":{"type":"t"}}', 1790769600485, 0, 326);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000004', '{"json":{"type":"t"}}', 1790769600487, 0, 328);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000005', '{"json":{"type":"t"}}', 1790769600489, 0, 330);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::00000000-0000-4000-8000-000000000006', '{"json":{"type":"t"}}', 1790769600491, 0, 332);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000007', '{"json":{"type":"t"}}', 1790769600493, 0, 334);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000008', '{"json":{"type":"t"}}', 1790769600495, 0, 336);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-000000000009', '{"json":{"type":"t"}}', 1790769600497, 0, 338);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-00000000000a', '{"json":{"type":"t"}}', 1790769600499, 0, 340);
INSERT INTO public.gnl_work_log VALUES ('org:globex:qdepth', '~o~globex::00000000-0000-4000-8000-00000000000b', '{"json":{"type":"t"}}', 1790769600501, 0, 342);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme:ayse:00000000-0000-4000-8000-00000000000c', '{"json":{"type":"t"}}', 1790769600503, 0, 344);
INSERT INTO public.gnl_work_log VALUES ('org:acme:qdepth', '~o~acme::weekly-report', '{"json":{"type":"t"}}', 1790769600505, 0, 346);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeo0-cx4dc', '{"json":{"type":"t","payload":{"n":"s0"}}}', 1790769600001, 1, 1);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeo3-3t90t', '{"json":{"type":"t","payload":{"n":"s1"}}}', 1790769600004, 2, 3);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000001', '{"json":{"type":"t","payload":{"n":"dead","fail":true},"orgId":"globex"}}', 1790769600006, 3, 5);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeo8-ob6co', '{"json":{"type":"t","payload":{"n":"s2"}}}', 1790769600009, 4, 7);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeob-x1n5k', '{"json":{"type":"t","payload":{"n":"s3"}}}', 1790769600012, 5, 9);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeoe-3nn6l', '{"json":{"type":"t","payload":{"n":"s4"}}}', 1790769600015, 6, 11);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeoh-au3lb', '{"json":{"type":"t","payload":{"n":"s5"}}}', 1790769600018, 7, 13);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeok-0wdy7', '{"json":{"type":"t","payload":{"n":"s6"}}}', 1790769600021, 8, 15);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeon-gsfn4', '{"json":{"type":"t","payload":{"n":"s7"}}}', 1790769600024, 9, 17);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeoq-flbxl', '{"json":{"type":"t","payload":{"n":"s8"}}}', 1790769600027, 10, 19);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeot-jpjoy', '{"json":{"type":"t","payload":{"n":"s9"}}}', 1790769600030, 11, 21);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeow-iclf6', '{"json":{"type":"t","payload":{"n":"s10"}}}', 1790769600033, 12, 23);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeoz-b20ak', '{"json":{"type":"t","payload":{"n":"s11"}}}', 1790769600036, 13, 25);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zep2-wcazd', '{"json":{"type":"t","payload":{"n":"s12"}}}', 1790769600039, 14, 27);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zep5-c7yw5', '{"json":{"type":"t","payload":{"n":"s13"}}}', 1790769600042, 15, 29);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zep8-3omq7', '{"json":{"type":"t","payload":{"n":"s14"}}}', 1790769600045, 16, 31);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zepb-8xhqz', '{"json":{"type":"t","payload":{"n":"s15"}}}', 1790769600048, 17, 33);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zepe-9f7ve', '{"json":{"type":"t","payload":{"n":"s16"}}}', 1790769600051, 18, 35);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeph-uletq', '{"json":{"type":"t","payload":{"n":"s17"}}}', 1790769600054, 19, 37);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zepk-6wpjm', '{"json":{"type":"t","payload":{"n":"s18"}}}', 1790769600057, 20, 39);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zepn-nuxoy', '{"json":{"type":"t","payload":{"n":"s19"}}}', 1790769600060, 21, 41);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zepq-ygau7', '{"json":{"type":"t","payload":{"n":"s20"}}}', 1790769600063, 22, 43);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zept-rbgjk', '{"json":{"type":"t","payload":{"n":"s21"}}}', 1790769600066, 23, 45);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zepw-t976a', '{"json":{"type":"t","payload":{"n":"s22"}}}', 1790769600069, 24, 47);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zepz-wcwtf', '{"json":{"type":"t","payload":{"n":"s23"}}}', 1790769600072, 25, 49);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeq2-w0wln', '{"json":{"type":"t","payload":{"n":"s24"}}}', 1790769600075, 26, 51);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeq5-j2ir4', '{"json":{"type":"t","payload":{"n":"s25"}}}', 1790769600078, 27, 53);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeq8-931ny', '{"json":{"type":"t","payload":{"n":"s26"}}}', 1790769600081, 28, 55);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqb-bkvz7', '{"json":{"type":"t","payload":{"n":"s27"}}}', 1790769600084, 29, 57);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqe-zbyxf', '{"json":{"type":"t","payload":{"n":"s28"}}}', 1790769600087, 30, 59);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqh-nihlz', '{"json":{"type":"t","payload":{"n":"s29"}}}', 1790769600090, 31, 61);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqk-ul3xm', '{"json":{"type":"t","payload":{"n":"s30"}}}', 1790769600093, 32, 63);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqn-qx9rk', '{"json":{"type":"t","payload":{"n":"s31"}}}', 1790769600096, 33, 65);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqq-hpp5f', '{"json":{"type":"t","payload":{"n":"s32"}}}', 1790769600099, 34, 67);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqt-5g6g2', '{"json":{"type":"t","payload":{"n":"s33"}}}', 1790769600102, 35, 69);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqw-qt4k0', '{"json":{"type":"t","payload":{"n":"s34"}}}', 1790769600105, 36, 71);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeqz-1rd4y', '{"json":{"type":"t","payload":{"n":"s35"}}}', 1790769600108, 37, 73);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zer2-crf1f', '{"json":{"type":"t","payload":{"n":"s36"}}}', 1790769600111, 38, 75);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zer5-tk6x3', '{"json":{"type":"t","payload":{"n":"s37"}}}', 1790769600114, 39, 77);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zer8-zaisz', '{"json":{"type":"t","payload":{"n":"s38"}}}', 1790769600117, 40, 79);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zerb-tiogq', '{"json":{"type":"t","payload":{"n":"s39"}}}', 1790769600120, 41, 81);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zere-2lavf', '{"json":{"type":"t","payload":{"n":"s40"}}}', 1790769600123, 42, 83);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zerh-e06uf', '{"json":{"type":"t","payload":{"n":"s41"}}}', 1790769600126, 43, 85);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zerk-9l2dc', '{"json":{"type":"t","payload":{"n":"s42"}}}', 1790769600129, 44, 87);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zern-mqmm9', '{"json":{"type":"t","payload":{"n":"s43"}}}', 1790769600132, 45, 89);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zerq-1kq38', '{"json":{"type":"t","payload":{"n":"s44"}}}', 1790769600135, 46, 91);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zert-y3d64', '{"json":{"type":"t","payload":{"n":"s45"}}}', 1790769600138, 47, 93);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zerw-czk0d', '{"json":{"type":"t","payload":{"n":"s46"}}}', 1790769600141, 48, 95);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zerz-5j3x8', '{"json":{"type":"t","payload":{"n":"s47"}}}', 1790769600144, 49, 97);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zes2-ltox5', '{"json":{"type":"t","payload":{"n":"s48"}}}', 1790769600147, 50, 99);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zes5-oabfq', '{"json":{"type":"t","payload":{"n":"s49"}}}', 1790769600150, 51, 101);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zes8-meot5', '{"json":{"type":"t","payload":{"n":"s50"}}}', 1790769600153, 52, 103);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zesb-6h1mj', '{"json":{"type":"t","payload":{"n":"s51"}}}', 1790769600156, 53, 105);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zese-tnifs', '{"json":{"type":"t","payload":{"n":"s52"}}}', 1790769600159, 54, 107);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zesh-ie9cz', '{"json":{"type":"t","payload":{"n":"s53"}}}', 1790769600162, 55, 109);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zesk-5yv68', '{"json":{"type":"t","payload":{"n":"s54"}}}', 1790769600165, 56, 111);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zesn-h6r95', '{"json":{"type":"t","payload":{"n":"s55"}}}', 1790769600168, 57, 113);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zesq-zu9le', '{"json":{"type":"t","payload":{"n":"s56"}}}', 1790769600171, 58, 115);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zest-8pz16', '{"json":{"type":"t","payload":{"n":"s57"}}}', 1790769600174, 59, 117);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zesw-502o7', '{"json":{"type":"t","payload":{"n":"s58"}}}', 1790769600177, 60, 119);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zesz-z9gu9', '{"json":{"type":"t","payload":{"n":"s59"}}}', 1790769600180, 61, 121);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zet2-u849l', '{"json":{"type":"t","payload":{"n":"s60"}}}', 1790769600183, 62, 123);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zet5-z3i0p', '{"json":{"type":"t","payload":{"n":"s61"}}}', 1790769600186, 63, 125);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zet8-7964a', '{"json":{"type":"t","payload":{"n":"s62"}}}', 1790769600189, 64, 127);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zetb-gdfae', '{"json":{"type":"t","payload":{"n":"s63"}}}', 1790769600192, 65, 129);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zete-4k9cd', '{"json":{"type":"t","payload":{"n":"s64"}}}', 1790769600195, 66, 131);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeth-l4v91', '{"json":{"type":"t","payload":{"n":"s65"}}}', 1790769600198, 67, 133);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zetk-xbca4', '{"json":{"type":"t","payload":{"n":"s66"}}}', 1790769600201, 68, 135);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zetn-5q1hz', '{"json":{"type":"t","payload":{"n":"s67"}}}', 1790769600204, 69, 137);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zetq-7lu98', '{"json":{"type":"t","payload":{"n":"s68"}}}', 1790769600207, 70, 139);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zett-7j7x8', '{"json":{"type":"t","payload":{"n":"s69"}}}', 1790769600210, 71, 141);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zetw-xad50', '{"json":{"type":"t","payload":{"n":"s70"}}}', 1790769600213, 72, 143);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zetz-hovml', '{"json":{"type":"t","payload":{"n":"s71"}}}', 1790769600216, 73, 145);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeu2-tzyii', '{"json":{"type":"t","payload":{"n":"s72"}}}', 1790769600219, 74, 147);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeu5-2oh2v', '{"json":{"type":"t","payload":{"n":"s73"}}}', 1790769600222, 75, 149);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeu8-62gjy', '{"json":{"type":"t","payload":{"n":"s74"}}}', 1790769600225, 76, 151);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeub-7szyf', '{"json":{"type":"t","payload":{"n":"s75"}}}', 1790769600228, 77, 153);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeue-eqm1i', '{"json":{"type":"t","payload":{"n":"s76"}}}', 1790769600231, 78, 155);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeuh-3z88t', '{"json":{"type":"t","payload":{"n":"s77"}}}', 1790769600234, 79, 157);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeuk-c4kpt', '{"json":{"type":"t","payload":{"n":"s78"}}}', 1790769600237, 80, 159);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeun-egeoi', '{"json":{"type":"t","payload":{"n":"s79"}}}', 1790769600240, 81, 161);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeuq-hczgf', '{"json":{"type":"t","payload":{"n":"s80"}}}', 1790769600243, 82, 163);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeut-cp4gh', '{"json":{"type":"t","payload":{"n":"s81"}}}', 1790769600246, 83, 165);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeuw-m4818', '{"json":{"type":"t","payload":{"n":"s82"}}}', 1790769600249, 84, 167);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeuz-02z77', '{"json":{"type":"t","payload":{"n":"s83"}}}', 1790769600252, 85, 169);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zev2-3hu3p', '{"json":{"type":"t","payload":{"n":"s84"}}}', 1790769600255, 86, 171);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zev5-nbvfy', '{"json":{"type":"t","payload":{"n":"s85"}}}', 1790769600258, 87, 173);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zev8-rwkmz', '{"json":{"type":"t","payload":{"n":"s86"}}}', 1790769600261, 88, 175);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevb-vrikf', '{"json":{"type":"t","payload":{"n":"s87"}}}', 1790769600264, 89, 177);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeve-ha7kq', '{"json":{"type":"t","payload":{"n":"s88"}}}', 1790769600267, 90, 179);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevh-9185n', '{"json":{"type":"t","payload":{"n":"s89"}}}', 1790769600270, 91, 181);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevk-d93fp', '{"json":{"type":"t","payload":{"n":"s90"}}}', 1790769600273, 92, 183);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevn-o8bdq', '{"json":{"type":"t","payload":{"n":"s91"}}}', 1790769600276, 93, 185);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevq-lh0wf', '{"json":{"type":"t","payload":{"n":"s92"}}}', 1790769600279, 94, 187);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevt-wrps3', '{"json":{"type":"t","payload":{"n":"s93"}}}', 1790769600282, 95, 189);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevw-pjbmo', '{"json":{"type":"t","payload":{"n":"s94"}}}', 1790769600285, 96, 191);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zevz-shoku', '{"json":{"type":"t","payload":{"n":"s95"}}}', 1790769600288, 97, 193);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zew2-82zem', '{"json":{"type":"t","payload":{"n":"s96"}}}', 1790769600291, 98, 195);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zew5-ecjci', '{"json":{"type":"t","payload":{"n":"s97"}}}', 1790769600294, 99, 197);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zew8-8jft4', '{"json":{"type":"t","payload":{"n":"s98"}}}', 1790769600297, 100, 199);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewb-tntlr', '{"json":{"type":"t","payload":{"n":"s99"}}}', 1790769600300, 101, 201);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewe-sb0m2', '{"json":{"type":"t","payload":{"n":"s100"}}}', 1790769600303, 102, 203);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewh-c3k50', '{"json":{"type":"t","payload":{"n":"s101"}}}', 1790769600306, 103, 205);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewk-a94st', '{"json":{"type":"t","payload":{"n":"s102"}}}', 1790769600309, 104, 207);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewn-qbuah', '{"json":{"type":"t","payload":{"n":"s103"}}}', 1790769600312, 105, 209);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewq-jd468', '{"json":{"type":"t","payload":{"n":"s104"}}}', 1790769600315, 106, 211);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewt-tvrdd', '{"json":{"type":"t","payload":{"n":"s105"}}}', 1790769600318, 107, 213);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeww-hubyr', '{"json":{"type":"t","payload":{"n":"s106"}}}', 1790769600321, 108, 215);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zewz-h80jo', '{"json":{"type":"t","payload":{"n":"s107"}}}', 1790769600324, 109, 217);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zex2-3mwz4', '{"json":{"type":"t","payload":{"n":"s108"}}}', 1790769600327, 110, 219);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zex5-kvb0q', '{"json":{"type":"t","payload":{"n":"s109"}}}', 1790769600330, 111, 221);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zex8-284ud', '{"json":{"type":"t","payload":{"n":"s110"}}}', 1790769600333, 112, 223);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexb-dhpg9', '{"json":{"type":"t","payload":{"n":"s111"}}}', 1790769600336, 113, 225);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexe-0kai7', '{"json":{"type":"t","payload":{"n":"s112"}}}', 1790769600339, 114, 227);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexh-190v2', '{"json":{"type":"t","payload":{"n":"s113"}}}', 1790769600342, 115, 229);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexk-h9qwu', '{"json":{"type":"t","payload":{"n":"s114"}}}', 1790769600345, 116, 231);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexn-wzcd9', '{"json":{"type":"t","payload":{"n":"s115"}}}', 1790769600348, 117, 233);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexq-ir86q', '{"json":{"type":"t","payload":{"n":"s116"}}}', 1790769600351, 118, 235);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zext-wsov7', '{"json":{"type":"t","payload":{"n":"s117"}}}', 1790769600354, 119, 237);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexw-6kazh', '{"json":{"type":"t","payload":{"n":"s118"}}}', 1790769600357, 120, 239);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zexz-kdigl', '{"json":{"type":"t","payload":{"n":"s119"}}}', 1790769600360, 121, 241);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zey2-p26d0', '{"json":{"type":"t","payload":{"n":"s120"}}}', 1790769600363, 122, 243);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zey5-9wkgk', '{"json":{"type":"t","payload":{"n":"s121"}}}', 1790769600366, 123, 245);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zey8-lk5zg', '{"json":{"type":"t","payload":{"n":"s122"}}}', 1790769600369, 124, 247);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyb-4i8g0', '{"json":{"type":"t","payload":{"n":"s123"}}}', 1790769600372, 125, 249);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeye-msary', '{"json":{"type":"t","payload":{"n":"s124"}}}', 1790769600375, 126, 251);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyh-andz9', '{"json":{"type":"t","payload":{"n":"s125"}}}', 1790769600378, 127, 253);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyk-3wn24', '{"json":{"type":"t","payload":{"n":"s126"}}}', 1790769600381, 128, 255);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyn-f1krl', '{"json":{"type":"t","payload":{"n":"s127"}}}', 1790769600384, 129, 257);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyq-g2l6p', '{"json":{"type":"t","payload":{"n":"s128"}}}', 1790769600387, 130, 259);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyt-pljq3', '{"json":{"type":"t","payload":{"n":"s129"}}}', 1790769600390, 131, 261);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyw-2h79c', '{"json":{"type":"t","payload":{"n":"s130"}}}', 1790769600393, 132, 263);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeyz-e0o86', '{"json":{"type":"t","payload":{"n":"s131"}}}', 1790769600396, 133, 265);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zez2-rtejy', '{"json":{"type":"t","payload":{"n":"s132"}}}', 1790769600399, 134, 267);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zez5-04rs8', '{"json":{"type":"t","payload":{"n":"s133"}}}', 1790769600402, 135, 269);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zez8-m6slb', '{"json":{"type":"t","payload":{"n":"s134"}}}', 1790769600405, 136, 271);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezb-xtqpl', '{"json":{"type":"t","payload":{"n":"s135"}}}', 1790769600408, 137, 273);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zeze-4e0lp', '{"json":{"type":"t","payload":{"n":"s136"}}}', 1790769600411, 138, 275);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezh-s60js', '{"json":{"type":"t","payload":{"n":"s137"}}}', 1790769600414, 139, 277);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezk-81psj', '{"json":{"type":"t","payload":{"n":"s138"}}}', 1790769600417, 140, 279);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezn-s9zgk', '{"json":{"type":"t","payload":{"n":"s139"}}}', 1790769600420, 141, 281);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezq-tb7nw', '{"json":{"type":"t","payload":{"n":"s140"}}}', 1790769600423, 142, 283);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezt-531l2', '{"json":{"type":"t","payload":{"n":"s141"}}}', 1790769600426, 143, 285);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezw-zhlp6', '{"json":{"type":"t","payload":{"n":"s142"}}}', 1790769600429, 144, 287);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zezz-akkmi', '{"json":{"type":"t","payload":{"n":"s143"}}}', 1790769600432, 145, 289);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf02-em50x', '{"json":{"type":"t","payload":{"n":"s144"}}}', 1790769600435, 146, 291);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf05-qps68', '{"json":{"type":"t","payload":{"n":"s145"}}}', 1790769600438, 147, 293);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf08-6g0as', '{"json":{"type":"t","payload":{"n":"s146"}}}', 1790769600441, 148, 295);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0b-xlzsu', '{"json":{"type":"t","payload":{"n":"s147"}}}', 1790769600444, 149, 297);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0e-lmsa0', '{"json":{"type":"t","payload":{"n":"s148"}}}', 1790769600447, 150, 299);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0h-7mxxr', '{"json":{"type":"t","payload":{"n":"s149"}}}', 1790769600450, 151, 301);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0k-0fgcj', '{"json":{"type":"t","payload":{"n":"s150"}}}', 1790769600453, 152, 303);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0n-8nrjg', '{"json":{"type":"t","payload":{"n":"s151"}}}', 1790769600456, 153, 305);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0q-jpykv', '{"json":{"type":"t","payload":{"n":"s152"}}}', 1790769600459, 154, 307);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0t-dvlvf', '{"json":{"type":"t","payload":{"n":"s153"}}}', 1790769600462, 155, 309);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0w-fdaai', '{"json":{"type":"t","payload":{"n":"s154"}}}', 1790769600465, 156, 311);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf0z-lrur4', '{"json":{"type":"t","payload":{"n":"s155"}}}', 1790769600468, 157, 313);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf12-vkufx', '{"json":{"type":"t","payload":{"n":"s156"}}}', 1790769600471, 158, 315);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf15-t7zlt', '{"json":{"type":"t","payload":{"n":"s157"}}}', 1790769600474, 159, 317);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf18-bpicm', '{"json":{"type":"t","payload":{"n":"s158"}}}', 1790769600477, 160, 319);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'qjob-muo1zf1b-cjqmn', '{"json":{"type":"t","payload":{"n":"s159"}}}', 1790769600480, 161, 321);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000002', '{"json":{"type":"t","payload":{"n":"acme0"},"orgId":"acme"}}', 1790769600482, 162, 323);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000003', '{"json":{"type":"t","payload":{"n":"acme1"},"orgId":"acme"}}', 1790769600484, 163, 325);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000004', '{"json":{"type":"t","payload":{"n":"acme2"},"orgId":"acme"}}', 1790769600486, 164, 327);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000005', '{"json":{"type":"t","payload":{"n":"acme3"},"orgId":"acme"}}', 1790769600488, 165, 329);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::00000000-0000-4000-8000-000000000006', '{"json":{"type":"t","payload":{"n":"acme4"},"orgId":"acme"}}', 1790769600490, 166, 331);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000007', '{"json":{"type":"t","payload":{"n":"globex0"},"orgId":"globex"}}', 1790769600492, 167, 333);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000008', '{"json":{"type":"t","payload":{"n":"globex1"},"orgId":"globex"}}', 1790769600494, 168, 335);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-000000000009', '{"json":{"type":"t","payload":{"n":"globex2"},"orgId":"globex"}}', 1790769600496, 169, 337);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-00000000000a', '{"json":{"type":"t","payload":{"n":"globex3"},"orgId":"globex"}}', 1790769600498, 170, 339);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~globex::00000000-0000-4000-8000-00000000000b', '{"json":{"type":"t","payload":{"n":"globex4"},"orgId":"globex"}}', 1790769600500, 171, 341);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme:ayse:00000000-0000-4000-8000-00000000000c', '{"json":{"type":"t","payload":{"n":"ayse0"},"resourceId":"ayse","orgId":"acme"}}', 1790769600502, 172, 343);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~acme::weekly-report', '{"json":{"type":"t","payload":{"n":"fixed"},"orgId":"acme"}}', 1790769600504, 173, 345);

INSERT INTO public.gnl_work_seq VALUES ('qjob', 173);

SELECT pg_catalog.setval('public.gnl_run_journal_ord', 180, true);

SELECT pg_catalog.setval('public.gnl_work_log_ord', 346, true);

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
