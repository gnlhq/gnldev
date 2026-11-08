// d25 madde 20 (KARAR-5, A): semanticIdentity dizi/nesne alanı — tip koruyan, SIRASIZ karşılaştırma.
// Tek sahip: normalizeId (semantic-dup.ts). Şartname dışarıdan: aynı kalemler başka sırada = aynı iş (soru),
// farklı kalem/adet = farklı iş (soru yok), "1" ile 1 aynı değil, tanım/çağrı anında dizi artık reddedilmiyor.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { normalizeId, identityUnusableReason, extractSemFields } from '../src/semantic-dup.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

/** Same person, two DIFFERENT threads (another channel); first/second call take different args. */
async function twoCalls(keys: string[], first: unknown, second: unknown) {
  const ran: number[] = [];
  const journal = new InMemoryJournal();
  let n = 0;
  const model = createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0
    ? toolCallResult('createOrder', 'c' + Math.random().toString(36).slice(2), n++ === 0 ? first : second)
    : finalTextResult('done'));
  const gnl = createGnl({
    journal, preset: 'assistant',
    agents: { shop: { model, tools: { createOrder: { sideEffect: true, effectClass: 'transactional',
      semanticIdentity: { keys }, inputSchema: z.any(), execute: async () => { ran.push(1); return { ok: true }; } } } } as any },
  } as any);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const r1: any = await gnl.run('shop', { runId: 'm1', threadId: 'T1', resourceId: 'u', prompt: 'order' } as any);
  const r2: any = await gnl.run('shop', { runId: 'm2', threadId: 'T2', resourceId: 'u', prompt: 'order' } as any);
  const incs = await Promise.all((await journal.listKeys('')).filter((k) => k.includes('incident')).map((k) => journal.get(k)));
  return { ran: ran.length, asked: (r2.interrupts ?? []).length, r1, incidents: JSON.stringify(incs) };
}
const A2 = { sku: 'A', qty: 2 }, B1 = { sku: 'B', qty: 1 };

describe('d25/20 — dizi alanı: aynı iş', () => {
  it('aynı kalemler AYNI sırada: soru gelir', async () => {
    expect(await twoCalls(['items'], { items: [A2, B1] }, { items: [A2, B1] })).toMatchObject({ ran: 1, asked: 1 });
  });
  it('aynı kalemler FARKLI sırada: aynı iş, soru gelir', async () => {
    expect(await twoCalls(['items'], { items: [A2, B1] }, { items: [B1, A2] })).toMatchObject({ ran: 1, asked: 1 });
  });
  it('kalem içi alan adı sırası ({qty,sku} vs {sku,qty}) önemsiz: soru gelir', async () => {
    expect(await twoCalls(['items'], { items: [A2, B1] }, { items: [{ qty: 1, sku: 'B' }, { qty: 2, sku: 'A' }] })).toMatchObject({ ran: 1, asked: 1 });
  });
  it('yaprak metin normalizasyonu bugünkü gibi (büyük/küçük harf, kırpma): soru gelir', async () => {
    expect(await twoCalls(['items'], { items: [{ sku: 'ABC-1', qty: 1 }] }, { items: [{ sku: '  abc-1 ', qty: 1 }] })).toMatchObject({ ran: 1, asked: 1 });
  });
  it('düz metin dizisi başka sırada: soru gelir', async () => {
    expect(await twoCalls(['skus'], { skus: ['a', 'b', 'c'] }, { skus: ['c', 'a', 'b'] })).toMatchObject({ ran: 1, asked: 1 });
  });
  it('nesne alanı (anahtar sırası farklı): soru gelir', async () => {
    expect(await twoCalls(['ship'], { ship: { city: 'Izmir', zip: '35000' } }, { ship: { zip: '35000', city: 'Izmir' } })).toMatchObject({ ran: 1, asked: 1 });
  });
});

