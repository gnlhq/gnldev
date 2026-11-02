// HERMES records and the person boundary. Two gaps, both measured on main before this:
// 1) READ: `lesson:res:<rid>:` is not a person boundary — ids may contain ':' — so `lessons('alice')`
//    returned `alice:evil`'s lessons too, and the injection path put them into alice's system prompt.
// 2) ERASE: `sugg:<id>` is keyed by id, not by person, so erasing alice left her pending suggestion
//    (rule text, evidence naming her runs) listable.
// The rule that tells a person's own lesson key from a longer id's is one (`isOwnLessonRest`, model.ts);
// erasure, the lesson listing and the injection all read it.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { createSuggestions, personalLessonKey, orgLessonKey, suggKey } from '../src/suggestions.js';
import type { LessonRecord, SuggestionRecord } from '../src/suggestions.js';
import { purgeResource } from '../src/retention.js';
import { eraseSubject } from '../src/erase.js';

const lesson = (rid: string, id: string): LessonRecord => ({
  v: 1, id, rule: `rule of ${rid}`, mechanism: 'm', fromSuggestion: id, scope: 'personal', resourceId: rid, at: 1, effectiveEvidence: 1,
});
const orgLesson = (id: string): LessonRecord => ({
  v: 1, id, rule: 'org rule', mechanism: 'm', fromSuggestion: id, scope: 'org', at: 2, effectiveEvidence: 2,
});
const personal = (id: string, rid: string, status: SuggestionRecord['status'] = 'pending'): SuggestionRecord => ({
  v: 1, id, type: 'memory-lesson', scope: 'personal', resourceId: rid, status, rule: `${rid} lives at 5 Elm St`, mechanism: 'm',
  evidence: [{ runId: `r-${id}`, resourceId: rid, at: 1 }], at: 1,
});
const org = (id: string, supporters: string[]): SuggestionRecord => ({
  v: 1, id, type: 'memory-lesson', scope: 'org', status: 'pending', rule: 'org rule', mechanism: 'm',
  evidence: supporters.map((rid, i) => ({ runId: `src-${i}`, sourceSuggestionId: `src-${i}`, resourceId: rid, at: 1 })), at: 1,
});

async function seededLessons() {
  const j = new InMemoryJournal();
  await j.put(personalLessonKey('alice', 's1'), lesson('alice', 's1'));
  await j.put(personalLessonKey('alice:evil', 's2'), lesson('alice:evil', 's2'));
  await j.put(orgLessonKey('o1'), orgLesson('o1'));
  return j;
}

describe('reading lessons stops at the person', () => {
  it("lessons('alice') holds alice's and the org's, never alice:evil's", async () => {
    const api = createSuggestions(await seededLessons(), { generate: false, apply: true });
    expect((await api.lessons('alice')).map((l) => l.resourceId ?? 'org').sort()).toEqual(['alice', 'org']);
  });

  it('the longer id reads its own and not the shorter one', async () => {
    const api = createSuggestions(await seededLessons(), { generate: false, apply: true });
    expect((await api.lessons('alice:evil')).map((l) => l.resourceId ?? 'org').sort()).toEqual(['alice:evil', 'org']);
  });

  it("alice's composed system prompt carries no lesson of alice:evil's", async () => {
    const api = createSuggestions(await seededLessons(), { generate: false, apply: true });
    const { text } = await api.prepareInjection('run-alice', 'alice');
    expect(text).toContain('rule of alice');
    expect(text).not.toContain('rule of alice:evil');
  });
});

describe("erasing a person takes their suggestion records — nobody else's", () => {
  async function seededSuggestions() {
    const s = new InMemoryStorage();
    const j = s.runs;
    await j.put(suggKey('a-pending'), personal('a-pending', 'alice'));
    await j.put(suggKey('a-rejected'), personal('a-rejected', 'alice', 'rejected'));
    await j.put(`${suggKey('a-rejected')}:decision`, { approve: false, at: 1 });
    await j.put(suggKey('evil'), personal('evil', 'alice:evil'));
    await j.put(suggKey('o-shared'), org('o-shared', ['alice', 'bob']));
    await j.put(suggKey('o-alone'), org('o-alone', ['alice']));
    return s;
  }

  it('purgeResource: her personal records go whole (decision side-key too), the sibling id stays', async () => {
    const s = await seededSuggestions();
    await purgeResource(s.runs, 'alice', { outsideOrganizations: true });
    expect(await s.runs.get(suggKey('a-pending'))).toBeUndefined();
    expect(await s.runs.get(suggKey('a-rejected'))).toBeUndefined();
    expect(await s.runs.get(`${suggKey('a-rejected')}:decision`)).toBeUndefined();
    expect((await s.runs.get<SuggestionRecord>(suggKey('evil')))?.resourceId).toBe('alice:evil');
  });

  it("an org promotion keeps bob's testimony and loses hers; one only she supported goes", async () => {
    const s = await seededSuggestions();
    await purgeResource(s.runs, 'alice', { outsideOrganizations: true });
    const shared = await s.runs.get<SuggestionRecord>(suggKey('o-shared'));
    expect(shared?.evidence.map((e) => e.resourceId)).toEqual(['bob']);
    expect(await s.runs.get(suggKey('o-alone'))).toBeUndefined();
  });

  it('the public erasure (eraseSubject) reaches them, and the inbox no longer lists her', async () => {
    const s = await seededSuggestions();
    await eraseSubject(s, 'alice');
    const api = createSuggestions(s.runs, { generate: false, apply: true });
    const listed = await api.list();
    expect(listed.some((r) => r.resourceId === 'alice' || r.evidence.some((e) => e.resourceId === 'alice'))).toBe(false);
    expect(listed.map((r) => r.id).sort()).toEqual(['evil', 'o-shared']);
  });
});
