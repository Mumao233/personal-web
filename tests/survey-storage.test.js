import test from "node:test";
import assert from "node:assert/strict";
import { createSurveyStorage, surveyStorageKeys, SURVEY_DRAFT_TTL } from "../src/survey-storage.js";

class MemoryStorage {
  constructor(entries = []) { this.values = new Map(entries); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  duplicate() { return new MemoryStorage(this.values); }
}
class Locks {
  owners = new Set();
  async request(name, options, callback) {
    if (this.owners.has(name)) return callback(null);
    this.owners.add(name);
    try { return await callback({ name }); } finally { this.owners.delete(name); }
  }
}
const survey = { id: "one", title: "问卷", definitionVersion: "definition-1", updatedAt: "revision-1", questions: [{ id: "q", type: "text", title: "问题" }] };
const input = (text, key = "submission-original") => ({ surveySnapshot: survey, answers: { q: text }, submissionKey: key });
const request = (text, key = "submission-original") => ({ surveySnapshot: survey, body: { answers: { q: text }, definitionVersion: survey.definitionVersion, submissionKey: key } });
function setup(overrides = {}) {
  const storage = new MemoryStorage(), locks = new Locks();
  let clock = Date.parse("2026-10-16T00:00:00Z"), counter = 0;
  const controllers = [];
  const disposers = new Map();
  function controller(session = new MemoryStorage(), extra = {}) {
    let dispose;
    const value = createSurveyStorage({ surveyId: "one", storage, session, locks, now: () => clock, randomId: () => `instance-${++counter}`, documentScope: {}, onDocumentDispose: (callback) => { dispose = callback; }, ...overrides, ...extra });
    controllers.push(value);
    disposers.set(value, () => dispose?.());
    return value;
  }
  const closeDocument = async (value) => { await value.release(); disposers.get(value)?.(); await Promise.resolve(); };
  return { storage, locks, controller, closeDocument, setTime: (value) => { clock = value; }, advance: (value) => { clock += value; }, now: () => clock, close: () => Promise.all(controllers.map(closeDocument)) };
}
const stored = (storage) => [...storage.values.entries()].map(([key, value]) => ({ key, value: JSON.parse(value) }));

test("new tabs start empty; a same-tab refresh resumes only its own attempt", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const sessionA = new MemoryStorage();
  const a = fixture.controller(sessionA), b = fixture.controller();
  const initial = await a.initialize();
  await a.saveDraft(input("A"));
  const stateB = await b.initialize();
  assert.equal(stateB.draft, null);
  assert.notEqual(initial.instanceId, stateB.instanceId);
  await b.saveDraft(input("B", "key-b"));
  await fixture.closeDocument(a);
  const refreshed = await fixture.controller(sessionA).initialize();
  assert.equal(refreshed.instanceId, initial.instanceId);
  assert.equal(refreshed.draft.answers.q, "A");
  assert.equal((await b.getState()).draft.answers.q, "B");
  assert.equal((await b.listRecoverable()).length, 1);
});

test("duplicating sessionStorage cannot take an active mutable attempt", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const session = new MemoryStorage(), original = fixture.controller(session);
  const first = await original.initialize();
  await original.saveDraft(input("original"));
  const duplicate = fixture.controller(session.duplicate());
  const second = await duplicate.initialize();
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(second.draft, null);
  await duplicate.saveDraft(input("independent", "key-independent"));
  await assert.rejects(duplicate.restore(first.instanceId), { code: "IN_USE" });
  assert.equal((await original.getState()).draft.answers.q, "original");
});

test("a duplicate document stays independent after the original document left its questionnaire route", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const session = new MemoryStorage(), scope = {};
  const original = fixture.controller(session, { documentScope: scope });
  const first = await original.initialize();
  await original.saveDraft(input("dormant in original document"));
  await original.release(); // Route unmount does not close the document lease.
  const duplicate = fixture.controller(session.duplicate());
  const duplicateState = await duplicate.initialize();
  assert.equal(duplicateState.draft, null);
  assert.notEqual(duplicateState.instanceId, first.instanceId);
  const returned = fixture.controller(session, { documentScope: scope });
  assert.equal((await returned.initialize()).draft.answers.q, "dormant in original document");
});