describe('d25/20 — dizi alanı: farklı iş (negatif, soru YOK)', () => {
  it('farklı kalem (sku)', async () => {
    expect(await twoCalls(['items'], { items: [A2, B1] }, { items: [A2, { sku: 'C', qty: 1 }] })).toMatchObject({ ran: 2, asked: 0 });
  });
  it('aynı kalem, farklı adet (qty)', async () => {
    expect(await twoCalls(['items'], { items: [A2, B1] }, { items: [A2, { sku: 'B', qty: 3 }] })).toMatchObject({ ran: 2, asked: 0 });
  });
  it('fazladan kalem / eksik kalem', async () => {
    expect(await twoCalls(['items'], { items: [A2, B1] }, { items: [A2, B1, { sku: 'C', qty: 1 }] })).toMatchObject({ ran: 2, asked: 0 });
    expect(await twoCalls(['items'], { items: [A2, B1] }, { items: [A2] })).toMatchObject({ ran: 2, asked: 0 });
  });
  it('tekrar eden kalem sayısı (çoklu küme): [A,A,B] != [A,B,B]', async () => {
    const A = { sku: 'A', qty: 1 }, B = { sku: 'B', qty: 1 };
    expect(await twoCalls(['items'], { items: [A, A, B] }, { items: [A, B, B] })).toMatchObject({ ran: 2, asked: 0 });
  });
  it('nesne alanı: farklı değer', async () => {
    expect(await twoCalls(['ship'], { ship: { city: 'Izmir', zip: '35000' } }, { ship: { city: 'Izmir', zip: '06000' } })).toMatchObject({ ran: 2, asked: 0 });
  });
  it('tip koruma uçtan uca: [1,2] ile ["1","2"] farklı iş, soru yok', async () => {
    expect(await twoCalls(['ids'], { ids: [1, 2] }, { ids: ['1', '2'] })).toMatchObject({ ran: 2, asked: 0 });
  });
  it('tip koruma uçtan uca: kalem içinde qty:1 ile qty:"1" farklı iş', async () => {
    expect(await twoCalls(['items'], { items: [{ sku: 'A', qty: 1 }] }, { items: [{ sku: 'A', qty: '1' }] })).toMatchObject({ ran: 2, asked: 0 });
  });
});

describe('d25/20 — tanım/çağrı anında dizi/nesne artık reddedilmiyor', () => {
  it('createGnl dizi alanı beyan eden aracı kabul eder', () => {
    expect(() => createGnl({ journal: new InMemoryJournal(), preset: 'assistant',
      agents: { s: { model: createMockModel(async () => finalTextResult('x')), tools: { t: { sideEffect: true, effectClass: 'transactional',
        semanticIdentity: { keys: ['items'] }, inputSchema: z.any(), execute: async () => 1 } } } as any } } as any)).not.toThrow();
  });
  it('identityUnusableReason dizi ve nesne için undefined döner', () => {
    expect(identityUnusableReason({ keys: ['items'] } as never, { items: [A2, B1] })).toBeUndefined();
    expect(identityUnusableReason({ keys: ['items'] } as never, { items: [1, 2] })).toBeUndefined();
    expect(identityUnusableReason({ keys: ['ship'] } as never, { ship: { city: 'x' } })).toBeUndefined();
  });
  it('çağrıda "identity-unusable" incident yazılmaz', async () => {
    const o = await twoCalls(['items'], { items: [A2, B1] }, { items: [B1, A2] });
    expect(o.incidents).not.toContain('identity-unusable');
  });
  it('değere bağlı ret sürer: fonksiyon ve geçersiz tarih hâlâ kullanılamaz', () => {
    expect(identityUnusableReason({ keys: ['x'] } as never, { x: () => 1 })).toBeDefined();
    expect(identityUnusableReason({ keys: ['x'] } as never, { x: new Date('nope') })).toBeDefined();
  });
});

describe('d25/20 — tek sahip normalizeId (birim)', () => {
  it('sırasız + tip koruyan', () => {
    expect(normalizeId([A2, B1])).toBe(normalizeId([B1, A2]));
    expect(normalizeId({ a: 1, b: 2 })).toBe(normalizeId({ b: 2, a: 1 }));
    expect(normalizeId([1, 2])).not.toBe(normalizeId(['1', '2']));
    expect(normalizeId([A2])).not.toBe(normalizeId([{ sku: 'A', qty: 3 }]));
    expect(normalizeId([A2, A2])).not.toBe(normalizeId([A2]));
  });
  it('skaler anahtarlar DEĞİŞMEZ (eski kayıtlar geçerli)', () => {
    expect(normalizeId('  ABC-1 ')).toBe('abc-1');
    expect(normalizeId(5)).toBe('5');
    expect(normalizeId(undefined)).toBe('');
    expect(normalizeId(null)).toBe('');
    expect(normalizeId(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01t00:00:00.000z');
  });
  it('extractSemFields dizi alanını normalizeId ile üretir (iki sıra aynı kimlik)', () => {
    const f1 = extractSemFields({ keys: ['items'] } as never, { items: [A2, B1] });
    const f2 = extractSemFields({ keys: ['items'] } as never, { items: [B1, A2] });
    expect(f1.identity).toEqual(f2.identity);
    expect(f1.identity.items).not.toBe('');
  });
});
