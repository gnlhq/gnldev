// The one answer to "which service is this, and what else describes the process", for every payload
// this package emits — the SDK spans (exportRun, liveObservability), the hand-built OTLP traces and
// the metrics. They each built it themselves: the SDK paths put `service.name` on one span's
// attributes and left the resource empty (every span arrived as `unknown_service:<process>`, which
// is what a backend groups by), the OTLP path wrote no name unless one was given, and the metrics path
// let `resourceAttributes` override `serviceName` while the OTLP path did the opposite.
//
// SDK-free on purpose: otlp.ts and metrics.ts (the `./metrics` entry) build their payloads by hand
// with no OpenTelemetry SDK, and they read this rule. The SDK `Resource` built from it lives in
// sdk-resource.ts, imported only by the SDK paths.

import { refuseUnknownNames } from '@gnldev/options';
import { SERVICE_RESOURCE_ATTRIBUTES_NAMES } from './option-names.js';
export type ResourceAttributeValue = string | number | boolean;

export interface ServiceResourceOptions {
  /** `service.name`. Wins over a `service.name` in `resourceAttributes`; default `'gnl'`. */
  serviceName?: string;
  /** More resource attributes (`deployment.environment`, …). */
  resourceAttributes?: Record<string, ResourceAttributeValue>;
}

/** The resource attributes: `resourceAttributes`, then `extra`, then `service.name` by the rule above. */
export function serviceResourceAttributes(opts: ServiceResourceOptions, extra: Record<string, ResourceAttributeValue> = {}): Record<string, ResourceAttributeValue> {
  refuseUnknownNames('serviceResourceAttributes', opts, SERVICE_RESOURCE_ATTRIBUTES_NAMES);
  const named = opts.resourceAttributes?.['service.name'];
  return { ...(opts.resourceAttributes ?? {}), ...extra, 'service.name': opts.serviceName ?? (named !== undefined ? named : 'gnl') };
}

/**
 * The resource half of a larger options bag: what an exporter hands serviceResource / serviceResourceAttributes,
 * which take these two names only.
 */
export function resourceOptionsOf(opts: ServiceResourceOptions): ServiceResourceOptions {
  return { serviceName: opts.serviceName, resourceAttributes: opts.resourceAttributes };
}
