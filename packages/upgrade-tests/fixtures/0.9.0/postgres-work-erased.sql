-- Written by packages/upgrade-tests/generate/0.9.0.mjs --backend postgres. Do not edit.
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

CREATE TABLE public.gnl_run_journal (
    key text NOT NULL,
    run_id text,
    kind text,
    suspended boolean DEFAULT false NOT NULL,
    value text NOT NULL,
    created_at bigint NOT NULL
);

CREATE TABLE public.gnl_runs (
    run_id text NOT NULL,
    model_steps integer DEFAULT 0 NOT NULL,
    tool_calls integer DEFAULT 0 NOT NULL,
    suspended boolean DEFAULT false NOT NULL,
    suspended_count integer DEFAULT 0 NOT NULL,
    failed boolean DEFAULT false NOT NULL,
    running boolean DEFAULT false NOT NULL,
    canceled boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
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
    owner text,
    shared boolean
);

CREATE TABLE public.gnl_work_kv (
    key text NOT NULL,
    value text NOT NULL
);

CREATE TABLE public.gnl_work_log (
    ns text NOT NULL,
    id text NOT NULL,
    payload text NOT NULL,
    ts bigint NOT NULL
);

CREATE TABLE public.gnl_working_memory (
    scope_id text NOT NULL,
    data text NOT NULL,
    updated_at bigint NOT NULL
);

INSERT INTO public.gnl_meta VALUES ('schema_version', '1');

