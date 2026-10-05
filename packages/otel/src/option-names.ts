// The names of every options object @gnldev/otel reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const EXPORT_RUN_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').exportRun>[2]>>()(['exporter', 'endpoint', 'pricing', 'modelId', 'serviceName', 'resourceAttributes', 'redact']);
export const TO_OTLP_JSON_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./otlp.js').toOtlpJson>[1]>>()(['runId', 'serviceName', 'resourceAttributes', 'now']);
export const EXPORT_RUN_TO_OTLP_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./otlp.js').exportRunToOtlp>[2]>>()(['endpoint', 'headers', 'serviceName', 'resourceAttributes', 'now', 'retry', 'timeoutMs']);
export const TO_OTLP_METRICS_JSON_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./metrics.js').toOtlpMetricsJson>[1]>>()(['serviceName', 'orgId', 'resourceAttributes', 'now', 'startTime']);
export const LANGFUSE_NAMES = optionNames<NonNullable<Parameters<typeof import('./presets.js').langfuse>[0]>>()(['publicKey', 'secretKey', 'region', 'baseUrl', 'endpoint', 'serviceName', 'resourceAttributes']);
export const API_KEY_OTLP_NAMES = optionNames<NonNullable<Parameters<typeof import('./presets.js').apiKeyOtlp>[0]>>()(['endpoint', 'apiKey', 'project', 'projectHeader', 'serviceName', 'resourceAttributes']);
export const BRAINTRUST_NAMES = optionNames<NonNullable<Parameters<typeof import('./presets.js').braintrust>[0]>>()(['apiKey', 'project', 'endpoint', 'serviceName', 'resourceAttributes']);
export const HONEYCOMB_NAMES = optionNames<NonNullable<Parameters<typeof import('./presets.js').honeycomb>[0]>>()(['apiKey', 'dataset', 'endpoint', 'serviceName', 'resourceAttributes']);
export const DATADOG_AGENT_NAMES = optionNames<NonNullable<Parameters<typeof import('./presets.js').datadogAgent>[0]>>()(['host', 'port', 'endpoint', 'serviceName', 'resourceAttributes']);
export const COLLECTOR_NAMES = optionNames<NonNullable<Parameters<typeof import('./presets.js').collector>[0]>>()(['baseUrl', 'headers', 'endpoint', 'serviceName', 'resourceAttributes']);
export const SERVICE_RESOURCE_ATTRIBUTES_NAMES = optionNames<NonNullable<Parameters<typeof import('./resource.js').serviceResourceAttributes>[0]>>()(['serviceName', 'resourceAttributes']);
export const SERVICE_RESOURCE_NAMES = optionNames<NonNullable<Parameters<typeof import('./sdk-resource.js').serviceResource>[0]>>()(['serviceName', 'resourceAttributes']);
export const LIVE_OBSERVABILITY_NAMES = optionNames<import('./live.js').LiveObservabilityOptions>()(['exporter', 'endpoint', 'pricing', 'serviceName', 'resourceAttributes', 'sampleRate', 'onCost', 'maxPendingRuns']);
export const OTLP_RETRY_NAMES = optionNames<import('./otlp.js').OtlpRetryOptions>()(['attempts', 'backoffMs', 'retryOn']);