test("a duplicate document can later resume its own attempt after a route change", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const originalSession = new MemoryStorage(), original = fixture.controller(originalSession);
  await original.initialize(); await original.saveDraft(input("original"));
  const duplicateSession = originalSession.duplicate(), duplicateScope = {};
  const duplicate = fixture.controller(duplicateSession, { documentScope: duplicateScope });
  await duplicate.initialize(); await duplicate.saveDraft(input("duplicate's own", "fresh-key"));
  await duplicate.release();
  const returned = fixture.controller(duplicateSession, { documentScope: duplicateScope });
  assert.equal((await returned.initialize()).draft.answers.q, "duplicate's own");
});

test("explicit restore claims a closed record and preserves the current separate draft", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(), b = fixture.controller();
  const stateA = await a.initialize(), stateB = await b.initialize();
  await a.saveDraft(input("old"));
  await b.saveDraft(input("current", "key-b"));
  await a.release();
  const recovered = await b.restore(stateA.instanceId);
  assert.equal(recovered.draft.answers.q, "old");
  const entries = await b.listRecoverable();
  assert.ok(entries.some((entry) => entry.id === stateB.instanceId && entry.record.answers.q === "current"));
});

test("pending keeps exact body, key and snapshot independently of mutable drafts and caller changes", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(), b = fixture.controller();
  await a.initialize(); await b.initialize();
  await a.saveDraft(input("original"));
  const original = request("original"), expected = JSON.stringify(original.body);
  const pending = await a.freezePending(original);
  original.body.answers.q = "changed by caller";
  pending.body.answers.q = "changed returned copy";
  await a.saveDraft(input("must not overwrite"));
  await b.saveDraft(input("other tab", "other-key"));
  await b.clear();
  const persisted = stored(fixture.storage).find(({ value }) => value.kind === "pending").value;
  assert.equal(persisted.bodyJson, expected);
  assert.equal(JSON.stringify(persisted.body), expected);
  assert.deepEqual(persisted.surveySnapshot, survey);
  await assert.rejects(a.freezePending(request("different")), { code: "PENDING_IMMUTABLE" });
});

test("seven-day expiry applies to ordinary drafts but never pending submissions", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(), b = fixture.controller();
  const stateA = await a.initialize();
  await a.saveDraft(input("draft"));
  const pending = await a.freezePending(request("pending"));
  await a.release();
  fixture.advance(SURVEY_DRAFT_TTL);
  await b.initialize();
  assert.equal(fixture.storage.getItem(surveyStorageKeys("one").draft + stateA.instanceId), null);
  assert.equal((await b.listRecoverable()).find((entry) => entry.id === pending.id).kind, "pending");
  const restored = await b.restore(pending.id);
  assert.equal(restored.pending.body.answers.q, "pending");
});

test("confirmation removes only the selected pending and its own mutable draft", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(), b = fixture.controller();
  await a.initialize(); await b.initialize();
  await a.saveDraft(input("A")); await b.saveDraft(input("B", "B-key"));
  const pendingA = await a.freezePending(request("A")), pendingB = await b.freezePending(request("B", "B-key"));
  await a.confirmPending(pendingA.id);
  await a.saveDraft(input("stale callback"));
  assert.equal((await a.getState()).draft, null);
  assert.ok(fixture.storage.getItem(surveyStorageKeys("one").pending + pendingB.id));
  assert.equal((await b.getState()).pending.body.answers.q, "B");
  await a.clear();
  await a.saveDraft(input("new attempt", "new-key"));
  assert.equal((await a.getState()).draft.answers.q, "new attempt");
});

test("queued stale saves cannot undo freezing, disabling device saving, or confirmation", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(); await a.initialize();
  const earlier = a.saveDraft(input("queued"));
  const frozen = a.freezePending(request("submitted"));
  await earlier;
  const pending = await frozen;
  const stale = a.saveDraft(input("stale"));
  const stopped = a.setMode("memory");
  await Promise.all([stale, stopped]);
  assert.equal((await a.getState()).pending.body.answers.q, "submitted");
  assert.equal(stored(fixture.storage).length, 0);
  await a.confirmPending(pending.id);
  assert.equal((await a.getState()).pending, null);
});