INSERT INTO public.gnl_run_journal VALUES ('job:p000:input', NULL, NULL, false, '{"json":{"at":1790769600441,"ownerKind":"unknown","_v":2}}', 1790769600442);
INSERT INTO public.gnl_run_journal VALUES ('job:p000:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000029"}}', 1790769600440);
INSERT INTO public.gnl_run_journal VALUES ('job:p001:input', NULL, NULL, false, '{"json":{"at":1790769600446,"ownerKind":"unknown","_v":2}}', 1790769600447);
INSERT INTO public.gnl_run_journal VALUES ('job:p001:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000002a"}}', 1790769600445);
INSERT INTO public.gnl_run_journal VALUES ('job:p002:input', NULL, NULL, false, '{"json":{"at":1790769600451,"ownerKind":"unknown","_v":2}}', 1790769600452);
INSERT INTO public.gnl_run_journal VALUES ('job:p002:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000002b"}}', 1790769600450);
INSERT INTO public.gnl_run_journal VALUES ('job:p003:input', NULL, NULL, false, '{"json":{"at":1790769600456,"ownerKind":"unknown","_v":2}}', 1790769600457);
INSERT INTO public.gnl_run_journal VALUES ('job:p003:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000002c"}}', 1790769600455);
INSERT INTO public.gnl_run_journal VALUES ('job:p004:input', NULL, NULL, false, '{"json":{"at":1790769600461,"ownerKind":"unknown","_v":2}}', 1790769600462);
INSERT INTO public.gnl_run_journal VALUES ('job:p004:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000002d"}}', 1790769600460);
INSERT INTO public.gnl_run_journal VALUES ('job:p005:input', NULL, NULL, false, '{"json":{"at":1790769600466,"ownerKind":"unknown","_v":2}}', 1790769600467);
INSERT INTO public.gnl_run_journal VALUES ('job:p005:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000002e"}}', 1790769600465);
INSERT INTO public.gnl_run_journal VALUES ('job:p006:input', NULL, NULL, false, '{"json":{"at":1790769600471,"ownerKind":"unknown","_v":2}}', 1790769600472);
INSERT INTO public.gnl_run_journal VALUES ('job:p006:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000002f"}}', 1790769600470);
INSERT INTO public.gnl_run_journal VALUES ('job:p007:input', NULL, NULL, false, '{"json":{"at":1790769600476,"ownerKind":"unknown","_v":2}}', 1790769600477);
INSERT INTO public.gnl_run_journal VALUES ('job:p007:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000030"}}', 1790769600475);
INSERT INTO public.gnl_run_journal VALUES ('job:p008:input', NULL, NULL, false, '{"json":{"at":1790769600481,"ownerKind":"unknown","_v":2}}', 1790769600482);
INSERT INTO public.gnl_run_journal VALUES ('job:p008:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000031"}}', 1790769600480);
INSERT INTO public.gnl_run_journal VALUES ('job:p009:input', NULL, NULL, false, '{"json":{"at":1790769600486,"ownerKind":"unknown","_v":2}}', 1790769600487);
INSERT INTO public.gnl_run_journal VALUES ('job:p009:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000032"}}', 1790769600485);
INSERT INTO public.gnl_run_journal VALUES ('job:p010:input', NULL, NULL, false, '{"json":{"at":1790769600491,"ownerKind":"unknown","_v":2}}', 1790769600492);
INSERT INTO public.gnl_run_journal VALUES ('job:p010:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000033"}}', 1790769600490);
INSERT INTO public.gnl_run_journal VALUES ('job:p011:input', NULL, NULL, false, '{"json":{"at":1790769600496,"ownerKind":"unknown","_v":2}}', 1790769600497);
INSERT INTO public.gnl_run_journal VALUES ('job:p011:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000034"}}', 1790769600495);
INSERT INTO public.gnl_run_journal VALUES ('job:p012:input', NULL, NULL, false, '{"json":{"at":1790769600501,"ownerKind":"unknown","_v":2}}', 1790769600502);
INSERT INTO public.gnl_run_journal VALUES ('job:p012:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000035"}}', 1790769600500);
INSERT INTO public.gnl_run_journal VALUES ('job:p013:input', NULL, NULL, false, '{"json":{"at":1790769600506,"ownerKind":"unknown","_v":2}}', 1790769600507);
INSERT INTO public.gnl_run_journal VALUES ('job:p013:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000036"}}', 1790769600505);
INSERT INTO public.gnl_run_journal VALUES ('job:p014:input', NULL, NULL, false, '{"json":{"at":1790769600511,"ownerKind":"unknown","_v":2}}', 1790769600512);
INSERT INTO public.gnl_run_journal VALUES ('job:p014:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000037"}}', 1790769600510);
INSERT INTO public.gnl_run_journal VALUES ('job:p015:input', NULL, NULL, false, '{"json":{"at":1790769600516,"ownerKind":"unknown","_v":2}}', 1790769600517);
INSERT INTO public.gnl_run_journal VALUES ('job:p015:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000038"}}', 1790769600515);
INSERT INTO public.gnl_run_journal VALUES ('job:p016:input', NULL, NULL, false, '{"json":{"at":1790769600521,"ownerKind":"unknown","_v":2}}', 1790769600522);
INSERT INTO public.gnl_run_journal VALUES ('job:p016:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000039"}}', 1790769600520);
INSERT INTO public.gnl_run_journal VALUES ('job:p017:input', NULL, NULL, false, '{"json":{"at":1790769600526,"ownerKind":"unknown","_v":2}}', 1790769600527);
INSERT INTO public.gnl_run_journal VALUES ('job:p017:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000003a"}}', 1790769600525);
INSERT INTO public.gnl_run_journal VALUES ('job:p018:input', NULL, NULL, false, '{"json":{"at":1790769600531,"ownerKind":"unknown","_v":2}}', 1790769600532);
INSERT INTO public.gnl_run_journal VALUES ('job:p018:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000003b"}}', 1790769600530);
INSERT INTO public.gnl_run_journal VALUES ('job:p019:input', NULL, NULL, false, '{"json":{"at":1790769600536,"ownerKind":"unknown","_v":2}}', 1790769600537);
INSERT INTO public.gnl_run_journal VALUES ('job:p019:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000003c"}}', 1790769600535);
INSERT INTO public.gnl_run_journal VALUES ('job:p020:input', NULL, NULL, false, '{"json":{"at":1790769600541,"ownerKind":"unknown","_v":2}}', 1790769600542);
INSERT INTO public.gnl_run_journal VALUES ('job:p020:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000003d"}}', 1790769600540);
INSERT INTO public.gnl_run_journal VALUES ('job:p021:input', NULL, NULL, false, '{"json":{"at":1790769600546,"ownerKind":"unknown","_v":2}}', 1790769600547);
INSERT INTO public.gnl_run_journal VALUES ('job:p021:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000003e"}}', 1790769600545);
INSERT INTO public.gnl_run_journal VALUES ('job:p022:input', NULL, NULL, false, '{"json":{"at":1790769600551,"ownerKind":"unknown","_v":2}}', 1790769600552);
INSERT INTO public.gnl_run_journal VALUES ('job:p022:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-00000000003f"}}', 1790769600550);
INSERT INTO public.gnl_run_journal VALUES ('job:p023:input', NULL, NULL, false, '{"json":{"at":1790769600556,"ownerKind":"unknown","_v":2}}', 1790769600557);
INSERT INTO public.gnl_run_journal VALUES ('job:p023:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000040"}}', 1790769600555);
INSERT INTO public.gnl_run_journal VALUES ('job:p024:input', NULL, NULL, false, '{"json":{"at":1790769600561,"ownerKind":"unknown","_v":2}}', 1790769600562);
INSERT INTO public.gnl_run_journal VALUES ('job:p024:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000041"}}', 1790769600560);
INSERT INTO public.gnl_run_journal VALUES ('job:p025:input', NULL, NULL, false, '{"json":{"at":1790769600566,"ownerKind":"unknown","_v":2}}', 1790769600567);
INSERT INTO public.gnl_run_journal VALUES ('job:p025:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000042"}}', 1790769600565);
INSERT INTO public.gnl_run_journal VALUES ('job:p026:input', NULL, NULL, false, '{"json":{"at":1790769600571,"ownerKind":"unknown","_v":2}}', 1790769600572);
INSERT INTO public.gnl_run_journal VALUES ('job:p026:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000043"}}', 1790769600570);
INSERT INTO public.gnl_run_journal VALUES ('job:p027:input', NULL, NULL, false, '{"json":{"at":1790769600576,"ownerKind":"unknown","_v":2}}', 1790769600577);
INSERT INTO public.gnl_run_journal VALUES ('job:p027:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000044"}}', 1790769600575);
INSERT INTO public.gnl_run_journal VALUES ('job:p028:input', NULL, NULL, false, '{"json":{"at":1790769600581,"ownerKind":"unknown","_v":2}}', 1790769600582);
INSERT INTO public.gnl_run_journal VALUES ('job:p028:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000045"}}', 1790769600580);
INSERT INTO public.gnl_run_journal VALUES ('job:p029:input', NULL, NULL, false, '{"json":{"at":1790769600586,"ownerKind":"unknown","_v":2}}', 1790769600587);
INSERT INTO public.gnl_run_journal VALUES ('job:p029:lease:lock', NULL, NULL, false, '{"json":{"owner":"w-090","expires":0,"token":"00000000-0000-4000-8000-000000000046"}}', 1790769600585);

