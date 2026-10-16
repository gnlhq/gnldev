// XID — kanallar-arası normalize İŞ KİMLİĞİ anahtarı (heyet v1 #3).
//
// Sorunun özü anahtar problemiydi, anlam problemi değil: 'TV-42' ile 'tv-42' aynı işin iki
// yazımıdır ve normalize edilince AYNI anahtara düşerler — arama yok, vektör yok, embedder yok;
// tek bir O(1) journal okuması. Böylece "bu iş kimliği daha önce, HERHANGİ BİR KANALDAN yapıldı
// mı?" sorusu sohbet/batch/API/cron ayrımı olmadan cevaplanır.
//
// HEYETİN MİMARİ HÜKMÜ (Hüküm B — tüm hücreleri bağlar): bu kayıt YALNIZ VERİ taşır (kim, hangi
// kanal, ne zaman, hangi runId). "Reddet/sor/atla" kararı buraya GÖMÜLMEZ — karar, okuyanın
// profil hücresinden gelir: aynı kayda headless çarpınca reddeder, assistant çarpınca "bu iş bu
// sabah 03:00 batch'inde yapılmış — yine de yapayım mı?" diye sorar.
//
// Kapsam RESOURCE (kullanıcı): kimliğin sahibi kişidir; kiracı öneki (withOrg) zaten üstünü örter.
// resourceId'siz koşularda XID yazılmaz (sahipsiz kimlik anahtarı, komşu kullanıcının işini
// gölgeleyebilir) — beyanlı araçta bir kez loud-warn edilir, sessiz-inert bırakılmaz.
// GDPR: kişi-silme yüzeyi `purgeResource(journal, resourceId)` — bu aileyi (ve HERMES kişisel
// derslerini) süpürür. purgeThread bu aileye DOKUNMAZ ve thread silinse bile XID işi hatırlar —
// bilinçli: 'başka kanaldan yapılmıştı' hafızasının ömrü konuşmanın değil KİŞİNİN kaydıdır.
//
// WHEN IT IS WRITTEN depends on what the reader's cell does with it. Where it is a DECISION (a
// duplicate policy that refuses or asks), it is claimed in flight before the effect and completed on
// success (`claimXidInFlight` → `writeXid` with `held`): a process that dies after the effect still
// leaves "may have run" behind. Where it is only a warning ('warn', 'off', the args modes), it is
// written after success, best-effort — losing it loses one future warning.
import { argsHash } from './hash.js';
import { normalizeId, extractSemFields, type SemanticIdentity } from './semantic-dup.js';
import type { Journal } from './journal.js';
import { claim } from './journal.js';
import { stampIsLive } from './liveness.js';
import { procStampFor } from './process-liveness.js';

export interface XidRecord {
  v: 1;
  toolName: string;
  /** Normalize kimlik alanları — soru metinleri bunu gösterir ("createOrder · tv-42"). */
  identity: Record<string, string>;
  /** Tutar alanları — kanallar-arası "amounts DIFFER" uyarısının verisi. */
  amounts: Record<string, number>;
  /** İLK tamamlanmış işin adresi (first-wins; soru/rapor hep ilkini gösterir). */
  first: { runId: string; toolCallId: string; at: number; channel?: string };
  /**
   * The work is RUNNING (or its process stopped mid-flight): claimed before the effect where the id is a
   * decision (see `claimXidInFlight`). Read by another call as "may have run", never as nothing.
   */
  inFlight?: true;
  /** The claim TTL of the attempt holding an in-flight id: its liveness is judged by it (liveness.ts). */
  ttlMs?: number;
  /** The process holding an in-flight id (process-liveness.ts): judged by that process before the TTL. */
  proc?: string;
  /** The attempt holding an in-flight id (liveness.ts): live in the process that holds it. */
  hold?: string;
  /** An in-flight claim given back by a call that failed before its effect: stands for no record. */
  released?: true;
}

/** The in-flight id one call holds: its key and the value it last wrote (every later write is a CAS over it). */
export interface XidHeld { key: string; claimed: XidRecord }

/** Kimlik değerleri ':' içerebilir; anahtar sınırını bozmasın diye hash'lenir — düz metin kayıtta durur. */
export const xidKey = (resourceId: string, toolName: string, identity: Record<string, string>): string =>
  `xid:res:${resourceId}:${toolName}:${argsHash(identity)}`;

export interface XidPlan {
  resourceId: string;
  toolName: string;
  identity: Record<string, string>;
  amounts: Record<string, number>;
  channel?: string;
}

/** Araç beyanından plan kur — semanticIdentity.keys AYNEN yeniden kullanılır (yeni beyan yok):
 *  kimliği zaten beyan etmiş araç, kanallar-arası korumayı bedavaya alır. */