test("no-save mode stores neither answers nor pending in localStorage or sessionStorage", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const session = new MemoryStorage(), a = fixture.controller(session), b = fixture.controller();
  await a.initialize(); await b.initialize();
  await b.saveDraft(input("unrelated"));
  await a.saveDraft(input("private"));
  const pending = await a.freezePending(request("private"));
  await a.setMode("memory");
  assert.equal((await a.getState()).pending.id, pending.id);
  assert.ok(!JSON.stringify([...fixture.storage.values]).includes("private"));
  assert.ok(!JSON.stringify([...session.values]).includes("private"));
  assert.equal(session.getItem(surveyStorageKeys("one").pointer), null);
  assert.equal(stored(fixture.storage).length, 1);
  await a.setMode("device");
  assert.equal(stored(fixture.storage).find(({ value }) => value.kind === "pending").value.body.answers.q, "private");
});

test("legacy draft migration copies complete data before removing its old slot and never auto-restores", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const legacy = { answers: { q: "legacy" }, submissionKey: "old-key", surveySnapshot: survey, definitionVersion: "definition-1", arbitrary: { preserved: true } };
  const raw = JSON.stringify(legacy);
  fixture.storage.setItem("survey-one", raw);
  const a = fixture.controller();
  assert.equal((await a.initialize()).draft, null);
  assert.equal(fixture.storage.getItem("survey-one"), null);
  const entries = await a.listRecoverable();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].record.legacyRaw, raw);
  assert.equal(entries[0].updatedAt, fixture.now());
  const restored = await a.restore(entries[0].id);
  assert.equal(restored.draft.submissionKey, "old-key");
});

test("legacy pending migration preserves original body and remains independent through concurrent initializers", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const original = { answers: { q: "legacy" }, submissionKey: "original-key", definitionVersion: "old-definition" };
  fixture.storage.setItem("survey-one", JSON.stringify({ ...original, pending: true, surveySnapshot: survey }));
  const a = fixture.controller(), b = fixture.controller();
  const states = await Promise.all([a.initialize(), b.initialize()]);
  assert.ok(states.every((state) => state.pending === null));
  const entries = await a.listRecoverable();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].record.body, original);
  const restored = await a.restore(entries[0].id);
  assert.equal(restored.pending.body.submissionKey, "original-key");
  await assert.rejects(b.restore(entries[0].id), { code: "IN_USE" });
});

test("unmappable legacy data stays downloadable and cannot be restored or silently rekeyed", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const raw = JSON.stringify({ answers: { removed: "keep me" }, pending: true, submissionKey: "never-change" });
  fixture.storage.setItem("survey-one", raw);
  const a = fixture.controller(); await a.initialize();
  const [entry] = await a.listRecoverable();
  assert.equal(entry.downloadOnly, true);
  assert.equal(entry.record.legacyRaw, raw);
  await assert.rejects(a.restore(entry.id), { code: "DOWNLOAD_ONLY" });
  fixture.advance(40 * SURVEY_DRAFT_TTL);
  assert.equal((await a.listRecoverable()).length, 1);
});

test("storage write failure retains the legacy source and degrades to memory with a visible limitation", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const raw = JSON.stringify({ ...input("legacy"), pending: false });
  fixture.storage.setItem("survey-one", raw);
  fixture.storage.setItem = () => { throw new Error("quota"); };
  const a = fixture.controller();
  const state = await a.initialize();
  assert.equal(state.mode, "memory");
  assert.ok(state.limitations.some((item) => item.code === "STORAGE_UNAVAILABLE"));
  assert.equal(fixture.storage.getItem("survey-one"), raw);
  await a.saveDraft(input("memory survives"));
  assert.equal((await a.getState()).draft.answers.q, "memory survives");
});

