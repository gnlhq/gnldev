/** A tool-result part's output as the tool returned it (`{ type: 'json' | 'text', value }` → value). */
export function unwrapOutput(o: any): unknown {
  if (o && typeof o === 'object' && 'type' in o && 'value' in o && (o.type === 'json' || o.type === 'text')) return o.value;
  return o;
}