export function xidPlanOf(id: SemanticIdentity, toolName: string, args: unknown, resourceId: string, channel?: string): XidPlan {
  const fields = extractSemFields(id, args);
  const identity: Record<string, string> = {};
  for (const k of id.keys) identity[k] = normalizeId(fields.identity[k]);
  return { resourceId, toolName, identity, amounts: fields.amounts, channel };
}

/** Başarı choke-point'inden çağrılır — first-wins, best-effort (kayıp bir XID yalnız bir gelecek
 *  uyarısı kaybettirir; işin kendisine asla dokunmaz).
 *
 *  `held`: the in-flight id this call claimed before its effect — completed by compare-and-set over it,
 *  and ONLY over it. Gone means erased (or taken over past the window): an erased id is not written back.
 *  Without `held` (the modes where the id is only a warning, or a call that ran without holding it): the
 *  first-wins write as before, which also takes a released slot over. */
export async function writeXid(journal: Journal, plan: XidPlan, runId: string, toolCallId: string, held?: XidHeld): Promise<void> {
  try {
    const rec: XidRecord = {
      v: 1,
      toolName: plan.toolName,
      identity: plan.identity,
      amounts: plan.amounts,
      first: { runId, toolCallId, at: journal.now ? await journal.now() : Date.now(), ...(plan.channel ? { channel: plan.channel } : {}) },
    };
    const key = xidKey(plan.resourceId, plan.toolName, plan.identity);
    if (held) { await casXid(journal, held.key, held.claimed, rec); return; }
    if (await claim(journal, key, rec)) return;
    const cur = await journal.get<XidRecord>(key);
    // A released slot, or this call's own in-flight id (a recovered attempt that holds none) — completed.
    const mine = cur?.inFlight === true && cur.first?.runId === runId && cur.first?.toolCallId === toolCallId;
    if (cur && (cur.released === true || mine)) await casXid(journal, key, cur, rec);
  } catch { /* best-effort */ }
}

/** Compare-and-set over `expected`; the single-process fallback compares the fields that identify a claim. */
async function casXid(journal: Journal, key: string, expected: XidRecord, next: XidRecord): Promise<boolean> {
  if (journal.putIfMatch) return journal.putIfMatch(key, expected, next);
  // Single-process fallback — the same documented bound as claim().
  const cur = await journal.get<XidRecord>(key);
  if (!(cur && cur.inFlight === expected.inFlight && cur.released === expected.released &&
    cur.first?.runId === expected.first.runId && cur.first?.toolCallId === expected.first.toolCallId && cur.first?.at === expected.first.at)) return false;
  await journal.put(key, next);
  return true;
}

/**
 * Claims the cross-channel id IN FLIGHT, before the effect — where the id is a DECISION (a duplicate
 * policy that refuses or asks). Written only after success, a process that died in the body or between
 * the call's `succeeded` record and the id left nothing, and the same work from another channel ran
 * again (measured: paid twice under the headless preset's 'block'). The same lifecycle as the duplicate
 * marker (durable-tool.ts claimDupMarker):
 *
 *  - absent → first writer wins;
 *  - released (a call that failed before its effect gave it back) → taken over by CAS;
 *  - in flight and STALE by the shared clock and its holder's own TTL → taken over only by the call that
 *    left it (same run, same toolCallId). For any other call it is work that may have run, and may have SUCCEEDED;
 *  - past the dedup window (`windowTtlMs`), completed or stale → no longer a duplicate of anything.
 *
 * Lost: `cur` is what stands there (live or stale in flight, or completed) — the caller decides.
 */