INSERT INTO public.gnl_runs VALUES ('job:p000', 0, 0, false, 0, false, false, false, 1790769600443, 1790769600443);
INSERT INTO public.gnl_runs VALUES ('job:p001', 0, 0, false, 0, false, false, false, 1790769600448, 1790769600448);
INSERT INTO public.gnl_runs VALUES ('job:p002', 0, 0, false, 0, false, false, false, 1790769600453, 1790769600453);
INSERT INTO public.gnl_runs VALUES ('job:p003', 0, 0, false, 0, false, false, false, 1790769600458, 1790769600458);
INSERT INTO public.gnl_runs VALUES ('job:p004', 0, 0, false, 0, false, false, false, 1790769600463, 1790769600463);
INSERT INTO public.gnl_runs VALUES ('job:p005', 0, 0, false, 0, false, false, false, 1790769600468, 1790769600468);
INSERT INTO public.gnl_runs VALUES ('job:p006', 0, 0, false, 0, false, false, false, 1790769600473, 1790769600473);
INSERT INTO public.gnl_runs VALUES ('job:p007', 0, 0, false, 0, false, false, false, 1790769600478, 1790769600478);
INSERT INTO public.gnl_runs VALUES ('job:p008', 0, 0, false, 0, false, false, false, 1790769600483, 1790769600483);
INSERT INTO public.gnl_runs VALUES ('job:p009', 0, 0, false, 0, false, false, false, 1790769600488, 1790769600488);
INSERT INTO public.gnl_runs VALUES ('job:p010', 0, 0, false, 0, false, false, false, 1790769600493, 1790769600493);
INSERT INTO public.gnl_runs VALUES ('job:p011', 0, 0, false, 0, false, false, false, 1790769600498, 1790769600498);
INSERT INTO public.gnl_runs VALUES ('job:p012', 0, 0, false, 0, false, false, false, 1790769600503, 1790769600503);
INSERT INTO public.gnl_runs VALUES ('job:p013', 0, 0, false, 0, false, false, false, 1790769600508, 1790769600508);
INSERT INTO public.gnl_runs VALUES ('job:p014', 0, 0, false, 0, false, false, false, 1790769600513, 1790769600513);
INSERT INTO public.gnl_runs VALUES ('job:p015', 0, 0, false, 0, false, false, false, 1790769600518, 1790769600518);
INSERT INTO public.gnl_runs VALUES ('job:p016', 0, 0, false, 0, false, false, false, 1790769600523, 1790769600523);
INSERT INTO public.gnl_runs VALUES ('job:p017', 0, 0, false, 0, false, false, false, 1790769600528, 1790769600528);
INSERT INTO public.gnl_runs VALUES ('job:p018', 0, 0, false, 0, false, false, false, 1790769600533, 1790769600533);
INSERT INTO public.gnl_runs VALUES ('job:p019', 0, 0, false, 0, false, false, false, 1790769600538, 1790769600538);
INSERT INTO public.gnl_runs VALUES ('job:p020', 0, 0, false, 0, false, false, false, 1790769600543, 1790769600543);
INSERT INTO public.gnl_runs VALUES ('job:p021', 0, 0, false, 0, false, false, false, 1790769600548, 1790769600548);
INSERT INTO public.gnl_runs VALUES ('job:p022', 0, 0, false, 0, false, false, false, 1790769600553, 1790769600553);
INSERT INTO public.gnl_runs VALUES ('job:p023', 0, 0, false, 0, false, false, false, 1790769600558, 1790769600558);
INSERT INTO public.gnl_runs VALUES ('job:p024', 0, 0, false, 0, false, false, false, 1790769600563, 1790769600563);
INSERT INTO public.gnl_runs VALUES ('job:p025', 0, 0, false, 0, false, false, false, 1790769600568, 1790769600568);
INSERT INTO public.gnl_runs VALUES ('job:p026', 0, 0, false, 0, false, false, false, 1790769600573, 1790769600573);
INSERT INTO public.gnl_runs VALUES ('job:p027', 0, 0, false, 0, false, false, false, 1790769600578, 1790769600578);
INSERT INTO public.gnl_runs VALUES ('job:p028', 0, 0, false, 0, false, false, false, 1790769600583, 1790769600583);
INSERT INTO public.gnl_runs VALUES ('job:p029', 0, 0, false, 0, false, false, false, 1790769600588, 1790769600588);

