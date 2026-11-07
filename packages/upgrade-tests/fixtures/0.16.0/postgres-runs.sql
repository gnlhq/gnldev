-- Written by packages/upgrade-tests/generate/0.16.0-runs.mjs --backend postgres. Do not edit.
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

INSERT INTO public.gnl_counters VALUES ('__usage__', 'costUsd', 0);
INSERT INTO public.gnl_counters VALUES ('__usage__', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__usage__', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-11-07#8', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-11-07#8', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-11-07#8', 'durMs', 66);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-11-07#8', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-11-07#8', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-11-07#8', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:agent:noter:d:2026-11-07#8', 'toolCalls', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#8', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#8', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#8', 'durMs', 66);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#8', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#8', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#8', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:all#8', 'toolCalls', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-11-07#8', 'costUsdMicros', 0);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-11-07#8', 'durLt1s', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-11-07#8', 'durMs', 66);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-11-07#8', 'modelSteps', 2);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-11-07#8', 'runs', 1);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-11-07#8', 'tokens', 30);
INSERT INTO public.gnl_counters VALUES ('__metrics__:d:2026-11-07#8', 'toolCalls', 1);

INSERT INTO public.gnl_meta VALUES ('schema_version', '1');

INSERT INTO public.gnl_run_journal VALUES ('thread:records:v1', NULL, NULL, false, '{"json":{"at":1793620800000,"firstContact":true}}', 1793620800001, NULL, 1);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-alice-1:owner', NULL, NULL, false, '{"json":{"at":1793620800002,"resourceId":"alice"}}', 1793620800003, 'alice', 2);
INSERT INTO public.gnl_run_journal VALUES ('r-done:input', NULL, NULL, false, '{"json":{"at":1793620800016,"prompt":null,"messages":[{"role":"user","content":"go r-done"}],"system":null,"threadId":"t-alice-1","agent":"noter","resourceId":"alice","hash":"a9b2ea6cba336292","origin":"host","turn":{"count":1,"token":"00000000-0000-4000-8000-000000000002"},"_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1793620800005, NULL, 3);
INSERT INTO public.gnl_run_journal VALUES ('r-done:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-1","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0,"layout":{"v":1,"n":1,"status":"exact","incoming":[0,1],"token":"00000000-0000-4000-8000-000000000002"}}}', 1793620800019, NULL, 8);
INSERT INTO public.gnl_run_journal VALUES ('mem-user-appended:r-done', NULL, NULL, false, '{"json":true}', 1793620800021, NULL, 9);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000001', NULL, NULL, false, '{"json":{"v":1,"seq":1,"kind":"status","data":{"state":"running"},"step":-1,"at":1793620800029}}', 1793620800030, NULL, 11);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000002', NULL, NULL, false, '{"json":{"v":1,"seq":2,"kind":"start","data":{},"step":-1,"at":1793620800034}}', 1793620800035, NULL, 12);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000003', NULL, NULL, false, '{"json":{"v":1,"seq":3,"kind":"step-start","data":{},"step":0,"at":1793620800044}}', 1793620800045, NULL, 15);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000004', NULL, NULL, false, '{"json":{"v":1,"seq":4,"kind":"tool-call","data":{"toolCallId":"call_note","toolName":"note","input":{"n":1}},"step":0,"at":1793620800049}}', 1793620800050, NULL, 16);
INSERT INTO public.gnl_run_journal VALUES ('r-done:model:0', 'r-done', 'model', false, '{"json":{"parts":[{"type":"stream-start","warnings":[]},{"type":"tool-call","toolCallId":"call_note","toolName":"note","input":"{\"n\":1}"},{"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}}}],"rest":{},"_v":2}}', 1793620800040, NULL, 14);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000005', NULL, NULL, false, '{"json":{"v":1,"seq":5,"kind":"status","data":{"state":"tool","tool":"note"},"step":0,"at":1793620800054}}', 1793620800055, NULL, 17);
INSERT INTO public.gnl_run_journal VALUES ('r-done:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1793620800058,"reqHash":"44af5e9e57a17745"}}', 1793620800038, NULL, 13);
INSERT INTO public.gnl_run_journal VALUES ('r-done:tool:call_note', 'r-done', 'tool', false, '{"json":{"status":"succeeded","output":{"ok":true},"argsHash":"2bfd14f43d17fc7c","toolName":"note","idempotencyKey":"r-done:call_note","resolvedToolCallIds":["call_note"],"_v":2}}', 1793620800059, NULL, 18);
INSERT INTO public.gnl_run_journal VALUES ('r-done:proc:dup-note-2bfd14f43d17fc7c', NULL, NULL, false, '{"json":{"firstToolCallId":"call_note","at":1794047615452}}', 1793620800061, NULL, 19);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000006', NULL, NULL, false, '{"json":{"v":1,"seq":6,"kind":"tool-result","data":{"toolCallId":"call_note","toolName":"note","input":{"n":1},"output":{"ok":true}},"step":0,"at":1793620800066}}', 1793620800067, NULL, 21);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000007', NULL, NULL, false, '{"json":{"v":1,"seq":7,"kind":"step-finish","data":{"finishReason":"tool-calls","usage":{"inputTokens":10,"inputTokenDetails":{"noCacheTokens":10},"outputTokens":5,"outputTokenDetails":{"textTokens":5},"totalTokens":15}},"step":0,"at":1793620800071}}', 1793620800072, NULL, 22);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000008', NULL, NULL, false, '{"json":{"v":1,"seq":8,"kind":"step-start","data":{},"step":1,"at":1793620800079}}', 1793620800080, NULL, 24);
INSERT INTO public.gnl_run_journal VALUES ('r-done:model:1', 'r-done', 'model', false, '{"json":{"parts":[{"type":"stream-start","warnings":[]},{"type":"text-start","id":"t0"},{"type":"text-delta","id":"t0","delta":"ok"},{"type":"text-end","id":"t0"},{"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}}}],"rest":{},"_v":2}}', 1793620800082, NULL, 25);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000009', NULL, NULL, false, '{"json":{"v":1,"seq":9,"kind":"text-start","data":{"id":"t0"},"step":1,"at":1793620800086}}', 1793620800087, NULL, 26);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000010', NULL, NULL, false, '{"json":{"v":1,"seq":10,"kind":"text","data":{"id":"t0","text":"ok"},"step":1,"at":1793620800092}}', 1793620800093, NULL, 27);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000011', NULL, NULL, false, '{"json":{"v":1,"seq":11,"kind":"text-end","data":{"id":"t0"},"step":1,"at":1793620800098}}', 1793620800099, NULL, 28);
INSERT INTO public.gnl_run_journal VALUES ('r-done:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1793620800100,"reqHash":"1976b1f752c43c7a"}}', 1793620800074, NULL, 23);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000012', NULL, NULL, false, '{"json":{"v":1,"seq":12,"kind":"step-finish","data":{"finishReason":"stop","usage":{"inputTokens":10,"inputTokenDetails":{"noCacheTokens":10},"outputTokens":5,"outputTokenDetails":{"textTokens":5},"totalTokens":15}},"step":1,"at":1793620800104}}', 1793620800105, NULL, 29);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000013', NULL, NULL, false, '{"json":{"v":1,"seq":13,"kind":"finish","data":{"finishReason":"stop","totalUsage":{"inputTokens":20,"inputTokenDetails":{"noCacheTokens":20},"outputTokens":10,"outputTokenDetails":{"textTokens":10},"totalTokens":30}},"step":1,"at":1793620800109}}', 1793620800110, NULL, 30);
INSERT INTO public.gnl_run_journal VALUES ('mem:t-alice-1:messages', NULL, NULL, false, '{"json":{"gnlLog":1,"parts":["{\"json\":[{\"role\":\"user\",\"content\":\"go r-done\"}]}","{\"json\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"tool-call\",\"toolCallId\":\"call_note\",\"toolName\":\"note\",\"input\":{\"n\":1},\"providerExecuted\":null,\"providerOptions\":null}]},{\"role\":\"tool\",\"content\":[{\"type\":\"tool-result\",\"toolCallId\":\"call_note\",\"toolName\":\"note\",\"output\":{\"type\":\"json\",\"value\":{\"ok\":true}}}]},{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\",\"providerOptions\":null}]}],\"meta\":{\"values\":{\"0.content.0.providerExecuted\":[\"undefined\"],\"0.content.0.providerOptions\":[\"undefined\"],\"2.content.0.providerOptions\":[\"undefined\"]},\"v\":1}}"],"appendedAt":[1793620800022,1793620800116],"batches":["mem-user-appended:r-done","mem-appended:r-done"]}}', 1793620800023, NULL, 10);
INSERT INTO public.gnl_run_journal VALUES ('mem-appended:r-done', NULL, NULL, false, '{"json":true}', 1793620800112, NULL, 31);
INSERT INTO public.gnl_run_journal VALUES ('r-done:usage-counted', NULL, NULL, false, '{"json":true}', 1793620800117, NULL, 33);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__done:r-done', NULL, NULL, false, '{"json":{"at":1793620800118}}', 1793620800119, NULL, 34);
INSERT INTO public.gnl_run_journal VALUES ('__metrics__run:r-done', NULL, NULL, false, '{"json":{"runId":"r-done","agentName":"noter","status":"completed","costUsd":0,"totalTokens":30,"modelSteps":2,"toolCalls":1,"startTs":1793620800016,"durationMs":66,"finalizedAt":1794047615484}}', 1793620800120, NULL, 35);
INSERT INTO public.gnl_run_journal VALUES ('r-done:outcome', NULL, NULL, false, '{"json":{"status":"completed","at":1794047615488,"attempt":1794047615388}}', 1793620800014, NULL, 6);
INSERT INTO public.gnl_run_journal VALUES ('r-done:ev:0000000014', NULL, NULL, false, '{"json":{"v":1,"seq":14,"kind":"status","data":{"state":"completed"},"step":1,"at":1793620800125}}', 1793620800126, NULL, 36);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-alice-3:owner', NULL, NULL, false, '{"json":{"at":1793620800129,"resourceId":"alice"}}', 1793620800130, 'alice', 37);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1794047615510,"attempt":1794047615510}}', 1793620800141, NULL, 41);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000001', NULL, NULL, false, '{"json":{"v":1,"seq":1,"kind":"status","data":{"state":"running"},"step":-1,"at":1793620800158}}', 1793620800159, NULL, 47);
INSERT INTO public.gnl_run_journal VALUES ('__exec__:/r-pending#', NULL, NULL, false, '{"json":{"v":1,"runId":"r-pending","owner":"00000000-0000-4000-8000-000000000001","status":"parked","at":1793620800208,"from":0,"meta":{"agent":"payer"}}}', 1793620800135, NULL, 39);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:input', NULL, NULL, false, '{"json":{"at":1793620800143,"prompt":null,"messages":[{"role":"user","content":"go r-pending"}],"system":null,"threadId":"t-alice-3","agent":"payer","resourceId":"alice","hash":"d19c9e0d02f868fc","origin":"host","turn":{"count":1,"token":"00000000-0000-4000-8000-000000000004"},"_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1793620800132, NULL, 38);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-3","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0,"layout":{"v":1,"n":1,"status":"exact","incoming":[0,1],"token":"00000000-0000-4000-8000-000000000004"}}}', 1793620800146, NULL, 43);
INSERT INTO public.gnl_run_journal VALUES ('mem:t-alice-3:messages', NULL, NULL, false, '{"json":{"gnlLog":1,"parts":["{\"json\":[{\"role\":\"user\",\"content\":\"go r-pending\"}]}"],"appendedAt":[1793620800149],"batches":["mem-user-appended:r-pending"]}}', 1793620800150, NULL, 45);
INSERT INTO public.gnl_run_journal VALUES ('mem-user-appended:r-pending', NULL, NULL, false, '{"json":true}', 1793620800148, NULL, 44);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:tool:call_pay', 'r-pending', 'tool', true, '{"json":{"status":"suspended","output":{"__gnl_suspend":{"toolCallId":"call_pay","toolName":"pay","args":{"amt":5},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}},"toolName":"pay","idempotencyKey":"r-pending:call_pay","_v":2}}', 1793620800185, NULL, 53);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000006', NULL, NULL, false, '{"json":{"v":1,"seq":6,"kind":"tool-result","data":{"toolCallId":"call_pay","toolName":"pay","input":{"amt":5},"output":{"__gnl_suspend":{"toolCallId":"call_pay","toolName":"pay","args":{"amt":5},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}}},"step":0,"at":1793620800190}}', 1793620800191, NULL, 54);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000007', NULL, NULL, false, '{"json":{"v":1,"seq":7,"kind":"step-finish","data":{"finishReason":"tool-calls","usage":{"inputTokens":10,"inputTokenDetails":{"noCacheTokens":10},"outputTokens":5,"outputTokenDetails":{"textTokens":5},"totalTokens":15}},"step":0,"at":1793620800195}}', 1793620800196, NULL, 55);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000008', NULL, NULL, false, '{"json":{"v":1,"seq":8,"kind":"finish","data":{"finishReason":"tool-calls","totalUsage":{"inputTokens":10,"inputTokenDetails":{"noCacheTokens":10},"outputTokens":5,"outputTokenDetails":{"textTokens":5},"totalTokens":15}},"step":0,"at":1793620800200}}', 1793620800201, NULL, 56);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000009', NULL, NULL, false, '{"json":{"v":1,"seq":9,"kind":"status","data":{"state":"waiting-approval","interrupts":[{"toolCallId":"call_pay","toolName":"pay","args":{"amt":5},"reason":"''pay'' requires explicit confirmation before it runs.","kind":"confirm"}]},"step":0,"at":1793620800205}}', 1793620800206, NULL, 57);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000003', NULL, NULL, false, '{"json":{"v":1,"seq":3,"kind":"step-start","data":{},"step":0,"at":1793620800269}}', 1793620800270, NULL, 77);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000004', NULL, NULL, false, '{"json":{"v":1,"seq":4,"kind":"tool-call","data":{"toolCallId":"call_note","toolName":"note","input":{"n":3}},"step":0,"at":1793620800275}}', 1793620800276, NULL, 79);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:model:0', 'r-mid-human', 'model', false, '{"json":{"parts":[{"type":"stream-start","warnings":[]},{"type":"tool-call","toolCallId":"call_note","toolName":"note","input":"{\"n\":3}"},{"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}}}],"rest":{},"_v":2}}', 1793620800262, NULL, 75);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000005', NULL, NULL, false, '{"json":{"v":1,"seq":5,"kind":"status","data":{"state":"tool","tool":"note"},"step":0,"at":1793620800283}}', 1793620800284, NULL, 81);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1793620800289,"reqHash":"56a5abc1ce717b5b"}}', 1793620800248, NULL, 72);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000003', NULL, NULL, false, '{"json":{"v":1,"seq":3,"kind":"step-start","data":{},"step":0,"at":1793620800313}}', 1793620800314, NULL, 89);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000004', NULL, NULL, false, '{"json":{"v":1,"seq":4,"kind":"tool-call","data":{"toolCallId":"call_note","toolName":"note","input":{"n":2}},"step":0,"at":1793620800318}}', 1793620800319, NULL, 90);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:model:0', 'r-mid-recover', 'model', false, '{"json":{"parts":[{"type":"stream-start","warnings":[]},{"type":"tool-call","toolCallId":"call_note","toolName":"note","input":"{\"n\":2}"},{"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}}}],"rest":{},"_v":2}}', 1793620800307, NULL, 88);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000005', NULL, NULL, false, '{"json":{"v":1,"seq":5,"kind":"status","data":{"state":"tool","tool":"note"},"step":0,"at":1793620800323}}', 1793620800324, NULL, 91);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1793620800329,"reqHash":"4c3eaf7d7f04310b"}}', 1793620800295, NULL, 84);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000008', NULL, NULL, false, '{"json":{"v":1,"seq":8,"kind":"step-start","data":{},"step":1,"at":1793620800350}}', 1793620800351, NULL, 99);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000009', NULL, NULL, false, '{"json":{"v":1,"seq":9,"kind":"tool-call","data":{"toolCallId":"call_wire","toolName":"wire","input":{"to":"acme"}},"step":1,"at":1793620800356}}', 1793620800357, NULL, 101);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:model:1', 'r-mid-human', 'model', false, '{"json":{"parts":[{"type":"stream-start","warnings":[]},{"type":"tool-call","toolCallId":"call_wire","toolName":"wire","input":"{\"to\":\"acme\"}"},{"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}}}],"rest":{},"_v":2}}', 1793620800345, NULL, 98);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000010', NULL, NULL, false, '{"json":{"v":1,"seq":10,"kind":"status","data":{"state":"tool","tool":"wire"},"step":1,"at":1793620800362}}', 1793620800363, NULL, 102);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1793620800374,"reqHash":"e815ebaeb15ad501"}}', 1793620800342, NULL, 97);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000002', NULL, NULL, false, '{"json":{"v":1,"seq":2,"kind":"start","data":{},"step":-1,"at":1793620800164}}', 1793620800165, NULL, 48);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:proc:__gnl_model_claim:0', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1793620800187,"reqHash":"9ff99121afbc9fd7"}}', 1793620800153, NULL, 46);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-bob-1:owner', NULL, NULL, false, '{"json":{"at":1793620800210,"resourceId":"bob"}}', 1793620800211, 'bob', 58);
INSERT INTO public.gnl_run_journal VALUES ('__exec__:/r-mid-human#', NULL, NULL, false, '{"json":{"v":1,"runId":"r-mid-human","owner":"00000000-0000-4000-8000-000000000001","status":"running","at":1793620800215,"from":0,"meta":{"agent":"twohuman"}}}', 1793620800216, NULL, 60);
INSERT INTO public.gnl_run_journal VALUES ('__hand__:/r-mid-human#00000000-0000-4000-8000-000000000001#', NULL, NULL, false, '{"json":{"what":"the run is executing","at":1793620800220}}', 1793620800221, NULL, 62);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:input', NULL, NULL, false, '{"json":{"at":1793620800231,"prompt":null,"messages":[{"role":"user","content":"go r-mid-human"}],"system":null,"threadId":"t-bob-1","agent":"twohuman","resourceId":"bob","hash":"8ea8a0d3a666b700","origin":"host","turn":{"count":1,"token":"00000000-0000-4000-8000-000000000005"},"_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1793620800213, NULL, 59);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1794047615561,"attempt":1794047615561}}', 1793620800244, NULL, 71);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-alice-2","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0,"layout":{"v":1,"n":1,"status":"exact","incoming":[0,1],"token":"00000000-0000-4000-8000-000000000006"}}}', 1793620800271, NULL, 78);
INSERT INTO public.gnl_run_journal VALUES ('mem:t-alice-2:messages', NULL, NULL, false, '{"json":{"gnlLog":1,"parts":["{\"json\":[{\"role\":\"user\",\"content\":\"go r-mid-recover\"}]}"],"appendedAt":[1793620800286],"batches":["mem-user-appended:r-mid-recover"]}}', 1793620800287, NULL, 82);
INSERT INTO public.gnl_run_journal VALUES ('mem-user-appended:r-mid-recover', NULL, NULL, false, '{"json":true}', 1793620800278, NULL, 80);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:tool:call_note', 'r-mid-recover', 'tool', false, '{"json":{"status":"succeeded","output":{"ok":true},"argsHash":"363379742f80b51b","toolName":"note","idempotencyKey":"r-mid-recover:call_note","resolvedToolCallIds":["call_note"],"_v":2}}', 1793620800328, NULL, 93);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:proc:dup-note-363379742f80b51b', NULL, NULL, false, '{"json":{"firstToolCallId":"call_note","at":1794047615594}}', 1793620800335, NULL, 95);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000006', NULL, NULL, false, '{"json":{"v":1,"seq":6,"kind":"tool-result","data":{"toolCallId":"call_note","toolName":"note","input":{"n":2},"output":{"ok":true}},"step":0,"at":1793620800366}}', 1793620800367, NULL, 103);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000007', NULL, NULL, false, '{"json":{"v":1,"seq":7,"kind":"step-finish","data":{"finishReason":"tool-calls","usage":{"inputTokens":10,"inputTokenDetails":{"noCacheTokens":10},"outputTokens":5,"outputTokenDetails":{"textTokens":5},"totalTokens":15}},"step":0,"at":1793620800371}}', 1793620800372, NULL, 104);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000003', NULL, NULL, false, '{"json":{"v":1,"seq":3,"kind":"step-start","data":{},"step":0,"at":1793620800171}}', 1793620800172, NULL, 50);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000004', NULL, NULL, false, '{"json":{"v":1,"seq":4,"kind":"tool-call","data":{"toolCallId":"call_pay","toolName":"pay","input":{"amt":5}},"step":0,"at":1793620800176}}', 1793620800177, NULL, 51);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:model:0', 'r-pending', 'model', false, '{"json":{"parts":[{"type":"stream-start","warnings":[]},{"type":"tool-call","toolCallId":"call_pay","toolName":"pay","input":"{\"amt\":5}"},{"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}}}],"rest":{},"_v":2}}', 1793620800166, NULL, 49);
INSERT INTO public.gnl_run_journal VALUES ('r-pending:ev:0000000005', NULL, NULL, false, '{"json":{"v":1,"seq":5,"kind":"status","data":{"state":"tool","tool":"pay"},"step":0,"at":1793620800181}}', 1793620800182, NULL, 52);
INSERT INTO public.gnl_run_journal VALUES ('thread:t-alice-2:owner', NULL, NULL, false, '{"json":{"at":1793620800217,"resourceId":"alice"}}', 1793620800218, 'alice', 61);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:outcome', NULL, NULL, false, '{"json":{"status":"running","at":1794047615554,"attempt":1794047615553}}', 1793620800226, NULL, 64);
INSERT INTO public.gnl_run_journal VALUES ('__exec__:/r-mid-recover#', NULL, NULL, false, '{"json":{"v":1,"runId":"r-mid-recover","owner":"00000000-0000-4000-8000-000000000001","status":"running","at":1793620800229,"from":0,"meta":{"agent":"twostep"}}}', 1793620800230, NULL, 65);
INSERT INTO public.gnl_run_journal VALUES ('__hand__:/r-mid-recover#00000000-0000-4000-8000-000000000001#', NULL, NULL, false, '{"json":{"what":"the run is executing","at":1793620800234}}', 1793620800235, NULL, 67);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:memctx', NULL, NULL, false, '{"json":{"v":1,"threadId":"t-bob-1","recalled":[],"recentCount":0,"recent":[],"incomingCount":1,"echoTrimmed":0,"layout":{"v":1,"n":1,"status":"exact","incoming":[0,1],"token":"00000000-0000-4000-8000-000000000005"}}}', 1793620800238, NULL, 68);
INSERT INTO public.gnl_run_journal VALUES ('mem:t-bob-1:messages', NULL, NULL, false, '{"json":{"gnlLog":1,"parts":["{\"json\":[{\"role\":\"user\",\"content\":\"go r-mid-human\"}]}"],"appendedAt":[1793620800242],"batches":["mem-user-appended:r-mid-human"]}}', 1793620800243, NULL, 70);
INSERT INTO public.gnl_run_journal VALUES ('mem-user-appended:r-mid-human', NULL, NULL, false, '{"json":true}', 1793620800240, NULL, 69);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000001', NULL, NULL, false, '{"json":{"v":1,"seq":1,"kind":"status","data":{"state":"running"},"step":-1,"at":1793620800253}}', 1793620800254, NULL, 73);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000002', NULL, NULL, false, '{"json":{"v":1,"seq":2,"kind":"start","data":{},"step":-1,"at":1793620800259}}', 1793620800260, NULL, 74);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:input', NULL, NULL, false, '{"json":{"at":1793620800261,"prompt":null,"messages":[{"role":"user","content":"go r-mid-recover"}],"system":null,"threadId":"t-alice-2","agent":"twostep","resourceId":"alice","hash":"ee66fcd368f55e88","origin":"host","turn":{"count":1,"token":"00000000-0000-4000-8000-000000000006"},"_v":2},"meta":{"values":{"prompt":["undefined"],"system":["undefined"]},"v":1}}', 1793620800224, NULL, 63);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000001', NULL, NULL, false, '{"json":{"v":1,"seq":1,"kind":"status","data":{"state":"running"},"step":-1,"at":1793620800298}}', 1793620800299, NULL, 85);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000002', NULL, NULL, false, '{"json":{"v":1,"seq":2,"kind":"start","data":{},"step":-1,"at":1793620800305}}', 1793620800306, NULL, 87);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:tool:call_note', 'r-mid-human', 'tool', false, '{"json":{"status":"succeeded","output":{"ok":true},"argsHash":"215ddd5567ca2590","toolName":"note","idempotencyKey":"r-mid-human:call_note","resolvedToolCallIds":["call_note"],"_v":2}}', 1793620800288, NULL, 83);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:proc:dup-note-215ddd5567ca2590', NULL, NULL, false, '{"json":{"firstToolCallId":"call_note","at":1794047615586}}', 1793620800300, NULL, 86);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000006', NULL, NULL, false, '{"json":{"v":1,"seq":6,"kind":"tool-result","data":{"toolCallId":"call_note","toolName":"note","input":{"n":3},"output":{"ok":true}},"step":0,"at":1793620800333}}', 1793620800334, NULL, 94);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:ev:0000000007', NULL, NULL, false, '{"json":{"v":1,"seq":7,"kind":"step-finish","data":{"finishReason":"tool-calls","usage":{"inputTokens":10,"inputTokenDetails":{"noCacheTokens":10},"outputTokens":5,"outputTokenDetails":{"textTokens":5},"totalTokens":15}},"step":0,"at":1793620800339}}', 1793620800340, NULL, 96);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:tool:call_wire', 'r-mid-human', 'tool', false, '{"json":{"status":"running","startedAt":1794047615602,"attempts":1,"claimTtlMs":30000,"idempotencyKey":"r-mid-human:call_wire","proc":"00000000-0000-4000-8000-000000000001","hold":"00000000-0000-4000-8000-000000000009","_v":2}}', 1793620800376, NULL, 105);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-human:proc:dup-wire-7e003eb4e7b66994', NULL, NULL, false, '{"json":{"firstToolCallId":"call_wire","at":1794047615606,"inFlight":true,"ttlMs":30000,"proc":"00000000-0000-4000-8000-000000000001","hold":"00000000-0000-4000-8000-000000000009"}}', 1793620800378, NULL, 106);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000008', NULL, NULL, false, '{"json":{"v":1,"seq":8,"kind":"step-start","data":{},"step":1,"at":1793620800386}}', 1793620800387, NULL, 109);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000009', NULL, NULL, false, '{"json":{"v":1,"seq":9,"kind":"tool-call","data":{"toolCallId":"call_charge","toolName":"charge","input":{"amt":9}},"step":1,"at":1793620800391}}', 1793620800392, NULL, 110);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:model:1', 'r-mid-recover', 'model', false, '{"json":{"parts":[{"type":"stream-start","warnings":[]},{"type":"tool-call","toolCallId":"call_charge","toolName":"charge","input":"{\"amt\":9}"},{"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool-calls"},"usage":{"inputTokens":{"total":10,"noCache":10},"outputTokens":{"total":5,"text":5}}}],"rest":{},"_v":2}}', 1793620800382, NULL, 108);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:ev:0000000010', NULL, NULL, false, '{"json":{"v":1,"seq":10,"kind":"status","data":{"state":"tool","tool":"charge"},"step":1,"at":1793620800396}}', 1793620800397, NULL, 111);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:proc:__gnl_model_claim:1', NULL, NULL, false, '{"json":{"status":"succeeded","startedAt":1793620800400,"reqHash":"b45083947948aee2"}}', 1793620800380, NULL, 107);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:tool:call_charge', 'r-mid-recover', 'tool', false, '{"json":{"status":"running","startedAt":1794047615617,"attempts":1,"claimTtlMs":30000,"idempotencyKey":"r-mid-recover:call_charge","proc":"00000000-0000-4000-8000-000000000001","hold":"00000000-0000-4000-8000-00000000000a","_v":2}}', 1793620800401, NULL, 112);
INSERT INTO public.gnl_run_journal VALUES ('r-mid-recover:proc:dup-charge-399d05a933233df8', NULL, NULL, false, '{"json":{"firstToolCallId":"call_charge","at":1794047615619,"inFlight":true,"ttlMs":30000,"proc":"00000000-0000-4000-8000-000000000001","hold":"00000000-0000-4000-8000-00000000000a"}}', 1793620800403, NULL, 113);

INSERT INTO public.gnl_runs VALUES ('r-done', 2, 1, 0, NULL, 'completed', 1793620800006, 1793620800122, 't-alice-1', 'alice');
INSERT INTO public.gnl_runs VALUES ('r-pending', 1, 1, 1, 'running', 'suspended', 1793620800133, 1793620800186, 't-alice-3', 'alice');
INSERT INTO public.gnl_runs VALUES ('r-mid-human', 2, 2, 0, 'running', 'running', 1793620800214, 1793620800377, 't-bob-1', 'bob');
INSERT INTO public.gnl_runs VALUES ('r-mid-recover', 2, 2, 0, 'running', 'running', 1793620800227, 1793620800402, 't-alice-2', 'alice');

SELECT pg_catalog.setval('public.gnl_run_journal_ord', 113, true);

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