test("without Web Locks copied pointers remain blank and explicit recovery creates independent copies", async (t) => {
  const fixture = setup({ locks: null }); t.after(fixture.close);
  const session = new MemoryStorage(), a = fixture.controller(session);
  await a.initialize(); await a.saveDraft(input("A", "old-a"));
  const b = fixture.controller(session.duplicate());
  const blank = await b.initialize();
  assert.equal(blank.draft, null);
  const fork = await b.restore((await a.getState()).instanceId);
  assert.notEqual(fork.instanceId, (await a.getState()).instanceId);
  assert.notEqual(fork.draft.submissionKey, "old-a");
  await b.saveDraft(input("B", fork.draft.submissionKey));
  assert.equal((await a.getState()).draft.answers.q, "A");
  const pending = await a.freezePending(request("A", "old-a"));
  const refreshed = fixture.controller(session.duplicate());
  const pendingBlank = await refreshed.initialize();
  assert.equal(pendingBlank.pending, null);
  const recovered = await refreshed.restore(pending.id);
  assert.notEqual(recovered.pending.id, pending.id);
  assert.equal(recovered.pending.body.submissionKey, "old-a");
  assert.ok(recovered.limitations.some((item) => item.code === "LOCKS_UNAVAILABLE"));
  await refreshed.confirmPending(recovered.pending.id);
  assert.ok(fixture.storage.getItem(surveyStorageKeys("one").pending + pending.id), "the source pending is not another instance's cleanup target");
});

test("pending and draft deletion requires ownership; no-lock fallback cannot delete another attempt", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(), b = fixture.controller();
  await a.initialize(); await b.initialize();
  const pending = await a.freezePending(request("must survive"));
  await assert.rejects(b.deleteRecovery(pending.id), { code: "IN_USE" });
  const unsupported = fixture.controller(new MemoryStorage(), { locks: null });
  await unsupported.initialize();
  await assert.rejects(unsupported.deleteRecovery(pending.id), { code: "LOCKS_UNAVAILABLE" });
  assert.ok(fixture.storage.getItem(surveyStorageKeys("one").pending + pending.id));
});

test("device deletion failure is surfaced and never reported as successful deletion", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(); await a.initialize(); await a.saveDraft(input("still on disk"));
  fixture.storage.removeItem = () => { throw new Error("blocked"); };
  const state = await a.setMode("memory");
  assert.equal(state.mode, "memory");
  assert.ok(state.limitations.some((item) => item.code === "DELETE_FAILED"));
  assert.ok(JSON.stringify([...fixture.storage.values]).includes("still on disk"));
  await assert.rejects(a.deleteRecovery(state.instanceId), { code: "DELETE_FAILED" });
});

test("server-confirmed cleanup and clear report residual local data when removal fails", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const a = fixture.controller(); await a.initialize(); await a.saveDraft(input("persisted"));
  const pending = await a.freezePending(request("persisted"));
  fixture.storage.removeItem = () => { throw new Error("blocked"); };
  const confirmed = await a.confirmPending(pending.id);
  assert.equal(confirmed.pending, null, "a valid server confirmation is still accepted");
  assert.ok(confirmed.limitations.some((item) => item.code === "DELETE_FAILED" && item.message.includes("服务器已确认")));
  assert.ok(fixture.storage.getItem(surveyStorageKeys("one").pending + pending.id));
  const b = fixture.controller(); await b.initialize();
  await b.saveDraft(input("in-memory"));
  const cleared = await b.clear();
  assert.ok(cleared.limitations.some((item) => item.code === "DELETE_FAILED"));
});

test("refresh follows the exact pending pointer when an older confirmed record could not be deleted", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const session = new MemoryStorage(), a = fixture.controller(session);
  await a.initialize();
  const oldPending = await a.freezePending(request("older accepted", "old-key"));
  const remove = fixture.storage.removeItem.bind(fixture.storage);
  fixture.storage.removeItem = (key) => {
    if (key.endsWith(oldPending.id)) throw new Error("old record cannot be removed");
    remove(key);
  };
  await a.confirmPending(oldPending.id);
  await a.clear();
  await a.setMode("device");
  const latest = await a.freezePending(request("new uncertain", "new-key"));
  await fixture.closeDocument(a);
  const refreshed = await fixture.controller(session).initialize();
  assert.equal(refreshed.pending.id, latest.id);
  assert.equal(refreshed.pending.body.submissionKey, "new-key");
  assert.ok(fixture.storage.getItem(surveyStorageKeys("one").pending + oldPending.id));
});

