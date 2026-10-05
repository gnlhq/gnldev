// Every options object @gnldev/otel reads refuses a name it does not take (@gnldev/options), naming the
// option it is closest to: a misspelled `redact` would export a run's raw content to the collector.
import { describe, it, expect } from 'vitest';
import { liveObservability } from '../src/live.js';
import { exportRun, toOtlpJson, exportRunToOtlp, toOtlpMetricsJson, langfuse, apiKeyOtlp, braintrust, honeycomb, datadogAgent, collector, serviceResourceAttributes, serviceResource } from '../src/index.js';

const reader: any = { readRun: async () => [], listRuns: async () => [] };

describe('@gnldev/otel: a misspelled option is refused', () => {
  it.each([
    ['exportRun', () => exportRun(reader, 'r', { redcat: true } as any), /exportRun: `redcat` .* did you mean `redact`\?/],
    ['toOtlpJson', () => toOtlpJson([], { serviceNme: 's' } as any), /toOtlpJson: `serviceNme` .* did you mean `serviceName`\?/],
    ['exportRunToOtlp', () => exportRunToOtlp(reader, 'r', { endpoint: 'http://x', timeoutMS: 5 } as any), /exportRunToOtlp: `timeoutMS` .* did you mean `timeoutMs`\?/],
    ['toOtlpMetricsJson', () => toOtlpMetricsJson({} as any, { orgID: 'a' } as any), /toOtlpMetricsJson: `orgID` .* did you mean `orgId`\?/],
    ['langfuse', () => langfuse({ publicKey: 'p', secretKey: 's', regoin: 'eu' } as any), /langfuse: `regoin` .* did you mean `region`\?/],
    ['apiKeyOtlp', () => apiKeyOtlp({ endpoint: 'e', apikey: 'k' } as any), /apiKeyOtlp: `apikey` .* did you mean `apiKey`\?/],
    ['braintrust', () => braintrust({ apiKey: 'k', projct: 'p' } as any), /braintrust: `projct` .* did you mean `project`\?/],
    ['honeycomb', () => honeycomb({ apiKey: 'k', dataSet: 'd' } as any), /honeycomb: `dataSet` .* did you mean `dataset`\?/],
    ['datadogAgent', () => datadogAgent({ hots: 'h' } as any), /datadogAgent: `hots` .* did you mean `host`\?/],
    ['collector', () => collector({ baseURL: 'b' } as any), /collector: `baseURL` .* did you mean `baseUrl`\?/],
    ['serviceResourceAttributes', () => serviceResourceAttributes({ servicename: 's' } as any), /serviceResourceAttributes: `servicename` .* did you mean `serviceName`\?/],
    ['liveObservability', () => liveObservability({ sampleRte: 0.5 } as any), /liveObservability: `sampleRte` .* did you mean `sampleRate`\?/],
    ['exportRunToOtlp retry', () => exportRunToOtlp(reader, 'r', { endpoint: 'http://x', retry: { attempt: 3 } } as any), /exportRunToOtlp: retry: `attempt` .* did you mean `attempts`\?/],
    ['serviceResource', () => serviceResource({ resourceAttribute: {} } as any), /serviceResource: `resourceAttribute` .* did you mean `resourceAttributes`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
