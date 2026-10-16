-- Written by packages/upgrade-tests/generate/0.10.0.mjs --backend postgres. Do not edit.
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

INSERT INTO public.gnl_counters VALUES ('__metrics__:all#9', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#9', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#9', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#9', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#9', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#9', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#9', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#9', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#9', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#9', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#9', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#9', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#9', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#9', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#9', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#9', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#9', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#9', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#9', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#9', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#9', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#10', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#10', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#10', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#10', 'toolCalls', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#10', 'durMs', 25);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#10', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:scribe:d:2026-10-11#10', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:scribe:d:2026-10-11#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:scribe:d:2026-10-11#10', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:scribe:d:2026-10-11#10', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:scribe:d:2026-10-11#10', 'toolCalls', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:scribe:d:2026-10-11#10', 'durMs', 22);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:scribe:d:2026-10-11#10', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#10', 'runs', 3);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#10', 'tokens', 90);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#10', 'modelSteps', 6);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#10', 'toolCalls', 3);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#10', 'durMs', 109);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#10', 'durLt1s', 3);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#10', 'runs', 3);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#10', 'tokens', 90);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#10', 'modelSteps', 6);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#10', 'toolCalls', 3);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#10', 'durMs', 109);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#10', 'durLt1s', 3);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:lead:d:2026-10-11#10', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:lead:d:2026-10-11#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:lead:d:2026-10-11#10', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:lead:d:2026-10-11#10', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:lead:d:2026-10-11#10', 'toolCalls', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:lead:d:2026-10-11#10', 'durMs', 62);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:lead:d:2026-10-11#10', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#6', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#6', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#6', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#6', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#6', 'toolCalls', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#6', 'durMs', 22);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-10-11#6', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#14', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#14', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#14', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#14', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#14', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#14', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#14', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#14', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#14', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#14', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#14', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#14', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#14', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#14', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#14', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#14', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#14', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#14', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#14', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#14', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:plain:d:2026-10-11#14', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#6', 'runs', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#6', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#6', 'tokens', 60);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#6', 'modelSteps', 4);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#6', 'toolCalls', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#6', 'durMs', 53);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#6', 'durLt1s', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#6', 'runs', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#6', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#6', 'tokens', 60);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#6', 'modelSteps', 4);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#6', 'toolCalls', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#6', 'durMs', 53);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-10-11#6', 'durLt1s', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:payer:d:2026-10-11#6', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:payer:d:2026-10-11#6', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:payer:d:2026-10-11#6', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:payer:d:2026-10-11#6', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:payer:d:2026-10-11#6', 'toolCalls', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:payer:d:2026-10-11#6', 'durMs', 31);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:payer:d:2026-10-11#6', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__usage__', 'runs', 6);
INSERT INTO public.gnl_counters VALUES ('__usage__', 'tokens', 165);
INSERT INTO public.gnl_counters VALUES ('__usage__', 'costUsd', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#10', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#10', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#10', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#10', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#10', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#10', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#10', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#10', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#10', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#10', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#10', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#10', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#10', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#10', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#10', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#10', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#10', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#10', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#10', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__usage__', 'runs', 2);
INSERT INTO public.gnl_counters VALUES ('org:acme:__usage__', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('org:acme:__usage__', 'costUsd', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#0', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#0', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#0', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#0', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#0', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#0', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:all#0', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#0', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#0', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#0', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#0', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#0', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#0', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:d:2026-10-11#0', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#0', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#0', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#0', 'tokens', 15);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#0', 'modelSteps', 1);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#0', 'toolCalls', 0);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#0', 'durMs', 9);
INSERT INTO public.gnl_counters VALUES ('org:acme:__metrics__:agent:plain:d:2026-10-11#0', 'durLt1s', 1);

INSERT INTO public.gnl_message_batches VALUES ('t-alice-1', 'mem-user-appended:r-done-alice', 0, 1, 1791201600014);
INSERT INTO public.gnl_message_batches VALUES ('t-alice-1', 'mem-appended:r-done-alice', 1, 2, 1791201600026);
INSERT INTO public.gnl_message_batches VALUES ('t-alice-1', 'mem-user-appended:r-done-alice-b', 2, 3, 1791201600044);
INSERT INTO public.gnl_message_batches VALUES ('t-alice-1', 'mem-appended:r-done-alice-b', 3, 6, 1791201600074);
INSERT INTO public.gnl_message_batches VALUES ('t-alice-2', 'mem-user-appended:r-susp-alice', 0, 1, 1791201600095);
INSERT INTO public.gnl_message_batches VALUES ('t-bob-1', 'mem-user-appended:r-fail-bob', 0, 1, 1791201600121);
INSERT INTO public.gnl_message_batches VALUES ('t-bob-1', 'mem-user-appended:r-cancel-bob', 1, 2, 1791201600139);
INSERT INTO public.gnl_message_batches VALUES ('t-carol-1', 'mem-user-appended:r-sub-carol', 0, 1, 1791201600168);
INSERT INTO public.gnl_message_batches VALUES ('t-carol-2', 'mem-user-appended:r-subdone-carol', 0, 1, 1791201600217);
INSERT INTO public.gnl_message_batches VALUES ('t-carol-2', 'mem-appended:r-subdone-carol', 1, 4, 1791201600284);
INSERT INTO public.gnl_message_batches VALUES ('t-alice-3', 'mem-user-appended:r-approved-alice', 0, 1, 1791201600400);
INSERT INTO public.gnl_message_batches VALUES ('t-alice-3', 'mem-appended:r-approved-alice', 1, 4, 1791201600434);
INSERT INTO public.gnl_message_batches VALUES ('t-bob-2', 'mem-user-appended:r-hang-bob', 0, 1, 1791201600456);
INSERT INTO public.gnl_message_batches VALUES ('org:acme:t-dave-1', 'mem-user-appended:o-done-dave', 0, 1, 1791201600486);
INSERT INTO public.gnl_message_batches VALUES ('org:acme:t-dave-1', 'mem-appended:o-done-dave', 1, 2, 1791201600498);
INSERT INTO public.gnl_message_batches VALUES ('org:acme:t-dave-1', 'mem-user-appended:o-susp-dave', 2, 3, 1791201600516);
INSERT INTO public.gnl_message_batches VALUES ('org:acme:t-frank-1', 'mem-user-appended:o-fail-frank', 0, 1, 1791201600544);
INSERT INTO public.gnl_message_batches VALUES ('org:acme:t-frank-2', 'mem-user-appended:o-sub-frank', 0, 1, 1791201600567);
INSERT INTO public.gnl_message_batches VALUES ('org:acme:t-alice-acme', 'mem-user-appended:o-done-alice', 0, 1, 1791201600618);
INSERT INTO public.gnl_message_batches VALUES ('org:acme:t-alice-acme', 'mem-appended:o-done-alice', 1, 2, 1791201600630);

INSERT INTO public.gnl_messages VALUES ('t-alice-1', 0, 'user', 'go r-done-alice', NULL, NULL, 1791201600013, '{"json":{"role":"user","content":"go r-done-alice"}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-1', 1, 'assistant', 'hello', NULL, NULL, 1791201600025, '{"json":{"role":"assistant","content":[{"type":"text","text":"hello","providerOptions":null}]},"meta":{"values":{"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-1', 2, 'user', 'go r-done-alice-b', NULL, NULL, 1791201600043, '{"json":{"role":"user","content":"go r-done-alice-b"}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-1', 3, 'assistant', NULL, NULL, NULL, 1791201600071, '{"json":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_0","toolName":"note","input":{"n":1},"providerExecuted":null,"providerOptions":null}]},"meta":{"values":{"content.0.providerExecuted":["undefined"],"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-1', 4, 'tool', NULL, NULL, NULL, 1791201600072, '{"json":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_0","toolName":"note","output":{"type":"json","value":{"ok":true}}}]}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-1', 5, 'assistant', 'ok', NULL, NULL, 1791201600073, '{"json":{"role":"assistant","content":[{"type":"text","text":"ok","providerOptions":null}]},"meta":{"values":{"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-2', 0, 'user', 'go r-susp-alice', NULL, NULL, 1791201600094, '{"json":{"role":"user","content":"go r-susp-alice"}}');
INSERT INTO public.gnl_messages VALUES ('t-bob-1', 0, 'user', 'go r-fail-bob', NULL, NULL, 1791201600120, '{"json":{"role":"user","content":"go r-fail-bob"}}');
INSERT INTO public.gnl_messages VALUES ('t-bob-1', 1, 'user', 'go r-cancel-bob', NULL, NULL, 1791201600138, '{"json":{"role":"user","content":"go r-cancel-bob"}}');
INSERT INTO public.gnl_messages VALUES ('t-carol-1', 0, 'user', 'go r-sub-carol', NULL, NULL, 1791201600167, '{"json":{"role":"user","content":"go r-sub-carol"}}');
INSERT INTO public.gnl_messages VALUES ('t-carol-2', 0, 'user', 'go r-subdone-carol', NULL, NULL, 1791201600216, '{"json":{"role":"user","content":"go r-subdone-carol"}}');
INSERT INTO public.gnl_messages VALUES ('t-carol-2', 1, 'assistant', NULL, NULL, NULL, 1791201600281, '{"json":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_0","toolName":"agent_scribe","input":{"task":"write"},"providerExecuted":null,"providerOptions":null}]},"meta":{"values":{"content.0.providerExecuted":["undefined"],"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('t-carol-2', 2, 'tool', NULL, NULL, NULL, 1791201600282, '{"json":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_0","toolName":"agent_scribe","output":{"type":"json","value":{"status":"completed","text":"ok","interrupts":[]}}}]}}');
INSERT INTO public.gnl_messages VALUES ('t-carol-2', 3, 'assistant', 'ok', NULL, NULL, 1791201600283, '{"json":{"role":"assistant","content":[{"type":"text","text":"ok","providerOptions":null}]},"meta":{"values":{"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-3', 0, 'user', 'go r-approved-alice', NULL, NULL, 1791201600399, '{"json":{"role":"user","content":"go r-approved-alice"}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-3', 1, 'assistant', NULL, NULL, NULL, 1791201600431, '{"json":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_0","toolName":"pay","input":{"amt":5},"providerExecuted":null,"providerOptions":null}]},"meta":{"values":{"content.0.providerExecuted":["undefined"],"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-3', 2, 'tool', NULL, NULL, NULL, 1791201600432, '{"json":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_0","toolName":"pay","output":{"type":"json","value":{"ok":true}}}]}}');
INSERT INTO public.gnl_messages VALUES ('t-alice-3', 3, 'assistant', 'ok', NULL, NULL, 1791201600433, '{"json":{"role":"assistant","content":[{"type":"text","text":"ok","providerOptions":null}]},"meta":{"values":{"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('t-bob-2', 0, 'user', 'go r-hang-bob', NULL, NULL, 1791201600455, '{"json":{"role":"user","content":"go r-hang-bob"}}');
INSERT INTO public.gnl_messages VALUES ('org:acme:t-dave-1', 0, 'user', 'go o-done-dave', NULL, NULL, 1791201600485, '{"json":{"role":"user","content":"go o-done-dave"}}');
INSERT INTO public.gnl_messages VALUES ('org:acme:t-dave-1', 1, 'assistant', 'hello', NULL, NULL, 1791201600497, '{"json":{"role":"assistant","content":[{"type":"text","text":"hello","providerOptions":null}]},"meta":{"values":{"content.0.providerOptions":["undefined"]},"v":1}}');
INSERT INTO public.gnl_messages VALUES ('org:acme:t-dave-1', 2, 'user', 'go o-susp-dave', NULL, NULL, 1791201600515, '{"json":{"role":"user","content":"go o-susp-dave"}}');
INSERT INTO public.gnl_messages VALUES ('org:acme:t-frank-1', 0, 'user', 'go o-fail-frank', NULL, NULL, 1791201600543, '{"json":{"role":"user","content":"go o-fail-frank"}}');
INSERT INTO public.gnl_messages VALUES ('org:acme:t-frank-2', 0, 'user', 'go o-sub-frank', NULL, NULL, 1791201600566, '{"json":{"role":"user","content":"go o-sub-frank"}}');
INSERT INTO public.gnl_messages VALUES ('org:acme:t-alice-acme', 0, 'user', 'go o-done-alice', NULL, NULL, 1791201600617, '{"json":{"role":"user","content":"go o-done-alice"}}');
INSERT INTO public.gnl_messages VALUES ('org:acme:t-alice-acme', 1, 'assistant', 'hello', NULL, NULL, 1791201600629, '{"json":{"role":"assistant","content":[{"type":"text","text":"hello","providerOptions":null}]},"meta":{"values":{"content.0.providerOptions":["undefined"]},"v":1}}');

INSERT INTO public.gnl_meta VALUES ('schema_version', '1');

INSERT INTO public.gnl_run_journal VALUES ('thread:t-alice-1:owner', NULL, NULL, false, '{"json":{"at":1791201600000,"resourceId":"alice"}}', 1791201600001);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice:input', NULL, NULL, false, '{"json":{"at":1791201600009,"prompt":null,"messages":[{"role":"user","content":"go r-done-alice"}],"system":null,"threadId":"t-alice-1","agent":"plain","resourceId":"alice","hash":"3f956e00426d3369","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600003);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-1","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600012);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice:model:0', 'r-done-alice', 'model', false, '{"json":{"content":[{"type":"text","text":"hello"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600018);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600020,"reqHash":"4ece095507b0099c"}}', 1791201600016);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600027);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__done:r-done-alice', NULL, NULL, false, '{"json":{"at":1791201600028}}', 1791201600029);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__run:r-done-alice', NULL, NULL, false, '{"json":{"runId":"r-done-alice","agentName":"plain","status":"completed","costUsd":0,"totalTokens":15,"modelSteps":1,"toolCalls":0,"startTs":1791201600009,"durationMs":9,"finalizedAt":1791734560358}}', 1791201600030);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734560390}}', 1791201600006);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:input', NULL, NULL, false, '{"json":{"at":1791201600039,"prompt":null,"messages":[{"role":"user","content":"go r-done-alice"},{"role":"assistant","content":[{"type":"text","text":"hello","providerOptions":null}]},{"role":"user","content":"go r-done-alice-b"}],"system":null,"threadId":"t-alice-1","agent":"noter","resourceId":"alice","hash":"1bbfb6738bc01667","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"messages.1.content.0.providerOptions":["undefined"],"system":["undefined"]},"v":1}}', 1791201600034);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-1","recalled":[],"recentCount":2,"recent":[{"threadId":"t-alice-1","seq":0,"role":"user","preview":"go r-done-alice"},{"threadId":"t-alice-1","seq":1,"role":"assistant","preview":"hello"}],"incomingCount":1,"echoTrimmed":0}}', 1791201600042);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:model:0', 'r-done-alice-b', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"note","input":"{\"n\":1}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600048);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600050,"reqHash":"a413c735d508dcf5"}}', 1791201600046);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:tool:call_0', 'r-done-alice-b', 'tool', false, '{"json":{"status":"succeeded","output":{"ok":true},"argsHash":"2bfd14f43d17fc7c","toolName":"note","resolvedToolCallIds":["call_0"],"_v":2}}', 1791201600054);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:proc:dup-note-2bfd14f43d17fc7c', NULL, NULL, false, '{"json":{"firstToolCallId":"call_0","at":1791734560616}}', 1791201600056);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:model:1', 'r-done-alice-b', 'model', false, '{"json":{"content":[{"type":"text","text":"ok"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600064);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600066,"reqHash":"f469e4f8b6842c9a"}}', 1791201600062);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600075);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__done:r-done-alice-b', NULL, NULL, false, '{"json":{"at":1791201600076}}', 1791201600077);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__run:r-done-alice-b', NULL, NULL, false, '{"json":{"runId":"r-done-alice-b","agentName":"noter","status":"completed","costUsd":0,"totalTokens":30,"modelSteps":2,"toolCalls":1,"startTs":1791201600039,"durationMs":25,"finalizedAt":1791734560752}}', 1791201600078);
INSERT INTO public.gnl_run_journal VALUES ('r-done-alice-b:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734560760}}', 1791201600037);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-alice-2:owner', NULL, NULL, false, '{"json":{"at":1791201600081,"resourceId":"alice"}}', 1791201600082);
INSERT INTO public.gnl_run_journal VALUES ('r-susp-alice:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1791734560803}}', 1791201600087);
INSERT INTO public.gnl_run_journal VALUES ('r-susp-alice:input', NULL, NULL, false, '{"json":{"at":1791201600090,"prompt":null,"messages":[{"role":"user","content":"go r-susp-alice"}],"system":null,"threadId":"t-alice-2","agent":"payer","resourceId":"alice","hash":"2f3206a8bb80e2a3","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600084);
INSERT INTO public.gnl_run_journal VALUES ('r-susp-alice:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-2","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600093);
INSERT INTO public.gnl_run_journal VALUES ('r-susp-alice:model:0', 'r-susp-alice', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"pay","input":"{\"amt\":5}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600099);
INSERT INTO public.gnl_run_journal VALUES ('r-susp-alice:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600101,"reqHash":"5bc1a249fb0591aa"}}', 1791201600097);
INSERT INTO public.gnl_run_journal VALUES ('r-susp-alice:tool:call_0', 'r-susp-alice', 'tool', true, '{"json":{"status":"suspended","output":{"__gnl_suspend":{"toolCallId":"call_0","toolName":"pay","args":{"amt":5},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}},"toolName":"pay","_v":2}}', 1791201600105);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-bob-1:owner', NULL, NULL, false, '{"json":{"at":1791201600107,"resourceId":"bob"}}', 1791201600108);
INSERT INTO public.gnl_run_journal VALUES ('r-fail-bob:input', NULL, NULL, false, '{"json":{"at":1791201600116,"prompt":null,"messages":[{"role":"user","content":"go r-fail-bob"}],"system":null,"threadId":"t-bob-1","agent":"broken","resourceId":"bob","hash":"879b893576292a0f","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600110);
INSERT INTO public.gnl_run_journal VALUES ('r-fail-bob:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-bob-1","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600119);
INSERT INTO public.gnl_run_journal VALUES ('r-fail-bob:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"failed","startedAt":1791201600124,"reqHash":"4a5acfc6adb3d8b1"}}', 1791201600123);
INSERT INTO public.gnl_run_journal VALUES ('r-fail-bob:outcome', NULL, NULL, false, '{"json":{"status":"failed","at":1791734560973,"error":"model down"}}', 1791201600113);
INSERT INTO public.gnl_run_journal VALUES ('r-cancel-bob:input', NULL, NULL, false, '{"json":{"at":1791201600134,"prompt":null,"messages":[{"role":"user","content":"go r-fail-bob"},{"role":"user","content":"go r-cancel-bob"}],"system":null,"threadId":"t-bob-1","agent":"payer","resourceId":"bob","hash":"896586d080f9f2b3","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600129);
INSERT INTO public.gnl_run_journal VALUES ('r-cancel-bob:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-bob-1","recalled":[],"recentCount":1,"recent":[{"threadId":"t-bob-1","seq":0,"role":"user","preview":"go r-fail-bob"}],"incomingCount":1,"echoTrimmed":0}}', 1791201600137);
INSERT INTO public.gnl_run_journal VALUES ('r-cancel-bob:model:0', 'r-cancel-bob', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"pay","input":"{\"amt\":5}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600143);
INSERT INTO public.gnl_run_journal VALUES ('r-cancel-bob:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600145,"reqHash":"bbdce53442085543"}}', 1791201600141);
INSERT INTO public.gnl_run_journal VALUES ('r-cancel-bob:tool:call_0', 'r-cancel-bob', 'tool', true, '{"json":{"status":"suspended","output":{"__gnl_suspend":{"toolCallId":"call_0","toolName":"pay","args":{"amt":5},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}},"toolName":"pay","_v":2}}', 1791201600149);
INSERT INTO public.gnl_run_journal VALUES ('r-cancel-bob:proc:__gnl_canceled', NULL, NULL, false, '{"json":{"at":1791201600151,"reason":"upgrade fixture"}}', 1791201600152);
INSERT INTO public.gnl_run_journal VALUES ('r-cancel-bob:outcome', NULL, NULL, false, '{"json":{"status":"canceled","at":1791734561094}}', 1791201600132);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-carol-1:owner', NULL, NULL, false, '{"json":{"at":1791201600154,"resourceId":"carol"}}', 1791201600155);
INSERT INTO public.gnl_run_journal VALUES ('r-sub-carol:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1791734561130}}', 1791201600160);
INSERT INTO public.gnl_run_journal VALUES ('r-sub-carol:input', NULL, NULL, false, '{"json":{"at":1791201600163,"prompt":null,"messages":[{"role":"user","content":"go r-sub-carol"}],"system":null,"threadId":"t-carol-1","agent":"ward","resourceId":"carol","hash":"aba3acac6f604c51","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600157);
INSERT INTO public.gnl_run_journal VALUES ('r-sub-carol:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-carol-1","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600166);
INSERT INTO public.gnl_run_journal VALUES ('r-sub-carol:model:0', 'r-sub-carol', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"agent_medic","input":"{\"task\":\"dose\"}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600172);
INSERT INTO public.gnl_run_journal VALUES ('r-sub-carol:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600174,"reqHash":"bde9fa0ff12caad5"}}', 1791201600170);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-sub-carol:call_0:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1791734561254}}', 1791201600184);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-sub-carol:call_0:input', NULL, NULL, false, '{"json":{"at":1791201600186,"prompt":"dose","messages":null,"system":null,"threadId":"t-carol-1","agent":"medic","resourceId":"carol","hash":"64658e7379ae1f99","origin":"host","parentRunId":"r-sub-carol","_v":2},"meta":{"values":{"messages":["undefined"],"system":["undefined"]},"v":1}}', 1791201600181);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-sub-carol:call_0:model:0', 'agent:r-sub-carol:call_0', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"pay","input":"{\"amt\":7}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600192);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-sub-carol:call_0:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600194,"reqHash":"10cdcb4927858178"}}', 1791201600190);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-sub-carol:call_0:tool:call_0', 'agent:r-sub-carol:call_0', 'tool', true, '{"json":{"status":"suspended","output":{"__gnl_suspend":{"toolCallId":"call_0","toolName":"pay","args":{"amt":7},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}},"toolName":"pay","_v":2}}', 1791201600198);
INSERT INTO public.gnl_run_journal VALUES ('r-sub-carol:tool:call_0', 'r-sub-carol', 'tool', true, '{"json":{"status":"suspended","output":{"status":"suspended","text":"","interrupts":[{"toolCallId":"call_0/call_0","toolName":"pay","args":{"amt":7},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}],"__gnl_suspend":{"toolCallId":"call_0","toolName":"agent","args":{"task":"dose"},"kind":"nested","reason":"The ''medic'' sub-agent stopped for a human: ''pay'' requires explicit confirmation before it runs.. Answer with the addressed toolCallId(s).","nested":{"runId":"agent:r-sub-carol:call_0","agent":"medic","interrupts":[{"toolCallId":"call_0/call_0","toolName":"pay","args":{"amt":7},"reason":"''pay'' requires explicit confirmation before it runs."}]}}},"toolName":"agent_medic","_v":2},"meta":{"referentialEqualities":{"output.interrupts.0.args":["output.__gnl_suspend.nested.interrupts.0.args"]},"v":1}}', 1791201600178);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-carol-2:owner', NULL, NULL, false, '{"json":{"at":1791201600203,"resourceId":"carol"}}', 1791201600204);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734561787}}', 1791201600209);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:input', NULL, NULL, false, '{"json":{"at":1791201600212,"prompt":null,"messages":[{"role":"user","content":"go r-subdone-carol"}],"system":null,"threadId":"t-carol-2","agent":"lead","resourceId":"carol","hash":"c3ce5656674e1fbf","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600206);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-carol-2","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600215);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:model:0', 'r-subdone-carol', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"agent_scribe","input":"{\"task\":\"write\"}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600221);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600223,"reqHash":"ca12b6ea505e0c72"}}', 1791201600219);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:input', NULL, NULL, false, '{"json":{"at":1791201600235,"prompt":"write","messages":null,"system":null,"threadId":"t-carol-2","agent":"scribe","resourceId":"carol","hash":"5e3cb8c7afc3479d","origin":"host","parentRunId":"r-subdone-carol","_v":2},"meta":{"values":{"messages":["undefined"],"system":["undefined"]},"v":1}}', 1791201600230);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:model:0', 'agent:r-subdone-carol:call_0', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"note","input":"{\"n\":2}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600241);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600243,"reqHash":"0b9ed3b37c700bd0"}}', 1791201600239);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:tool:call_0', 'agent:r-subdone-carol:call_0', 'tool', false, '{"json":{"status":"succeeded","output":{"ok":true},"argsHash":"363379742f80b51b","toolName":"note","resolvedToolCallIds":["call_0"],"_v":2}}', 1791201600247);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:proc:dup-note-363379742f80b51b', NULL, NULL, false, '{"json":{"firstToolCallId":"call_0","at":1791734561640}}', 1791201600249);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:model:1', 'agent:r-subdone-carol:call_0', 'model', false, '{"json":{"content":[{"type":"text","text":"ok"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600257);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600259,"reqHash":"07771a877cdbb9a7"}}', 1791201600255);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600262);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__done:agent:r-subdone-carol:call_0', NULL, NULL, false, '{"json":{"at":1791201600263}}', 1791201600264);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__run:agent:r-subdone-carol:call_0', NULL, NULL, false, '{"json":{"runId":"agent:r-subdone-carol:call_0","agentName":"scribe","status":"completed","costUsd":0,"totalTokens":30,"modelSteps":2,"toolCalls":1,"startTs":1791201600235,"durationMs":22,"finalizedAt":1791734561687}}', 1791201600265);
INSERT INTO public.gnl_run_journal VALUES ('agent:r-subdone-carol:call_0:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734561699}}', 1791201600233);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:tool:call_0', 'r-subdone-carol', 'tool', false, '{"json":{"status":"succeeded","output":{"status":"completed","text":"ok","interrupts":[]},"argsHash":"69bcb43acd47d395","toolName":"agent_scribe","delegation":true,"resolvedToolCallIds":["call_0"],"_v":2}}', 1791201600227);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:model:1', 'r-subdone-carol', 'model', false, '{"json":{"content":[{"type":"text","text":"ok"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600274);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600276,"reqHash":"f3253605405dc268"}}', 1791201600272);
INSERT INTO public.gnl_run_journal VALUES ('r-subdone-carol:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600285);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__done:r-subdone-carol', NULL, NULL, false, '{"json":{"at":1791201600286}}', 1791201600287);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__run:r-subdone-carol', NULL, NULL, false, '{"json":{"runId":"r-subdone-carol","agentName":"lead","status":"completed","costUsd":0,"totalTokens":30,"modelSteps":2,"toolCalls":1,"startTs":1791201600212,"durationMs":62,"finalizedAt":1791734561778}}', 1791201600288);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:input', NULL, NULL, false, '{"json":{"at":1791201600297,"prompt":"go r-staff","messages":null,"system":null,"agent":"noter","ownerKind":"staff","hash":"0f8de4f9fd747ea4","origin":"host","_v":2},"meta":{"values":{"messages":["undefined"],"system":["undefined"]},"v":1}}', 1791201600292);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:model:0', 'r-staff', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"note","input":"{\"n\":1}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600303);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600305,"reqHash":"84558fcc972cf6da"}}', 1791201600301);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:tool:call_0', 'r-staff', 'tool', false, '{"json":{"status":"succeeded","output":{"ok":true},"argsHash":"2bfd14f43d17fc7c","toolName":"note","resolvedToolCallIds":["call_0"],"_v":2}}', 1791201600309);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734561958}}', 1791201600295);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:proc:dup-note-2bfd14f43d17fc7c', NULL, NULL, false, '{"json":{"firstToolCallId":"call_0","at":1791734561888}}', 1791201600311);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:model:1', 'r-staff', 'model', false, '{"json":{"content":[{"type":"text","text":"ok"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600319);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600321,"reqHash":"332a26b9ff1360ed"}}', 1791201600317);
INSERT INTO public.gnl_run_journal VALUES ('r-staff:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600324);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__done:r-staff', NULL, NULL, false, '{"json":{"at":1791201600325}}', 1791201600326);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__run:r-staff', NULL, NULL, false, '{"json":{"runId":"r-staff","agentName":"noter","status":"completed","costUsd":0,"totalTokens":30,"modelSteps":2,"toolCalls":1,"startTs":1791201600297,"durationMs":22,"finalizedAt":1791734561948}}', 1791201600327);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-alice-3:owner', NULL, NULL, false, '{"json":{"at":1791201600386,"resourceId":"alice"}}', 1791201600387);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:input', NULL, NULL, false, '{"json":{"at":1791201600395,"prompt":null,"messages":[{"role":"user","content":"go r-approved-alice"}],"system":null,"threadId":"t-alice-3","agent":"payer","resourceId":"alice","hash":"8b6f5c1a6ae00b2a","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600389);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-3","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600398);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:model:0', 'r-approved-alice', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"pay","input":"{\"amt\":5}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600404);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600406,"reqHash":"f1492f6dc7938b9c"}}', 1791201600402);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:approval:call_0', NULL, NULL, false, '{"json":{"v":1,"decision":true,"at":1791201600414}}', 1791201600415);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:proc:override-call_0', NULL, NULL, false, '{"json":{"at":1791734562446,"toolCallId":"call_0","toolName":"pay","reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}}', 1791201600417);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:tool:call_0', 'r-approved-alice', 'tool', false, '{"json":{"status":"succeeded","output":{"ok":true},"argsHash":"597a83f3dd4278fa","toolName":"pay","resolvedToolCallIds":["call_0"],"_v":2}}', 1791201600410);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:proc:dup-pay-597a83f3dd4278fa', NULL, NULL, false, '{"json":{"firstToolCallId":"call_0","at":1791734562480}}', 1791201600422);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:model:1', 'r-approved-alice', 'model', false, '{"json":{"content":[{"type":"text","text":"ok"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600426);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600428,"reqHash":"f98c894aee2e88c2"}}', 1791201600424);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600435);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__done:r-approved-alice', NULL, NULL, false, '{"json":{"at":1791201600436}}', 1791201600437);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__run:r-approved-alice', NULL, NULL, false, '{"json":{"runId":"r-approved-alice","agentName":"payer","status":"completed","costUsd":0,"totalTokens":30,"modelSteps":2,"toolCalls":1,"startTs":1791201600395,"durationMs":31,"finalizedAt":1791734562588}}', 1791201600438);
INSERT INTO public.gnl_run_journal VALUES ('r-approved-alice:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734562601}}', 1791201600392);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-bob-2:owner', NULL, NULL, false, '{"json":{"at":1791201600442,"resourceId":"bob"}}', 1791201600443);
INSERT INTO public.gnl_run_journal VALUES ('r-hang-bob:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1791734562783}}', 1791201600448);
INSERT INTO public.gnl_run_journal VALUES ('r-hang-bob:input', NULL, NULL, false, '{"json":{"at":1791201600451,"prompt":null,"messages":[{"role":"user","content":"go r-hang-bob"}],"system":null,"threadId":"t-bob-2","agent":"hanger","resourceId":"bob","hash":"d76ed7b951bb0693","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600445);
INSERT INTO public.gnl_run_journal VALUES ('r-hang-bob:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-bob-2","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600454);
INSERT INTO public.gnl_run_journal VALUES ('r-hang-bob:model:0', 'r-hang-bob', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"hang","input":"{}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600460);
INSERT INTO public.gnl_run_journal VALUES ('r-hang-bob:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600462,"reqHash":"b5a84aae66eb3509"}}', 1791201600458);
INSERT INTO public.gnl_run_journal VALUES ('r-hang-bob:tool:call_0', 'r-hang-bob', 'tool', false, '{"json":{"status":"running","startedAt":1791734562862,"attempts":1,"_v":2}}', 1791201600466);
INSERT INTO public.gnl_run_journal VALUES ('r-hang-bob:proc:dup-hang-44136fa355b3678a', NULL, NULL, false, '{"json":{"firstToolCallId":"call_0","at":1791734562868,"inFlight":true}}', 1791201600468);
INSERT INTO public.gnl_run_journal VALUES ('__org__:acme', NULL, NULL, false, '{"json":{"id":"acme","createdAt":1}}', 1791201600469);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:thread:t-dave-1:owner', NULL, NULL, false, '{"json":{"at":1791201600470,"resourceId":"dave"}}', 1791201600471);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-dave:input', NULL, NULL, false, '{"json":{"at":1791201600481,"prompt":null,"messages":[{"role":"user","content":"go o-done-dave"}],"system":null,"threadId":"t-dave-1","agent":"plain","resourceId":"dave","hash":"e192eca1fa9ab38e","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600473);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-dave:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-dave-1","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600484);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-dave:model:0', 'org:acme:o-done-dave', 'model', false, '{"json":{"content":[{"type":"text","text":"hello"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600490);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-dave:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600492,"reqHash":"55015129836b26ea"}}', 1791201600488);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-dave:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600499);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:__metrics__done:o-done-dave', NULL, NULL, false, '{"json":{"at":1791201600500}}', 1791201600501);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:__metrics__run:o-done-dave', NULL, NULL, false, '{"json":{"runId":"o-done-dave","agentName":"plain","status":"completed","costUsd":0,"totalTokens":15,"modelSteps":1,"toolCalls":0,"startTs":1791201600481,"durationMs":9,"finalizedAt":1791734563052}}', 1791201600502);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-dave:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734563062}}', 1791201600476);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-susp-dave:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1791734563096}}', 1791201600509);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-susp-dave:input', NULL, NULL, false, '{"json":{"at":1791201600511,"prompt":null,"messages":[{"role":"user","content":"go o-done-dave"},{"role":"assistant","content":[{"type":"text","text":"hello","providerOptions":null}]},{"role":"user","content":"go o-susp-dave"}],"system":null,"threadId":"t-dave-1","agent":"payer","resourceId":"dave","hash":"ace04a03b89b1c8e","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"messages.1.content.0.providerOptions":["undefined"],"system":["undefined"]},"v":1}}', 1791201600506);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-susp-dave:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-dave-1","recalled":[],"recentCount":2,"recent":[{"threadId":"t-dave-1","seq":0,"role":"user","preview":"go o-done-dave"},{"threadId":"t-dave-1","seq":1,"role":"assistant","preview":"hello"}],"incomingCount":1,"echoTrimmed":0}}', 1791201600514);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-susp-dave:model:0', 'org:acme:o-susp-dave', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"pay","input":"{\"amt\":5}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600520);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-susp-dave:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600522,"reqHash":"69010c8f47f11add"}}', 1791201600518);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-susp-dave:tool:call_0', 'org:acme:o-susp-dave', 'tool', true, '{"json":{"status":"suspended","output":{"__gnl_suspend":{"toolCallId":"call_0","toolName":"pay","args":{"amt":5},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}},"toolName":"pay","_v":2}}', 1791201600526);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:thread:t-frank-1:owner', NULL, NULL, false, '{"json":{"at":1791201600528,"resourceId":"frank"}}', 1791201600529);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-fail-frank:input', NULL, NULL, false, '{"json":{"at":1791201600539,"prompt":null,"messages":[{"role":"user","content":"go o-fail-frank"}],"system":null,"threadId":"t-frank-1","agent":"broken","resourceId":"frank","hash":"dcf633d07a08e4d3","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600531);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-fail-frank:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-frank-1","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600542);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-fail-frank:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"failed","startedAt":1791201600547,"reqHash":"f64c8d74ea05b121"}}', 1791201600546);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-fail-frank:outcome', NULL, NULL, false, '{"json":{"status":"failed","at":1791734563241,"error":"model down"}}', 1791201600534);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:thread:t-frank-2:owner', NULL, NULL, false, '{"json":{"at":1791201600551,"resourceId":"frank"}}', 1791201600552);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-sub-frank:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1791734563272}}', 1791201600557);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-sub-frank:input', NULL, NULL, false, '{"json":{"at":1791201600562,"prompt":null,"messages":[{"role":"user","content":"go o-sub-frank"}],"system":null,"threadId":"t-frank-2","agent":"ward","resourceId":"frank","hash":"04c96dbcf00f4963","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600554);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-sub-frank:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-frank-2","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600565);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-sub-frank:model:0', 'org:acme:o-sub-frank', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"agent_medic","input":"{\"task\":\"dose\"}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600571);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-sub-frank:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600573,"reqHash":"c76e260a54ce3e28"}}', 1791201600569);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:agent:o-sub-frank:call_0:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1791734563372}}', 1791201600583);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:agent:o-sub-frank:call_0:input', NULL, NULL, false, '{"json":{"at":1791201600585,"prompt":"dose","messages":null,"system":null,"threadId":"t-frank-2","agent":"medic","resourceId":"frank","hash":"64658e7379ae1f99","origin":"host","parentRunId":"o-sub-frank","_v":2},"meta":{"values":{"messages":["undefined"],"system":["undefined"]},"v":1}}', 1791201600580);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:agent:o-sub-frank:call_0:model:0', 'org:acme:agent:o-sub-frank:call_0', 'model', false, '{"json":{"content":[{"type":"tool-call","toolCallId":"call_0","toolName":"pay","input":"{\"amt\":7}"}],"finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600591);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:agent:o-sub-frank:call_0:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600593,"reqHash":"10cdcb4927858178"}}', 1791201600589);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:agent:o-sub-frank:call_0:tool:call_0', 'org:acme:agent:o-sub-frank:call_0', 'tool', true, '{"json":{"status":"suspended","output":{"__gnl_suspend":{"toolCallId":"call_0","toolName":"pay","args":{"amt":7},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}},"toolName":"pay","_v":2}}', 1791201600597);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-sub-frank:tool:call_0', 'org:acme:o-sub-frank', 'tool', true, '{"json":{"status":"suspended","output":{"status":"suspended","text":"","interrupts":[{"toolCallId":"call_0/call_0","toolName":"pay","args":{"amt":7},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}],"__gnl_suspend":{"toolCallId":"call_0","toolName":"agent","args":{"task":"dose"},"kind":"nested","reason":"The ''medic'' sub-agent stopped for a human: ''pay'' requires explicit confirmation before it runs.. Answer with the addressed toolCallId(s).","nested":{"runId":"agent:o-sub-frank:call_0","agent":"medic","interrupts":[{"toolCallId":"call_0/call_0","toolName":"pay","args":{"amt":7},"reason":"''pay'' requires explicit confirmation before it runs."}]}}},"toolName":"agent_medic","_v":2},"meta":{"referentialEqualities":{"output.interrupts.0.args":["output.__gnl_suspend.nested.interrupts.0.args"]},"v":1}}', 1791201600577);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:thread:t-alice-acme:owner', NULL, NULL, false, '{"json":{"at":1791201600602,"resourceId":"alice"}}', 1791201600603);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-alice:input', NULL, NULL, false, '{"json":{"at":1791201600613,"prompt":null,"messages":[{"role":"user","content":"go o-done-alice"}],"system":null,"threadId":"t-alice-acme","agent":"plain","resourceId":"alice","hash":"a484b37704f594e7","origin":"host","_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1791201600605);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-alice:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-acme","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0}}', 1791201600616);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-alice:model:0', 'org:acme:o-done-alice', 'model', false, '{"json":{"content":[{"type":"text","text":"hello"}],"finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}},"warnings":[],"_v":2}}', 1791201600622);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-alice:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1791201600624,"reqHash":"7b6bec71511d7b89"}}', 1791201600620);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-alice:usage-counted', NULL, NULL, false, '{"json":true}', 1791201600631);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:__metrics__done:o-done-alice', NULL, NULL, false, '{"json":{"at":1791201600632}}', 1791201600633);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:__metrics__run:o-done-alice', NULL, NULL, false, '{"json":{"runId":"o-done-alice","agentName":"plain","status":"completed","costUsd":0,"totalTokens":15,"modelSteps":1,"toolCalls":0,"startTs":1791201600613,"durationMs":9,"finalizedAt":1791734563577}}', 1791201600634);
INSERT INTO public.gnl_run_journal VALUES ('org:acme:o-done-alice:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1791734563584}}', 1791201600608);