test("a newer ordinary draft survives refresh and explicit recovery beside an older residual pending", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const session = new MemoryStorage(), a = fixture.controller(session);
  const initial = await a.initialize();
  const oldPending = await a.freezePending(request("older accepted", "old-key"));
  const remove = fixture.storage.removeItem.bind(fixture.storage);
  fixture.storage.removeItem = (key) => {
    if (key.endsWith(oldPending.id)) throw new Error("old record cannot be removed");
    remove(key);
  };
  await a.confirmPending(oldPending.id); await a.clear(); await a.setMode("device");
  await a.saveDraft(input("new draft not submitted", "new-key"));
  await fixture.closeDocument(a);
  const refreshedController = fixture.controller(session);
  const refreshed = await refreshedController.initialize();
  assert.equal(refreshed.pending, null);
  assert.equal(refreshed.draft.answers.q, "new draft not submitted");
  assert.equal(refreshed.draft.submissionKey, "new-key");
  const oldEntry = (await refreshedController.listRecoverable()).find((entry) => entry.id === oldPending.id);
  assert.ok(oldEntry.notice);
  const restoredOlder = await refreshedController.restore(oldPending.id);
  assert.equal(restoredOlder.pending.id, oldPending.id);
  assert.equal(JSON.parse(fixture.storage.getItem(surveyStorageKeys("one").draft + initial.instanceId)).submissionKey, "new-key");
  await refreshedController.release();
  const other = fixture.controller(); await other.initialize();
  assert.ok((await other.listRecoverable()).some((entry) => entry.id === initial.instanceId && entry.kind === "draft"));
  const explicitlyRestored = await other.restore(initial.instanceId);
  assert.equal(explicitlyRestored.pending, null);
  assert.equal(explicitlyRestored.draft.submissionKey, "new-key");
});

test("fallback recovery cannot rotate a known conflicting submission key", async (t) => {
  const fixture = setup({ locks: null }); t.after(fixture.close);
  const source = fixture.controller();
  const initial = await source.initialize();
  await source.saveDraft({ ...input("conflict", "original-conflicting-key"), submissionConflict: true });
  const recovered = fixture.controller(); await recovered.initialize();
  const state = await recovered.restore(initial.instanceId);
  assert.equal(state.draft.submissionKey, "original-conflicting-key");
  assert.equal(state.draft.submissionConflict, true);
});

test("restoring while saving is disabled never creates a persisted answer or pending copy", async (t) => {
  const fixture = setup({ locks: null }); t.after(fixture.close);
  const source = fixture.controller(); await source.initialize();
  const pending = await source.freezePending(request("source"));
  const a = fixture.controller(); await a.initialize(); await a.setMode("memory");
  const before = [...fixture.storage.values];
  const restored = await a.restore(pending.id);
  assert.equal(restored.mode, "memory");
  assert.notEqual(restored.pending.id, pending.id);
  assert.deepEqual([...fixture.storage.values], before);
});

test("pending ownership hides its mutable precursor from the ordinary recovery list", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const source = fixture.controller(), next = fixture.controller();
  const initial = await source.initialize(); await source.saveDraft(input("source"));
  const pending = await source.freezePending(request("source"));
  await source.release(); await next.initialize();
  assert.deepEqual((await next.listRecoverable()).map((entry) => entry.id), [pending.id]);
  await assert.rejects(next.restore(initial.instanceId), { code: "PENDING_EXISTS" });
});

test("deleting a closed pending also deletes only its matching mutable precursor", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const source = fixture.controller(), remover = fixture.controller();
  const initial = await source.initialize();
  await source.saveDraft(input("same attempt", "same-key"));
  const pending = await source.freezePending(request("same attempt", "same-key"));
  await source.release(); await remover.initialize();
  await remover.deleteRecovery(pending.id);
  assert.equal(fixture.storage.getItem(surveyStorageKeys("one").pending + pending.id), null);
  assert.equal(fixture.storage.getItem(surveyStorageKeys("one").draft + initial.instanceId), null);
  assert.equal((await remover.listRecoverable()).length, 0);
});

