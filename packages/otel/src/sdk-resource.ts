// The SDK `Resource` for exportRun and liveObservability, built from the one attribute rule in
// resource.ts. Kept out of resource.ts so the hand-built payloads stay free of the OpenTelemetry SDK.
import { defaultResource, resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { serviceResourceAttributes, type ServiceResourceOptions } from './resource.js';
import { refuseUnknownNames } from '@gnldev/options';
import { SERVICE_RESOURCE_NAMES } from './option-names.js';

/**
 * The same attributes as an OpenTelemetry SDK `Resource`, for a tracer provider — merged over the
 * SDK's default resource, which is what a provider given no resource uses. Replacing it instead
 * dropped `telemetry.sdk.language`/`name`/`version`, which the semantic conventions require of every
 * SDK-produced resource. The hand-built payloads (otlp.ts, metrics.ts) take only the attributes: no
 * SDK produced them, so they do not claim one.
 */
export function serviceResource(opts: ServiceResourceOptions): Resource {
  refuseUnknownNames('serviceResource', opts, SERVICE_RESOURCE_NAMES);
  return defaultResource().merge(resourceFromAttributes(serviceResourceAttributes(opts)));
}