INSERT INTO public.gnl_runs VALUES ('r-done-alice', 1, 0, false, 0, false, false, false, 1791201600004, 1791201600032);
INSERT INTO public.gnl_runs VALUES ('r-done-alice-b', 2, 1, false, 0, false, false, false, 1791201600035, 1791201600080);
INSERT INTO public.gnl_runs VALUES ('r-susp-alice', 1, 1, true, 1, false, true, false, 1791201600085, 1791201600106);
INSERT INTO public.gnl_runs VALUES ('r-fail-bob', 0, 0, false, 0, true, false, false, 1791201600111, 1791201600127);
INSERT INTO public.gnl_runs VALUES ('r-cancel-bob', 1, 1, true, 1, false, false, true, 1791201600130, 1791201600153);
INSERT INTO public.gnl_runs VALUES ('agent:r-sub-carol:call_0', 1, 1, true, 1, false, true, false, 1791201600182, 1791201600199);
INSERT INTO public.gnl_runs VALUES ('r-sub-carol', 1, 1, true, 1, false, true, false, 1791201600158, 1791201600202);
INSERT INTO public.gnl_runs VALUES ('agent:r-subdone-carol:call_0', 2, 1, false, 0, false, false, false, 1791201600231, 1791201600267);
INSERT INTO public.gnl_runs VALUES ('r-subdone-carol', 2, 1, false, 0, false, false, false, 1791201600207, 1791201600290);
INSERT INTO public.gnl_runs VALUES ('r-staff', 2, 1, false, 0, false, false, false, 1791201600293, 1791201600329);
INSERT INTO public.gnl_runs VALUES ('r-approved-alice', 2, 1, false, 0, false, false, false, 1791201600390, 1791201600440);
INSERT INTO public.gnl_runs VALUES ('r-hang-bob', 1, 1, false, 0, false, true, false, 1791201600446, 1791201600467);
INSERT INTO public.gnl_runs VALUES ('org:acme:o-done-dave', 1, 0, false, 0, false, false, false, 1791201600474, 1791201600504);
INSERT INTO public.gnl_runs VALUES ('org:acme:o-susp-dave', 1, 1, true, 1, false, true, false, 1791201600507, 1791201600527);
INSERT INTO public.gnl_runs VALUES ('org:acme:o-fail-frank', 0, 0, false, 0, true, false, false, 1791201600532, 1791201600550);
INSERT INTO public.gnl_runs VALUES ('org:acme:agent:o-sub-frank:call_0', 1, 1, true, 1, false, true, false, 1791201600581, 1791201600598);
INSERT INTO public.gnl_runs VALUES ('org:acme:o-sub-frank', 1, 1, true, 1, false, true, false, 1791201600555, 1791201600601);
INSERT INTO public.gnl_runs VALUES ('org:acme:o-done-alice', 1, 0, false, 0, false, false, false, 1791201600606, 1791201600636);