INSERT INTO public.gnl_work_kv VALUES ('qown:p000', '{"json":"00000000-0000-4000-8000-000000000029"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p000', '{"json":{"at":1790769600444,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p001', '{"json":"00000000-0000-4000-8000-00000000002a"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p001', '{"json":{"at":1790769600449,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p002', '{"json":"00000000-0000-4000-8000-00000000002b"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p002', '{"json":{"at":1790769600454,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p003', '{"json":"00000000-0000-4000-8000-00000000002c"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p003', '{"json":{"at":1790769600459,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p004', '{"json":"00000000-0000-4000-8000-00000000002d"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p004', '{"json":{"at":1790769600464,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p005', '{"json":"00000000-0000-4000-8000-00000000002e"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p005', '{"json":{"at":1790769600469,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p006', '{"json":"00000000-0000-4000-8000-00000000002f"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p006', '{"json":{"at":1790769600474,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p007', '{"json":"00000000-0000-4000-8000-000000000030"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p007', '{"json":{"at":1790769600479,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p008', '{"json":"00000000-0000-4000-8000-000000000031"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p008', '{"json":{"at":1790769600484,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p009', '{"json":"00000000-0000-4000-8000-000000000032"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p009', '{"json":{"at":1790769600489,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qcursor', '{"json":"50"}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p010', '{"json":"00000000-0000-4000-8000-000000000033"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p010', '{"json":{"at":1790769600494,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p011', '{"json":"00000000-0000-4000-8000-000000000034"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p011', '{"json":{"at":1790769600499,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p012', '{"json":"00000000-0000-4000-8000-000000000035"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p012', '{"json":{"at":1790769600504,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p013', '{"json":"00000000-0000-4000-8000-000000000036"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p013', '{"json":{"at":1790769600509,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p014', '{"json":"00000000-0000-4000-8000-000000000037"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p014', '{"json":{"at":1790769600514,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p015', '{"json":"00000000-0000-4000-8000-000000000038"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p015', '{"json":{"at":1790769600519,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p016', '{"json":"00000000-0000-4000-8000-000000000039"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p016', '{"json":{"at":1790769600524,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p017', '{"json":"00000000-0000-4000-8000-00000000003a"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p017', '{"json":{"at":1790769600529,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p018', '{"json":"00000000-0000-4000-8000-00000000003b"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p018', '{"json":{"at":1790769600534,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p019', '{"json":"00000000-0000-4000-8000-00000000003c"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p019', '{"json":{"at":1790769600539,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p020', '{"json":"00000000-0000-4000-8000-00000000003d"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p020', '{"json":{"at":1790769600544,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p021', '{"json":"00000000-0000-4000-8000-00000000003e"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p021', '{"json":{"at":1790769600549,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p022', '{"json":"00000000-0000-4000-8000-00000000003f"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p022', '{"json":{"at":1790769600554,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p023', '{"json":"00000000-0000-4000-8000-000000000040"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p023', '{"json":{"at":1790769600559,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p024', '{"json":"00000000-0000-4000-8000-000000000041"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p024', '{"json":{"at":1790769600564,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p025', '{"json":"00000000-0000-4000-8000-000000000042"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p025', '{"json":{"at":1790769600569,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p026', '{"json":"00000000-0000-4000-8000-000000000043"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p026', '{"json":{"at":1790769600574,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p027', '{"json":"00000000-0000-4000-8000-000000000044"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p027', '{"json":{"at":1790769600579,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p028', '{"json":"00000000-0000-4000-8000-000000000045"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p028', '{"json":{"at":1790769600584,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('qown:p029', '{"json":"00000000-0000-4000-8000-000000000046"}');
INSERT INTO public.gnl_work_kv VALUES ('qdone:p029', '{"json":{"at":1790769600589,"ok":true}}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e000', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e001', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e002', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e003', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e004', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e005', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e006', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e007', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e008', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e009', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e010', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e011', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e012', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e013', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e014', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e015', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e016', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e017', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e018', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e019', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtcursor:orders:c1', '{"json":"50"}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e020', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e021', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e022', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e023', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e024', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e025', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e026', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e027', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e028', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e029', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e030', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e031', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e032', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e033', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e034', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e035', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e036', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e037', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e038', '{"json":true}');
INSERT INTO public.gnl_work_kv VALUES ('evtack:orders:c1:e039', '{"json":true}');

INSERT INTO public.gnl_work_log VALUES ('qjob', 'p000', '{"json":{"type":"plain","payload":{"n":"p000"}}}', 1790769600080);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p000', '{"json":{"type":"plain"}}', 1790769600081);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p001', '{"json":{"type":"plain","payload":{"n":"p001"}}}', 1790769600082);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p001', '{"json":{"type":"plain"}}', 1790769600083);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p002', '{"json":{"type":"plain","payload":{"n":"p002"}}}', 1790769600084);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p002', '{"json":{"type":"plain"}}', 1790769600085);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p003', '{"json":{"type":"plain","payload":{"n":"p003"}}}', 1790769600086);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p003', '{"json":{"type":"plain"}}', 1790769600087);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p004', '{"json":{"type":"plain","payload":{"n":"p004"}}}', 1790769600088);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p004', '{"json":{"type":"plain"}}', 1790769600089);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p005', '{"json":{"type":"plain","payload":{"n":"p005"}}}', 1790769600090);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p005', '{"json":{"type":"plain"}}', 1790769600091);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p006', '{"json":{"type":"plain","payload":{"n":"p006"}}}', 1790769600092);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p006', '{"json":{"type":"plain"}}', 1790769600093);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p007', '{"json":{"type":"plain","payload":{"n":"p007"}}}', 1790769600094);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p007', '{"json":{"type":"plain"}}', 1790769600095);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p008', '{"json":{"type":"plain","payload":{"n":"p008"}}}', 1790769600096);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p008', '{"json":{"type":"plain"}}', 1790769600097);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p009', '{"json":{"type":"plain","payload":{"n":"p009"}}}', 1790769600098);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p009', '{"json":{"type":"plain"}}', 1790769600099);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p010', '{"json":{"type":"plain","payload":{"n":"p010"}}}', 1790769600100);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p010', '{"json":{"type":"plain"}}', 1790769600101);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p011', '{"json":{"type":"plain","payload":{"n":"p011"}}}', 1790769600102);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p011', '{"json":{"type":"plain"}}', 1790769600103);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p012', '{"json":{"type":"plain","payload":{"n":"p012"}}}', 1790769600104);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p012', '{"json":{"type":"plain"}}', 1790769600105);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p013', '{"json":{"type":"plain","payload":{"n":"p013"}}}', 1790769600106);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p013', '{"json":{"type":"plain"}}', 1790769600107);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p014', '{"json":{"type":"plain","payload":{"n":"p014"}}}', 1790769600108);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p014', '{"json":{"type":"plain"}}', 1790769600109);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p015', '{"json":{"type":"plain","payload":{"n":"p015"}}}', 1790769600110);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p015', '{"json":{"type":"plain"}}', 1790769600111);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p016', '{"json":{"type":"plain","payload":{"n":"p016"}}}', 1790769600112);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p016', '{"json":{"type":"plain"}}', 1790769600113);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p017', '{"json":{"type":"plain","payload":{"n":"p017"}}}', 1790769600114);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p017', '{"json":{"type":"plain"}}', 1790769600115);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p018', '{"json":{"type":"plain","payload":{"n":"p018"}}}', 1790769600116);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p018', '{"json":{"type":"plain"}}', 1790769600117);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p019', '{"json":{"type":"plain","payload":{"n":"p019"}}}', 1790769600118);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p019', '{"json":{"type":"plain"}}', 1790769600119);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p020', '{"json":{"type":"plain","payload":{"n":"p020"}}}', 1790769600120);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p020', '{"json":{"type":"plain"}}', 1790769600121);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p021', '{"json":{"type":"plain","payload":{"n":"p021"}}}', 1790769600122);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p021', '{"json":{"type":"plain"}}', 1790769600123);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p022', '{"json":{"type":"plain","payload":{"n":"p022"}}}', 1790769600124);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p022', '{"json":{"type":"plain"}}', 1790769600125);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p023', '{"json":{"type":"plain","payload":{"n":"p023"}}}', 1790769600126);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p023', '{"json":{"type":"plain"}}', 1790769600127);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p024', '{"json":{"type":"plain","payload":{"n":"p024"}}}', 1790769600128);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p024', '{"json":{"type":"plain"}}', 1790769600129);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p025', '{"json":{"type":"plain","payload":{"n":"p025"}}}', 1790769600130);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p025', '{"json":{"type":"plain"}}', 1790769600131);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p026', '{"json":{"type":"plain","payload":{"n":"p026"}}}', 1790769600132);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p026', '{"json":{"type":"plain"}}', 1790769600133);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p027', '{"json":{"type":"plain","payload":{"n":"p027"}}}', 1790769600134);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p027', '{"json":{"type":"plain"}}', 1790769600135);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p028', '{"json":{"type":"plain","payload":{"n":"p028"}}}', 1790769600136);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p028', '{"json":{"type":"plain"}}', 1790769600137);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p029', '{"json":{"type":"plain","payload":{"n":"p029"}}}', 1790769600138);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p029', '{"json":{"type":"plain"}}', 1790769600139);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p030', '{"json":{"type":"plain","payload":{"n":"p030"}}}', 1790769600140);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p030', '{"json":{"type":"plain"}}', 1790769600141);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p031', '{"json":{"type":"plain","payload":{"n":"p031"}}}', 1790769600142);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p031', '{"json":{"type":"plain"}}', 1790769600143);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p032', '{"json":{"type":"plain","payload":{"n":"p032"}}}', 1790769600144);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p032', '{"json":{"type":"plain"}}', 1790769600145);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p033', '{"json":{"type":"plain","payload":{"n":"p033"}}}', 1790769600146);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p033', '{"json":{"type":"plain"}}', 1790769600147);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p034', '{"json":{"type":"plain","payload":{"n":"p034"}}}', 1790769600148);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p034', '{"json":{"type":"plain"}}', 1790769600149);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p035', '{"json":{"type":"plain","payload":{"n":"p035"}}}', 1790769600150);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p035', '{"json":{"type":"plain"}}', 1790769600151);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p036', '{"json":{"type":"plain","payload":{"n":"p036"}}}', 1790769600152);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p036', '{"json":{"type":"plain"}}', 1790769600153);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p037', '{"json":{"type":"plain","payload":{"n":"p037"}}}', 1790769600154);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p037', '{"json":{"type":"plain"}}', 1790769600155);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p038', '{"json":{"type":"plain","payload":{"n":"p038"}}}', 1790769600156);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p038', '{"json":{"type":"plain"}}', 1790769600157);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p039', '{"json":{"type":"plain","payload":{"n":"p039"}}}', 1790769600158);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p039', '{"json":{"type":"plain"}}', 1790769600159);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p040', '{"json":{"type":"plain","payload":{"n":"p040"}}}', 1790769600160);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p040', '{"json":{"type":"plain"}}', 1790769600161);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p041', '{"json":{"type":"plain","payload":{"n":"p041"}}}', 1790769600162);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p041', '{"json":{"type":"plain"}}', 1790769600163);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p042', '{"json":{"type":"plain","payload":{"n":"p042"}}}', 1790769600164);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p042', '{"json":{"type":"plain"}}', 1790769600165);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p043', '{"json":{"type":"plain","payload":{"n":"p043"}}}', 1790769600166);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p043', '{"json":{"type":"plain"}}', 1790769600167);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p044', '{"json":{"type":"plain","payload":{"n":"p044"}}}', 1790769600168);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p044', '{"json":{"type":"plain"}}', 1790769600169);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p045', '{"json":{"type":"plain","payload":{"n":"p045"}}}', 1790769600170);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p045', '{"json":{"type":"plain"}}', 1790769600171);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p046', '{"json":{"type":"plain","payload":{"n":"p046"}}}', 1790769600172);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p046', '{"json":{"type":"plain"}}', 1790769600173);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p047', '{"json":{"type":"plain","payload":{"n":"p047"}}}', 1790769600174);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p047', '{"json":{"type":"plain"}}', 1790769600175);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p048', '{"json":{"type":"plain","payload":{"n":"p048"}}}', 1790769600176);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p048', '{"json":{"type":"plain"}}', 1790769600177);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p049', '{"json":{"type":"plain","payload":{"n":"p049"}}}', 1790769600178);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p049', '{"json":{"type":"plain"}}', 1790769600179);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p050', '{"json":{"type":"plain","payload":{"n":"p050"}}}', 1790769600180);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p050', '{"json":{"type":"plain"}}', 1790769600181);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p051', '{"json":{"type":"plain","payload":{"n":"p051"}}}', 1790769600182);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p051', '{"json":{"type":"plain"}}', 1790769600183);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p052', '{"json":{"type":"plain","payload":{"n":"p052"}}}', 1790769600184);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p052', '{"json":{"type":"plain"}}', 1790769600185);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p053', '{"json":{"type":"plain","payload":{"n":"p053"}}}', 1790769600186);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p053', '{"json":{"type":"plain"}}', 1790769600187);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p054', '{"json":{"type":"plain","payload":{"n":"p054"}}}', 1790769600188);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p054', '{"json":{"type":"plain"}}', 1790769600189);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p055', '{"json":{"type":"plain","payload":{"n":"p055"}}}', 1790769600190);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p055', '{"json":{"type":"plain"}}', 1790769600191);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p056', '{"json":{"type":"plain","payload":{"n":"p056"}}}', 1790769600192);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p056', '{"json":{"type":"plain"}}', 1790769600193);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p057', '{"json":{"type":"plain","payload":{"n":"p057"}}}', 1790769600194);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p057', '{"json":{"type":"plain"}}', 1790769600195);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p058', '{"json":{"type":"plain","payload":{"n":"p058"}}}', 1790769600196);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p058', '{"json":{"type":"plain"}}', 1790769600197);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p059', '{"json":{"type":"plain","payload":{"n":"p059"}}}', 1790769600198);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p059', '{"json":{"type":"plain"}}', 1790769600199);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p060', '{"json":{"type":"plain","payload":{"n":"p060"}}}', 1790769600200);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p060', '{"json":{"type":"plain"}}', 1790769600201);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p061', '{"json":{"type":"plain","payload":{"n":"p061"}}}', 1790769600202);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p061', '{"json":{"type":"plain"}}', 1790769600203);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p062', '{"json":{"type":"plain","payload":{"n":"p062"}}}', 1790769600204);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p062', '{"json":{"type":"plain"}}', 1790769600205);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p063', '{"json":{"type":"plain","payload":{"n":"p063"}}}', 1790769600206);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p063', '{"json":{"type":"plain"}}', 1790769600207);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p064', '{"json":{"type":"plain","payload":{"n":"p064"}}}', 1790769600208);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p064', '{"json":{"type":"plain"}}', 1790769600209);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p065', '{"json":{"type":"plain","payload":{"n":"p065"}}}', 1790769600210);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p065', '{"json":{"type":"plain"}}', 1790769600211);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p066', '{"json":{"type":"plain","payload":{"n":"p066"}}}', 1790769600212);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p066', '{"json":{"type":"plain"}}', 1790769600213);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p067', '{"json":{"type":"plain","payload":{"n":"p067"}}}', 1790769600214);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p067', '{"json":{"type":"plain"}}', 1790769600215);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p068', '{"json":{"type":"plain","payload":{"n":"p068"}}}', 1790769600216);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p068', '{"json":{"type":"plain"}}', 1790769600217);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p069', '{"json":{"type":"plain","payload":{"n":"p069"}}}', 1790769600218);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p069', '{"json":{"type":"plain"}}', 1790769600219);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p070', '{"json":{"type":"plain","payload":{"n":"p070"}}}', 1790769600220);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p070', '{"json":{"type":"plain"}}', 1790769600221);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p071', '{"json":{"type":"plain","payload":{"n":"p071"}}}', 1790769600222);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p071', '{"json":{"type":"plain"}}', 1790769600223);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p072', '{"json":{"type":"plain","payload":{"n":"p072"}}}', 1790769600224);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p072', '{"json":{"type":"plain"}}', 1790769600225);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p073', '{"json":{"type":"plain","payload":{"n":"p073"}}}', 1790769600226);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p073', '{"json":{"type":"plain"}}', 1790769600227);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p074', '{"json":{"type":"plain","payload":{"n":"p074"}}}', 1790769600228);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p074', '{"json":{"type":"plain"}}', 1790769600229);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p075', '{"json":{"type":"plain","payload":{"n":"p075"}}}', 1790769600230);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p075', '{"json":{"type":"plain"}}', 1790769600231);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p076', '{"json":{"type":"plain","payload":{"n":"p076"}}}', 1790769600232);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p076', '{"json":{"type":"plain"}}', 1790769600233);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p077', '{"json":{"type":"plain","payload":{"n":"p077"}}}', 1790769600234);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p077', '{"json":{"type":"plain"}}', 1790769600235);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p078', '{"json":{"type":"plain","payload":{"n":"p078"}}}', 1790769600236);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p078', '{"json":{"type":"plain"}}', 1790769600237);
INSERT INTO public.gnl_work_log VALUES ('qjob', 'p079', '{"json":{"type":"plain","payload":{"n":"p079"}}}', 1790769600238);
INSERT INTO public.gnl_work_log VALUES ('qdepth', 'p079', '{"json":{"type":"plain"}}', 1790769600239);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~:carol:c0', '{"json":{"type":"plain","payload":{"n":"c0"},"resourceId":"carol"}}', 1790769600590);
INSERT INTO public.gnl_work_log VALUES ('qdepth', '~o~:carol:c0', '{"json":{"type":"plain"}}', 1790769600591);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~:carol:c1', '{"json":{"type":"plain","payload":{"n":"c1"},"resourceId":"carol"}}', 1790769600592);
INSERT INTO public.gnl_work_log VALUES ('qdepth', '~o~:carol:c1', '{"json":{"type":"plain"}}', 1790769600593);
INSERT INTO public.gnl_work_log VALUES ('qjob', '~o~:carol:c2', '{"json":{"type":"plain","payload":{"n":"c2"},"resourceId":"carol"}}', 1790769600594);
INSERT INTO public.gnl_work_log VALUES ('qdepth', '~o~:carol:c2', '{"json":{"type":"plain"}}', 1790769600595);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e000', '{"json":{"n":"e000"}}', 1790769600060);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e000', '{"json":{}}', 1790769600061);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e001', '{"json":{"n":"e001"}}', 1790769600062);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e001', '{"json":{}}', 1790769600063);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e002', '{"json":{"n":"e002"}}', 1790769600064);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e002', '{"json":{}}', 1790769600065);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e003', '{"json":{"n":"e003"}}', 1790769600066);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e003', '{"json":{}}', 1790769600067);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e004', '{"json":{"n":"e004"}}', 1790769600068);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e004', '{"json":{}}', 1790769600069);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e005', '{"json":{"n":"e005"}}', 1790769600070);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e005', '{"json":{}}', 1790769600071);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e006', '{"json":{"n":"e006"}}', 1790769600072);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e006', '{"json":{}}', 1790769600073);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e007', '{"json":{"n":"e007"}}', 1790769600074);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e007', '{"json":{}}', 1790769600075);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e008', '{"json":{"n":"e008"}}', 1790769600076);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e008', '{"json":{}}', 1790769600077);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e009', '{"json":{"n":"e009"}}', 1790769600078);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e009', '{"json":{}}', 1790769600079);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e010', '{"json":{"n":"e010"}}', 1790769600080);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e010', '{"json":{}}', 1790769600081);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e011', '{"json":{"n":"e011"}}', 1790769600082);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e011', '{"json":{}}', 1790769600083);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e012', '{"json":{"n":"e012"}}', 1790769600084);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e012', '{"json":{}}', 1790769600085);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e013', '{"json":{"n":"e013"}}', 1790769600086);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e013', '{"json":{}}', 1790769600087);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e014', '{"json":{"n":"e014"}}', 1790769600088);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e014', '{"json":{}}', 1790769600089);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e015', '{"json":{"n":"e015"}}', 1790769600090);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e015', '{"json":{}}', 1790769600091);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e016', '{"json":{"n":"e016"}}', 1790769600092);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e016', '{"json":{}}', 1790769600093);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e017', '{"json":{"n":"e017"}}', 1790769600094);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e017', '{"json":{}}', 1790769600095);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e018', '{"json":{"n":"e018"}}', 1790769600096);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e018', '{"json":{}}', 1790769600097);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e019', '{"json":{"n":"e019"}}', 1790769600098);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e019', '{"json":{}}', 1790769600099);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e020', '{"json":{"n":"e020"}}', 1790769600100);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e020', '{"json":{}}', 1790769600101);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e021', '{"json":{"n":"e021"}}', 1790769600102);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e021', '{"json":{}}', 1790769600103);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e022', '{"json":{"n":"e022"}}', 1790769600104);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e022', '{"json":{}}', 1790769600105);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e023', '{"json":{"n":"e023"}}', 1790769600106);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e023', '{"json":{}}', 1790769600107);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e024', '{"json":{"n":"e024"}}', 1790769600108);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e024', '{"json":{}}', 1790769600109);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e025', '{"json":{"n":"e025"}}', 1790769600110);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e025', '{"json":{}}', 1790769600111);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e026', '{"json":{"n":"e026"}}', 1790769600112);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e026', '{"json":{}}', 1790769600113);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e027', '{"json":{"n":"e027"}}', 1790769600114);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e027', '{"json":{}}', 1790769600115);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e028', '{"json":{"n":"e028"}}', 1790769600116);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e028', '{"json":{}}', 1790769600117);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e029', '{"json":{"n":"e029"}}', 1790769600118);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e029', '{"json":{}}', 1790769600119);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e030', '{"json":{"n":"e030"}}', 1790769600120);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e030', '{"json":{}}', 1790769600121);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e031', '{"json":{"n":"e031"}}', 1790769600122);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e031', '{"json":{}}', 1790769600123);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e032', '{"json":{"n":"e032"}}', 1790769600124);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e032', '{"json":{}}', 1790769600125);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e033', '{"json":{"n":"e033"}}', 1790769600126);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e033', '{"json":{}}', 1790769600127);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e034', '{"json":{"n":"e034"}}', 1790769600128);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e034', '{"json":{}}', 1790769600129);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e035', '{"json":{"n":"e035"}}', 1790769600130);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e035', '{"json":{}}', 1790769600131);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e036', '{"json":{"n":"e036"}}', 1790769600132);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e036', '{"json":{}}', 1790769600133);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e037', '{"json":{"n":"e037"}}', 1790769600134);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e037', '{"json":{}}', 1790769600135);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e038', '{"json":{"n":"e038"}}', 1790769600136);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e038', '{"json":{}}', 1790769600137);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e039', '{"json":{"n":"e039"}}', 1790769600138);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e039', '{"json":{}}', 1790769600139);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e040', '{"json":{"n":"e040"}}', 1790769600140);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e040', '{"json":{}}', 1790769600141);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e041', '{"json":{"n":"e041"}}', 1790769600142);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e041', '{"json":{}}', 1790769600143);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', 'e042', '{"json":{"n":"e042"}}', 1790769600144);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', 'e042', '{"json":{}}', 1790769600145);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', '~o~:carol:c0', '{"json":{"n":"c0"}}', 1790769600146);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', '~o~:carol:c0', '{"json":{}}', 1790769600147);
INSERT INTO public.gnl_work_log VALUES ('evt:orders', '~o~:carol:c1', '{"json":{"n":"c1"}}', 1790769600148);
INSERT INTO public.gnl_work_log VALUES ('evtdepth:orders', '~o~:carol:c1', '{"json":{}}', 1790769600149);

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

ALTER TABLE ONLY public.gnl_working_memory
    ADD CONSTRAINT gnl_working_memory_pkey PRIMARY KEY (scope_id);

CREATE INDEX gnl_counters_cprefix ON public.gnl_counters USING btree (key COLLATE "C");

CREATE INDEX gnl_run_journal_cprefix ON public.gnl_run_journal USING btree (key COLLATE "C");

CREATE INDEX gnl_run_journal_run ON public.gnl_run_journal USING btree (run_id, created_at);

CREATE INDEX gnl_runs_cprefix ON public.gnl_runs USING btree (run_id COLLATE "C");

CREATE INDEX gnl_runs_created ON public.gnl_runs USING btree (created_at, run_id);

CREATE INDEX gnl_runs_updated ON public.gnl_runs USING btree (updated_at);

CREATE INDEX gnl_threads_res ON public.gnl_threads USING btree (resource_id, updated_at);

CREATE INDEX gnl_work_log_ns ON public.gnl_work_log USING btree (ns, ts);