export async function claimXidInFlight(
  journal: Journal, plan: XidPlan, runId: string, toolCallId: string, staleTtlMs: number, windowTtlMs?: number, hold?: string,
): Promise<{ won: true; held: XidHeld } | { won: false; cur: XidRecord }> {
  const key = xidKey(plan.resourceId, plan.toolName, plan.identity);
  const now = journal.now ? await journal.now() : Date.now();
  const claimed: XidRecord = {
    v: 1, toolName: plan.toolName, identity: plan.identity, amounts: plan.amounts,
    first: { runId, toolCallId, at: now, ...(plan.channel ? { channel: plan.channel } : {}) },
    inFlight: true, ttlMs: staleTtlMs, ...procStampFor(journal), ...(hold ? { hold } : {}),
  };
  // A lost write is read again and judged again, never answered with "nothing there": two calls taking
  // the same released slot over at once must not both come away free to run. Bounded: a row that reads
  // as absent yet refuses an insert (a `put(key, undefined)` leftover) fails the call before its effect,
  // loudly, rather than spinning or running unguarded.
  for (let round = 0; round < 16; round++) {
    const cur = await journal.get<XidRecord>(key);
    if (cur === undefined) {
      if (await claim(journal, key, claimed)) return { won: true, held: { key, claimed } };
      continue;
    }
    const at = cur.first?.at ?? 0;
    const stale = cur.inFlight === true && !(await stampIsLive(at, cur.ttlMs ?? staleTtlMs, now, cur, journal));
    const windowExpired = windowTtlMs !== undefined && cur.released !== true && (cur.inFlight !== true || stale) && now - at > windowTtlMs;
    const own = cur.first?.runId === runId && cur.first?.toolCallId === toolCallId;
    const takeable = cur.released === true || windowExpired || (stale && own);
    if (!takeable) return { won: false, cur };
    if (await casXid(journal, key, cur, claimed)) return { won: true, held: { key, claimed } };
  }
  throw new Error(`@gnldev/durable: the cross-channel id ${key} kept changing under this call and could not be claimed — the call did not run`);
}

/** Re-dates the in-flight id this call holds (CAS over the value it last wrote); false when it is no longer that value. */
export async function renewXid(journal: Journal, held: XidHeld): Promise<boolean> {
  const renewed: XidRecord = { ...held.claimed, first: { ...held.claimed.first, at: journal.now ? await journal.now() : Date.now() } };
  if (!(await casXid(journal, held.key, held.claimed, renewed))) return false;
  held.claimed = renewed;
  return true;
}

/**
 * Gives the in-flight id back — by CAS over the value this call wrote, so an id another call took over
 * (or an erasure removed) is never touched. A slot, not a deletion: a row left behind by `put(undefined)`
 * would make `putIfAbsent` lose forever (the duplicate marker's measured poison pill). The released value
 * keeps only what erasure needs to recognise it as this person's (`toolName`), not the identity values.
 */
export async function releaseXid(journal: Journal, held: XidHeld): Promise<void> {
  const at = journal.now ? await journal.now() : Date.now();
  const released: XidRecord = {
    v: 1, toolName: held.claimed.toolName, identity: {}, amounts: {},
    first: { runId: held.claimed.first.runId, toolCallId: held.claimed.first.toolCallId, at }, released: true,
  };
  await casXid(journal, held.key, held.claimed, released);
}

/**
 * A replayed call whose `succeeded` record stands, finishing the id its process left in flight (it died
 * between the record and the id). Only an id still in flight AND this call's own is completed (CAS): an
 * absent one is not created here — absent after a claim means erased, and a replay must not write a
 * person's data back. Best-effort: an in-flight id left as it is still reads as "may have run".
 */
export async function completeOwnXid(journal: Journal, plan: XidPlan, runId: string, toolCallId: string): Promise<void> {
  try {
    const key = xidKey(plan.resourceId, plan.toolName, plan.identity);
    const cur = await journal.get<XidRecord>(key);
    if (!cur || cur.inFlight !== true || cur.first?.runId !== runId || cur.first?.toolCallId !== toolCallId) return;
    await writeXid(journal, plan, runId, toolCallId, { key, claimed: cur });
  } catch { /* best-effort */ }
}

/** Kapıdaki nokta okuma — fail-open: okunamayan kayıt "yok" sayılır (soru sorulamaz, iş asla bloklanmaz). */
export async function readXid(journal: Journal, plan: XidPlan): Promise<XidRecord | undefined> {
  try {
    const rec = await journal.get<XidRecord>(xidKey(plan.resourceId, plan.toolName, plan.identity));
    // A released slot stands for no record. An in-flight one is returned with its flag: the reader says
    // "started, may have run", never "completed".
    return rec && rec.v === 1 && rec.released !== true ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** Kanallar-arası tutar kıyası — confirm süslemesi ve batch preflight'ı AYNI mantığı kullanır
 *  (kopya = drift; denetçi uygulama listesi). Sayısal olmayan/eksik taraf 'farklı' sayılmaz. */
export function amountsDifferOf(rec: XidRecord, args: unknown): string[] {
  return Object.keys(rec.amounts).filter((k) => {
    const mine = Number((args as Record<string, unknown> | null | undefined)?.[k]);
    return Number.isFinite(mine) && rec.amounts[k] !== mine;
  });
}

/** Soru/rapor metinleri için insan-okur özet: "5 dk önce, sohbetten". */
export function xidWhen(rec: XidRecord, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - rec.first.at);
  const mins = Math.round(ageMs / 60_000);
  const age = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return rec.first.channel ? `${age}, via ${rec.first.channel}` : age;
}
