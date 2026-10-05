// What a trace backend groups by is the RESOURCE's `service.name`. exportRun and liveObservability
// put the name on one span's attributes and gave the provider no resource, so every span arrived as
// `unknown_service:<process>` — the hand-built OTLP payload (otlp.ts) and the metrics payload put it
// on the resource, so the same option meant two things. And exporting a run with no journal entries
// and no outcome reported a completed, OK trace for something that never happened.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { exportRun } from '../src/index.js';
import { liveObservability } from '../src/live.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }) };

describe('service.name is on the resource of every span', () => {
  it('exportRun', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r1', journal, model, prompt: 'hi' } as any);
    const exporter = new InMemorySpanExporter();
    await exportRun(journal as any, 'r1', { exporter, serviceName: 'billing', resourceAttributes: { 'deployment.environment': 'prod' } } as any);
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) {
      expect(s.resource.attributes['service.name']).toBe('billing');
      expect(s.resource.attributes['deployment.environment']).toBe('prod');
      expect(s.attributes['service.name']).toBeUndefined();
      // Merged over the SDK's default resource, not in place of it.
      expect(s.resource.attributes['telemetry.sdk.language']).toBe('nodejs');
      expect(s.resource.attributes['telemetry.sdk.name']).toBe('opentelemetry');
    }
  });
  it('exportRun with no serviceName names the service gnl, as the OTLP and metrics payloads do', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r2', journal, model, prompt: 'hi' } as any);
    const exporter = new InMemorySpanExporter();
    await exportRun(journal as any, 'r2', { exporter });
    for (const s of exporter.getFinishedSpans()) expect(s.resource.attributes['service.name']).toBe('gnl');
  });
  it('liveObservability', async () => {
    const exporter = new InMemorySpanExporter();
    const live = liveObservability({ exporter, serviceName: 'billing' } as any);
    await runDurable(live.instrument({ runId: 'l1', journal: new InMemoryJournal(), model, prompt: 'hi' } as any));
    (live as any).flush?.('l1');
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.resource.attributes['service.name']).toBe('billing');
      expect(s.attributes['service.name']).toBeUndefined();
      expect(s.resource.attributes['telemetry.sdk.language']).toBe('nodejs');
    }
  });
});

describe('a run that does not exist is not exported as a completed one', () => {
  it('no entries and no outcome → refused, naming the run', async () => {
    const exporter = new InMemorySpanExporter();
    await expect(exportRun(new InMemoryJournal() as any, 'never-ran', { exporter })).rejects.toThrow(/never-ran/);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe('the hand-built payloads stay free of the OpenTelemetry SDK', () => {
  it('otlp.ts, metrics.ts and the resource rule they read import no @opentelemetry package', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['otlp.ts', 'metrics.ts', 'resource.ts']) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/from '@opentelemetry\//);
    }
  });
});
