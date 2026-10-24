# Çekirdekten tam framework'e

[English](./CORE-TO-FRAMEWORK.md) · **Türkçe**

GNL tam bir agent framework'ü ve her parçası tek bir dayanıklı çekirdeğin üstünde duruyor. Mevcut
agent'ının içinde sadece çekirdekle başlayabilir, gerisini adım adım alabilirsin. Aşağıdaki her adım bir
öncekinin verdiğini korur ve üstüne ekler; hiçbiri agent'ını yeniden yazmanı istemez.

| Adım | Eklediğin | Kazandığın |
|---|---|---|
| 1. Çekirdek | `generateText` yerine `runDurable` | bir araç çağrısı asla iki kez çalışmaz; çöken koşu kaldığı yerden devam eder |
| 2. Kayıt | `createGnl` | adıyla ajanlar, senin kimliğinle adlanan iş (`workKey`), çağıranından uzun yaşayan koşular, onaylar |
| 3. Sunucu | `createRestApi` | her ajan için REST + OpenAPI + SSE, yetkilendirme, limitler, bütçeler |
| 4. Studio | `createStudioApp` | her koşu bir zaman çizelgesinde, zamanda yolculuk ve fork, onay kuyruğu, playground |
| 5. Paketler | ihtiyacın olan | bellek, iş akışları, RAG, değerlendirme, MCP, kuyruk, zamanlayıcı, kanallar — her biri çekirdeğin garantileriyle |

## 1. Çekirdek — mevcut agent'ının içinde

Argümanlar `generateText`'inkiler; eklenen tek şey bu işin kimliği ve bir journal.

```ts
import { runDurable, gnlTool } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const storage = new SqliteStorage('runs.db');

const refund = gnlTool(
  tool({
    description: 'Refund an order',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => ({ refunded: orderId }),
  }),
  { sideEffect: true, idempotency: 'args' },
);

const res = await runDurable({
  runId: 'refund-order-42',          // BU işin kimliği — çökme sonrası aynısıyla tekrar çağır
  journal: storage.runs,
  model: openai('gpt-4o'),
  tools: { refund },
  prompt: 'Refund order 42',
});
console.log(res.text);
```

Tam olarak neyi garanti ettiği — ve nerede durduğu: ["asla iki kez" ne demek](../packages/durable/README.md#what-never-charged-twice-actually-means).

## 2. Kayıt — adıyla ajanlar, senin kimliğinle iş

Ajanı bir kez adlandır; her işi kendi kimliğinle (bir sipariş, bir talep) adlandır, motor koşuyu ondan
türetsin. Koşu artık onu başlatan çağrıdan ayrı yürür: kapanan bir sekme ya da kopan bir bağlantı okumayı
bitirir, koşuyu değil.

```ts
import { createGnl } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { openai } from '@ai-sdk/openai';

const storage = new SqliteStorage('runs.db');
const config = {
  storage,
  agents: {
    support: { model: openai('gpt-4o'), system: 'You handle refunds. Ask before you refund.', tools: {} },
  },
};
const gnl = createGnl(config);

const r = await gnl.run('support', { workKey: 'order-42', prompt: 'Refund order 42', resourceId: 'customer-7' });
console.log(r.text);
```

Devamı: [iş kimliği](../packages/durable/README.md#work-identity-workkey) ·
[koşu çağıranından uzun yaşar](../packages/durable/README.md#a-run-outlives-its-caller-creategnl).

## 3. Sunucu — her ajan HTTP üstünden

Aynı `config` OpenAPI ve server-sent events'li bir REST API olur. Üretimde yetkilendirme olmadan açılmayı
reddeder.

```ts
import { createRestApi } from '@gnldev/server';
import { roleAuth } from '@gnldev/auth';
import { serve } from '@hono/node-server';

declare const config: Parameters<typeof createRestApi>[0]; // 2. adımdaki nesne

const api = createRestApi(config, {
  title: 'Support agents',
  auth: roleAuth({ client: { token: process.env.GNL_CLIENT_TOKEN } }),
});
serve({ fetch: api.fetch, port: 3000 }); // POST /agents/support/run, /agents/support/stream, /openapi.json
```

Express, Fastify, Koa ya da Next.js'te: [bir Node sunucusuna bağlamak](../packages/server/README.md#binding-it-to-a-node-server).

## 4. Studio — izle, onayla, zamanda geri git

Studio aynı journal'ı okur: her koşu bir zaman çizelgesinde, onay bekleyen çağrılar, zamanda yolculuk ve
fork, ve kayıtlı ajanlarını çalıştıran bir playground.

```bash
npx gnl studio --config gnl.config.ts   # Studio + config'indeki ajanlar için playground
```

Kendi sunucuna bağlamak için: [`@gnldev/studio`](../packages/studio/README.md).

## 5. Paketler — ihtiyacın olanı al

Her paket diğerleriyle birlikte de tek başına da çalışır; eklediği bir araç ya da adım çekirdeğinki gibi
journal'a yazılır: çökme sonrası yeniden oynatılır, asla iki kez çalışmaz.

| İhtiyaç | Paket |
|---|---|
| Konuşma geçmişi, çalışma belleği, hatırlama | [`@gnldev/memory`](../packages/memory/README.md) |
| Yeniden denemeli çok adımlı süreçler | [`@gnldev/workflow`](../packages/workflow/README.md) |
| Belgelerinden cevaplar | [`@gnldev/rag`](../packages/rag/README.md) |
| Ölçülen kalite, CI'da bir kapı | [`@gnldev/evals`](../packages/evals/README.md) |
| MCP üstünden dış araçlar | [`@gnldev/mcp`](../packages/mcp/README.md) |
| Arka plan işleri, zamanlamalar, olaylar | [`@gnldev/queue`](../packages/queue/README.md) · [`@gnldev/scheduler`](../packages/scheduler/README.md) · [`@gnldev/events`](../packages/events/README.md) |
| Slack ve Telegram'da ajanlar | [`@gnldev/channels`](../packages/channels/README.md) |
| Tipli istemci ve React hook'ları | [`@gnldev/client`](../packages/client/README.md) |

Sıfırdan başlıyorsan: `npm create gnl@latest my-agent` 2.–4. adımları tek seferde kurar.