test("failure to delete a pending precursor retains the pending and reports the failure", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const source = fixture.controller(), remover = fixture.controller();
  const initial = await source.initialize();
  await source.saveDraft(input("same attempt", "same-key"));
  const pending = await source.freezePending(request("same attempt", "same-key"));
  await source.release(); await remover.initialize();
  const remove = fixture.storage.removeItem.bind(fixture.storage);
  fixture.storage.removeItem = (key) => {
    if (key === surveyStorageKeys("one").draft + initial.instanceId) throw new Error("cannot delete draft");
    remove(key);
  };
  await assert.rejects(remover.deleteRecovery(pending.id), { code: "DELETE_FAILED" });
  assert.ok(fixture.storage.getItem(surveyStorageKeys("one").pending + pending.id));
  assert.equal((await remover.listRecoverable()).filter((entry) => entry.kind === "draft").length, 0);
});

test("confirming, deleting, or disabling saving for an older pending preserves a later draft with a different key", async (t) => {
  for (const action of ["confirm", "delete", "memory"]) {
    const fixture = setup(); t.after(fixture.close);
    const source = fixture.controller();
    const initial = await source.initialize();
    const pending = await source.freezePending(request("older", "old-key"));
    const latest = { schema: 2, kind: "draft", id: initial.instanceId, surveyId: "one", createdAt: fixture.now(), updatedAt: fixture.now(), ...input("newer", "new-key") };
    const draftKey = surveyStorageKeys("one").draft + initial.instanceId;
    fixture.storage.setItem(draftKey, JSON.stringify(latest));
    if (action === "confirm") await source.confirmPending(pending.id);
    else if (action === "delete") await source.deleteRecovery(pending.id);
    else await source.setMode("memory");
    assert.deepEqual(JSON.parse(fixture.storage.getItem(draftKey)), latest);
    assert.equal(fixture.storage.getItem(surveyStorageKeys("one").pending + pending.id), null);
  }
});

test("restore and delete barriers discard older queued saves instead of recreating records", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const source = fixture.controller(), a = fixture.controller();
  const original = await source.initialize(); await source.saveDraft(input("restore me")); await source.release();
  await a.initialize();
  const stale = a.saveDraft(input("old queued input"));
  const recovered = a.restore(original.instanceId);
  await stale;
  assert.equal((await recovered).draft.answers.q, "restore me");
  const staleAgain = a.saveDraft(input("old queued input again"));
  const removed = a.deleteRecovery(original.instanceId);
  await Promise.all([staleAgain, removed]);
  assert.equal((await a.getState()).draft, null);
  assert.equal(fixture.storage.getItem(surveyStorageKeys("one").draft + original.instanceId), null);
});

test("without Web Locks legacy migration leaves verified originals intact and preserves their keys", async (t) => {
  const fixture = setup({ locks: null }); t.after(fixture.close);
  const raw = JSON.stringify({ ...input("legacy", "original-legacy-key") });
  fixture.storage.setItem("survey-one", raw);
  const a = fixture.controller(); await a.initialize();
  assert.equal(fixture.storage.getItem("survey-one"), raw);
  const [entry] = await a.listRecoverable();
  const restored = await a.restore(entry.id);
  assert.equal(restored.draft.submissionKey, "original-legacy-key");
  await a.saveDraft(input("legacy edited", restored.draft.submissionKey));
  assert.equal((await a.getState()).draft.migrated, true);
});

test("submission conflict flags persist without changing the original key", async (t) => {
  const fixture = setup(); t.after(fixture.close);
  const session = new MemoryStorage(), a = fixture.controller(session);
  await a.initialize(); await a.saveDraft({ ...input("conflict", "keep-key"), submissionConflict: true });
  await fixture.closeDocument(a);
  const refreshed = await fixture.controller(session).initialize();
  assert.equal(refreshed.draft.submissionConflict, true);
  assert.equal(refreshed.draft.submissionKey, "keep-key");
});