INSERT INTO public.gnl_threads VALUES ('t-alice-1', 'alice', 'go r-done-alice', NULL, NULL, 1791201600008, 1791201600008, NULL);
INSERT INTO public.gnl_threads VALUES ('t-alice-2', 'alice', 'go r-susp-alice', NULL, NULL, 1791201600089, 1791201600089, NULL);
INSERT INTO public.gnl_threads VALUES ('t-bob-1', 'bob', 'go r-fail-bob', NULL, NULL, 1791201600115, 1791201600115, NULL);
INSERT INTO public.gnl_threads VALUES ('t-carol-1', 'carol', 'go r-sub-carol', NULL, NULL, 1791201600162, 1791201600162, NULL);
INSERT INTO public.gnl_threads VALUES ('t-carol-2', 'carol', 'go r-subdone-carol', NULL, NULL, 1791201600211, 1791201600211, NULL);
INSERT INTO public.gnl_threads VALUES ('t-alice-3', 'alice', 'go r-approved-alice', NULL, NULL, 1791201600394, 1791201600394, NULL);
INSERT INTO public.gnl_threads VALUES ('t-erin-1', 'erin', NULL, NULL, NULL, 1791201600338, 1791201600338, 1791201600441);
INSERT INTO public.gnl_threads VALUES ('t-bob-2', 'bob', 'go r-hang-bob', NULL, NULL, 1791201600450, 1791201600450, NULL);
INSERT INTO public.gnl_threads VALUES ('org:acme:t-dave-1', 'dave', 'go o-done-dave', NULL, NULL, 1791201600478, 1791201600478, NULL);
INSERT INTO public.gnl_threads VALUES ('org:acme:t-frank-1', 'frank', 'go o-fail-frank', NULL, NULL, 1791201600536, 1791201600536, NULL);
INSERT INTO public.gnl_threads VALUES ('org:acme:t-frank-2', 'frank', 'go o-sub-frank', NULL, NULL, 1791201600559, 1791201600559, NULL);
INSERT INTO public.gnl_threads VALUES ('org:acme:t-alice-acme', 'alice', 'go o-done-alice', NULL, NULL, 1791201600610, 1791201600610, NULL);

SELECT pg_catalog.setval('public.gnl_work_log_ord', 1, false);

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

CREATE INDEX gnl_run_journal_run ON public.gnl_run_journal USING btree (run_id, created_at);

CREATE INDEX gnl_runs_cprefix ON public.gnl_runs USING btree (run_id COLLATE "C");

CREATE INDEX gnl_runs_created ON public.gnl_runs USING btree (created_at, run_id);

CREATE INDEX gnl_runs_updated ON public.gnl_runs USING btree (updated_at);

CREATE INDEX gnl_threads_res ON public.gnl_threads USING btree (resource_id, updated_at);

CREATE INDEX gnl_vectors_doc ON public.gnl_vectors USING btree (doc);

CREATE INDEX gnl_work_log_ns ON public.gnl_work_log USING btree (ns, ts);

CREATE INDEX gnl_work_log_seq ON public.gnl_work_log USING btree (ns, seq, ts, id);
