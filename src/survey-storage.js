// Each editable attempt belongs to one document. Pending POSTs are separate,
// immutable records: draft expiry and unrelated tabs must never remove them.
export const SURVEY_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
export const SURVEY_STORAGE_PREFIX = "personal-space:survey:v2:";
const documentLeases = new WeakMap();

const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const timestamp = (value) => {
  const result = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(result) && result > 0 ? result : null;
};
function browserValue(name) {
  try { return globalThis[name]; } catch { return null; }
}
function uniqueId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function surveyStorageKeys(surveyId) {
  const encoded = encodeURIComponent(surveyId);
  return {
    draft: `${SURVEY_STORAGE_PREFIX}draft:${encoded}:`,
    pending: `${SURVEY_STORAGE_PREFIX}pending:${encoded}:`,
    legacy: `${SURVEY_STORAGE_PREFIX}legacy:${encoded}:`,
    pointer: `${SURVEY_STORAGE_PREFIX}current:${encoded}`,
    old: `survey-${surveyId}`,
    owner: (id) => `${SURVEY_STORAGE_PREFIX}owner:${surveyId}:${id}`,
    migration: `${SURVEY_STORAGE_PREFIX}migration:${surveyId}`,
  };
}

export function createSurveyStorage(options) {
  const { surveyId, now = Date.now, randomId = uniqueId, onStatus } = options;
  if (typeof surveyId !== "string" || !surveyId) throw new TypeError("surveyId is required");
  const storage = "storage" in options ? options.storage : browserValue("localStorage");
  const session = "session" in options ? options.session : browserValue("sessionStorage");
  // A route/controller can unmount while its document remains alive. Keep this
  // lease for the document lifetime so a subsequently duplicated tab cannot
  // inherit dormant questionnaire pointers. Tests inject a scope/disposer;
  // browsers release their Web Locks automatically when a document is gone.
  const documentScope = options.documentScope || browserValue("document") || session || {};
  let locks = "locks" in options ? options.locks : browserValue("navigator")?.locks;
  const keys = surveyStorageKeys(surveyId);
  let state = { instanceId: null, mode: "device", draft: null, pending: null, limitations: [] };
  let initialized = false, closed = false, completed = false, generation = 0, releaseOwner = null, queue = Promise.resolve();
  const snapshot = () => copy(state);
  const notify = () => { try { onStatus?.(snapshot()); } catch { /* UI observers do not control storage. */ } };
  function limit(code, message) {
    if (!state.limitations.some((item) => item.code === code)) state.limitations.push({ code, message });
    notify();
  }
  function storageFailed() {
    state.mode = "memory";
    limit("STORAGE_UNAVAILABLE", "本机保存不可用，当前填写只保留在此页面内存中；刷新或关闭页面后可能丢失。已有本机记录不会被自动删除。");
  }
  function read(key) {
    try { return storage?.getItem(key) ?? null; } catch { storageFailed(); return null; }
  }
  function parsed(key) {
    const raw = read(key);
    try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
  }
  function write(key, value) {
    if (!storage) { storageFailed(); return false; }
    try {
      const raw = JSON.stringify(value);
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw) throw new Error("Storage verification failed");
      return true;
    } catch { storageFailed(); return false; }
  }
  function remove(key, expected) {
    try {
      if (!storage) throw new Error("Storage unavailable");
      if (expected !== undefined) {
        const current = storage.getItem(key);
        if (current === null) return true;
        if (current !== expected) return false;
      }
      storage.removeItem(key);
      return storage.getItem(key) === null;
    } catch { storageFailed(); return false; }
  }
  function pointer(value) {
    try {
      if (!session) throw new Error("Session storage unavailable");
      if (value) session.setItem(keys.pointer, JSON.stringify({ instanceId: value, ...(state.pending ? { pendingId: state.pending.id } : {}) }));
      else session.removeItem(keys.pointer);
    } catch {
      limit("SESSION_UNAVAILABLE", "当前标签页身份无法保存；刷新后请从本机恢复列表中选择自己的记录。");
    }
  }
  function readPointer() {
    try {
      const value = JSON.parse(session?.getItem(keys.pointer) || "null");
      return typeof value?.instanceId === "string" ? value : null;
    } catch { return null; }
  }
  function records() {
    const result = [];
    try {
      if (!storage) throw new Error("Storage unavailable");
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (![keys.draft, keys.pending, keys.legacy].some((prefix) => key?.startsWith(prefix))) continue;
        const value = parsed(key);
        if (value?.schema === 2 && value.surveyId === surveyId && typeof value.id === "string") result.push({ key, value });
      }
    } catch { storageFailed(); }
    return result;
  }
  function noLocks() {
    limit("LOCKS_UNAVAILABLE", "浏览器不支持标签页独占锁，刷新后也需要从恢复列表明确选择记录。恢复时会创建独立副本；无法确认其他标签页归属，不能在这里删除其他记录。");
  }
  async function acquire(name) {
    if (!locks?.request) { noLocks(); return { unsupported: true }; }
    return new Promise((resolve) => {
      let answered = false;
      try {
        Promise.resolve(locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) { answered = true; resolve({ busy: true }); return; }
          let release;
          const held = new Promise((done) => { release = done; });
          answered = true;
          resolve({ release });
          await held;
        })).catch(() => {
          locks = null;
          noLocks();
          if (!answered) resolve({ unsupported: true });
        });
      } catch {
        locks = null;
        noLocks();
        resolve({ unsupported: true });
      }
    });
  }
  async function ensureDocumentLease() {
    let scopes = documentLeases.get(documentScope);
    if (!scopes) { scopes = new Map(); documentLeases.set(documentScope, scopes); }
    if (!scopes.has(session)) scopes.set(session, (async () => {
      const documentKey = `${SURVEY_STORAGE_PREFIX}document`;
      let token = null;
      try { token = session?.getItem(documentKey) || null; } catch { /* Existing pointer will not be trusted without a lease. */ }
      token ||= randomId();
      let held = await acquire(`${SURVEY_STORAGE_PREFIX}document-owner:${token}`);
      if (held.busy) {
        // Only this new document's sessionStorage is cleared. localStorage
        // drafts and the original document's pointers are left untouched.
        const inheritedPointers = new Set();
        let ignorePointers = false;
        try {
          const names = [];
          for (let index = 0; index < session.length; index++) {
            const name = session.key(index);
            if (name?.startsWith(`${SURVEY_STORAGE_PREFIX}current:`)) {
              names.push(name);
              try { inheritedPointers.add(JSON.parse(session.getItem(name))?.instanceId); } catch { /* Invalid pointer is not resumed. */ }
            }
          }
          for (const name of names) session.removeItem(name);
        } catch {
          ignorePointers = true;
          limit("SESSION_UNAVAILABLE", "无法清理新标签页继承的填写指针；本页将作为新的独立填写打开。");
        }
        token = randomId();
        held = await acquire(`${SURVEY_STORAGE_PREFIX}document-owner:${token}`);
        // Even a sessionStorage removal failure cannot let this document use
        // inherited pointers during its first questionnaire initialization.
        try { session?.setItem(documentKey, token); } catch { /* Reported by pointer(). */ }
        const lease = { supported: Boolean(held.release), inheritedPointers, ignorePointers, release: held.release };
        options.onDocumentDispose?.(() => { held.release?.(); scopes.delete(session); });
        return lease;
      }
      try { session?.setItem(documentKey, token); } catch { /* Reported by pointer(). */ }
      const lease = { supported: Boolean(held.release), inheritedPointers: new Set(), ignorePointers: false, release: held.release };
      options.onDocumentDispose?.(() => { held.release?.(); scopes.delete(session); });
      return lease;
    })());
    const lease = await scopes.get(session);
    if (!lease.supported) noLocks();
    return lease;
  }
  const expired = (record) => (record.kind === "draft" || (record.kind === "legacy" && !record.pending)) && now() - (timestamp(record.updatedAt) ?? now()) >= SURVEY_DRAFT_TTL;
  const validSnapshot = (value) => value?.id === surveyId && Array.isArray(value.questions);
  const pendingFor = (instanceId, draft) => records().find(({ value }) => value.kind === "pending" && value.instanceId === instanceId && (!draft || value.body?.submissionKey === draft.submissionKey))?.value || null;

  async function migrateLegacy() {
    const held = await acquire(keys.migration);
    if (held.busy) return;
    try {
      const raw = read(keys.old);
      if (raw === null) return;
      // In fallback browsers keep the source slot. Deduplicate exact copies, but
      // never use an uncoordinated read/delete as a cross-document transaction.
      if (records().some(({ value }) => value.legacyRaw === raw)) return;
      let old;
      try { old = JSON.parse(raw); } catch { old = null; }
      const savedAt = timestamp(old?.updatedAt) ?? timestamp(old?.savedAt) ?? now();
      const instanceId = randomId(), id = randomId();
      const common = { schema: 2, surveyId, createdAt: savedAt, updatedAt: savedAt, legacyRaw: raw, migrated: true };
      let record, destination;
      if (object(old?.answers) && old.pending && typeof old.submissionKey === "string" && old.submissionKey && validSnapshot(old.surveySnapshot)) {
        const body = copy(old.body || { answers: old.answers, definitionVersion: old.definitionVersion, submissionKey: old.submissionKey });
        const safe = object(body) && body.submissionKey === old.submissionKey && object(body.answers);
        if (safe) {
          record = { ...common, kind: "pending", id, instanceId, body, bodyJson: JSON.stringify(body), surveySnapshot: copy(old.surveySnapshot) };
          destination = keys.pending + id;
        }
      } else if (object(old?.answers) && !old.pending && validSnapshot(old.surveySnapshot)) {
        record = { ...common, kind: "draft", id: instanceId, answers: copy(old.answers), surveySnapshot: copy(old.surveySnapshot), submissionKey: old.submissionKey, definitionVersion: old.definitionVersion, revision: old.revision };
        destination = keys.draft + instanceId;
      }
      if (!record) {
        record = { ...common, kind: "legacy", id, pending: Boolean(old?.pending), downloadOnly: true, original: copy(old), reason: "旧记录缺少可安全核对的问卷快照或提交信息，只能下载原始填写副本。" };
        destination = keys.legacy + id;
      }
      if (write(destination, record) && held.release) remove(keys.old, raw);
    } finally { held.release?.(); }
  }
  async function expireDrafts() {
    for (const { key, value } of records()) {
      if (!expired(value)) continue;
      if (value.id === state.instanceId && releaseOwner) { remove(key); continue; }
      const held = await acquire(keys.owner(value.id));
      try {
        if (held.release) {
          const current = parsed(key);
          if (current && expired(current)) remove(key, JSON.stringify(current));
        }
      } finally { held.release?.(); }
    }
  }
  function forkDraft(record) {
    return record ? { ...copy(record), id: state.instanceId, copiedFrom: record.id, submissionKey: record.migrated || record.submissionConflict ? record.submissionKey : randomId() } : null;
  }
  async function chooseNew() {
    releaseOwner?.();
    releaseOwner = null;
    state.instanceId = randomId();
    const held = await acquire(keys.owner(state.instanceId));
    releaseOwner = held.release || null;
    state.draft = null;
    state.pending = null;
    if (state.mode === "device") pointer(state.instanceId);
  }
  async function initializeInternal() {
    if (initialized) return snapshot();
    initialized = true;
    const documentLease = await ensureDocumentLease();
    await migrateLegacy();
    await expireDrafts();
    let previous = documentLease.supported && !documentLease.ignorePointers ? readPointer() : null;
    if (documentLease.inheritedPointers.has(previous?.instanceId)) previous = null;
    if (previous && state.mode === "device") {
      const held = await acquire(keys.owner(previous.instanceId));
      if (held.release) {
        state.instanceId = previous.instanceId;
        releaseOwner = held.release;
        const draft = parsed(keys.draft + previous.instanceId);
        state.draft = draft && !expired(draft) ? draft : null;
        const pointedPending = previous.pendingId ? parsed(keys.pending + previous.pendingId) : null;
        state.pending = pointedPending?.kind === "pending" && pointedPending.surveyId === surveyId && pointedPending.instanceId === previous.instanceId
          ? pointedPending : pendingFor(previous.instanceId, state.draft);
      } else if (held.unsupported) {
        // sessionStorage is copied by Duplicate Tab. Without a real ownership
        // lock there is no reliable way to distinguish that from a reload.
        await chooseNew();
      }
    }
    if (!state.instanceId) await chooseNew();
    notify();
    return snapshot();
  }
  function run(callback) {
    const result = queue.then(async () => {
      if (closed) throw failure("CLOSED", "该填写页面已经关闭。");
      await initializeInternal();
      if (closed) throw failure("CLOSED", "该填写页面已经关闭。");
      return callback();
    });
    queue = result.catch(() => {});
    return result;
  }
  function lookup(id) { return records().find(({ value }) => value.id === id); }
  function removePendingCopy(record) {
    const draftKey = keys.draft + record.instanceId;
    const precursor = parsed(draftKey);
    // A failed cleanup may leave more than one attempt under an old owner.
    // Only this request's mutable precursor belongs to the selected deletion.
    if (precursor?.kind === "draft" && precursor.surveyId === surveyId && precursor.id === record.instanceId && precursor.submissionKey === record.body?.submissionKey) {
      // Delete the precursor first. If that fails, retain the complete pending
      // record instead of exposing an ordinary draft for an uncertain request.
      if (!remove(draftKey, JSON.stringify(precursor))) return false;
    }
    return remove(keys.pending + record.id, JSON.stringify(record));
  }
  async function deleteRecord(entry) {
    if (!entry) return;
    const { key, value } = entry;
    const ownerId = value.kind === "draft" ? value.id : value.instanceId;
    const removeExact = () => {
      if (!(value.kind === "pending" ? removePendingCopy(value) : remove(key, JSON.stringify(value)))) {
        limit("DELETE_FAILED", "本机记录删除未成功，旧填写内容可能仍保留在此设备，请勿将其视为已删除。");
        throw failure("DELETE_FAILED", "本机记录删除未成功，旧填写内容可能仍保留在此设备。");
      }
    };
    if (ownerId === state.instanceId) { removeExact(); return; }
    const held = await acquire(value.kind === "legacy" ? keys.migration : keys.owner(ownerId));
    try {
      if (held.busy) throw failure("IN_USE", "这份填写正在另一个标签页使用，请先关闭该页面。");
      if (held.unsupported) throw failure("LOCKS_UNAVAILABLE", "无法确认其他标签页是否仍在使用此草稿，请在原标签页删除。");
      removeExact();
    } finally { held.release?.(); }
  }
  return {
    initialize: () => run(() => snapshot()),
    getState: () => run(() => snapshot()),
    listRecoverable: () => run(async () => {
      await expireDrafts();
      const all = records();
      const pendingKeys = new Set(all.filter(({ value }) => value.kind === "pending").map(({ value }) => JSON.stringify([value.instanceId, value.body?.submissionKey])));
      return all.filter(({ value }) => !expired(value) && !(value.kind === "draft" && !state.pending && value.id === state.draft?.id) && value.id !== state.pending?.id && !(value.kind === "draft" && pendingKeys.has(JSON.stringify([value.id, value.submissionKey])))).map(({ value }) => ({
        id: value.id, kind: value.kind, updatedAt: value.updatedAt || value.createdAt,
        downloadOnly: value.kind === "legacy" || Boolean(value.downloadOnly), record: copy(value),
        ...(value.kind === "pending" && all.some(({ value: candidate }) => candidate.kind === "draft" && candidate.id === value.instanceId && candidate.submissionKey !== value.body?.submissionKey)
          ? { notice: "这条恢复记录与另一个草稿属于不同提交；确认原提交结果前会继续保留，请分别处理。" } : {}),
      })).sort((a, b) => b.updatedAt - a.updatedAt);
    }),
    restore: (id) => { generation++; return run(async () => {
      if (state.pending) throw failure("PENDING_EXISTS", "请先确认或明确删除当前待确认提交，再恢复其他记录。");
      const entry = lookup(id);
      if (!entry || expired(entry.value)) throw failure("NOT_FOUND", "这份本机记录已不存在或草稿已到期。");
      const record = entry.value;
      if (record.kind === "legacy" || record.downloadOnly) throw failure("DOWNLOAD_ONLY", record.reason || "这份旧记录只能下载，不能安全恢复填写。");
      if (record.kind === "draft" && pendingFor(record.id, record)) throw failure("PENDING_EXISTS", "这份填写已有待确认提交，请选择对应的待确认记录。");
      const ownerId = record.kind === "draft" ? record.id : record.instanceId;
      const sameOwner = ownerId === state.instanceId;
      const held = sameOwner ? { release: releaseOwner } : await acquire(keys.owner(ownerId));
      if (held.busy) throw failure("IN_USE", "这份填写正在另一个标签页使用，请先关闭该页面。");
      if (!sameOwner) releaseOwner?.();
      releaseOwner = held.release || null;
      state.instanceId = held.unsupported ? randomId() : ownerId;
      state.draft = record.kind === "draft" ? (held.unsupported ? forkDraft(record) : copy(record)) : null;
      state.pending = record.kind === "pending" ? (held.unsupported ? { ...copy(record), id: randomId(), instanceId: state.instanceId, copiedFrom: record.id } : copy(record)) : null;
      completed = false;
      if (state.mode === "device") {
        pointer(state.instanceId);
        if (state.draft && held.unsupported) write(keys.draft + state.instanceId, state.draft);
        if (state.pending && held.unsupported) write(keys.pending + state.pending.id, state.pending);
      }
      notify();
      return snapshot();
    }); },
    saveDraft: (input) => {
      const captured = copy(input);
      const capturedGeneration = generation;
      return run(() => {
        if (state.pending || completed || capturedGeneration !== generation) return snapshot();
        const time = now();
        state.draft = {
          schema: 2, kind: "draft", id: state.instanceId, surveyId,
          createdAt: state.draft?.createdAt || time, updatedAt: time,
          answers: captured.answers, surveySnapshot: captured.surveySnapshot,
          submissionKey: captured.submissionKey,
          definitionVersion: captured.definitionVersion ?? captured.surveySnapshot?.definitionVersion,
          revision: captured.revision ?? captured.surveySnapshot?.updatedAt,
          submissionConflict: Boolean(captured.submissionConflict),
          ...(state.draft?.migrated ? { migrated: true, legacyRaw: state.draft.legacyRaw } : {}),
          ...(state.draft?.copiedFrom ? { copiedFrom: state.draft.copiedFrom } : {}),
        };
        if (state.mode === "device") write(keys.draft + state.instanceId, state.draft);
        notify();
        return snapshot();
      });
    },
    freezePending: (input) => {
      const captured = copy(input);
      generation++;
      return run(() => {
        const bodyJson = JSON.stringify(captured.body);
        if (state.pending) {
          if (state.pending.bodyJson !== bodyJson) throw failure("PENDING_IMMUTABLE", "待确认提交的内容和提交标识不能改变，请先确认原提交结果。");
          return copy(state.pending);
        }
        if (!object(captured.body?.answers) || typeof captured.body?.submissionKey !== "string" || !captured.body.submissionKey || !validSnapshot(captured.surveySnapshot))
          throw failure("INVALID_PENDING", "无法保存缺少完整问卷快照或提交标识的待确认提交。");
        const time = now();
        state.pending = { schema: 2, kind: "pending", id: randomId(), instanceId: state.instanceId, surveyId, createdAt: time, updatedAt: time, body: captured.body, bodyJson, surveySnapshot: captured.surveySnapshot };
        if (state.mode === "device") write(keys.pending + state.pending.id, state.pending);
        if (state.mode === "device") pointer(state.instanceId);
        notify();
        return copy(state.pending);
      });
    },
    confirmPending: (id) => { generation++; return run(async () => {
      if (!state.pending || state.pending.id !== id) return snapshot();
      if (!removePendingCopy(state.pending))
        limit("DELETE_FAILED", "服务器已确认答卷保存，但本机恢复记录未能全部清理，设备上可能仍显示旧待确认记录。请勿因此开始重复填写。");
      state.pending = null;
      state.draft = null;
      completed = true;
      if (state.mode === "device") pointer(state.instanceId);
      notify();
      return snapshot();
    }); },
    deleteRecovery: (id) => { generation++; return run(async () => {
      const current = state.pending?.id === id ? state.pending : state.instanceId === id ? state.draft : null;
      const entry = lookup(id) || (current ? { key: (current.kind === "pending" ? keys.pending : keys.draft) + current.id, value: current } : null);
      await deleteRecord(entry);
      if ((current || entry?.value)?.legacyRaw && read(keys.old) !== null)
        limit("LEGACY_SOURCE_REMAINS", "旧版本原始记录仍保留在本机；删除此副本不会删除其他记录。");
      if (state.pending?.id === id) state.pending = null;
      if (state.instanceId === id) state.draft = null;
      notify();
      return snapshot();
    }); },
    setMode: (mode) => { generation++; return run(() => {
      if (!["device", "memory"].includes(mode)) throw new TypeError("Unknown save mode");
      if (mode === "memory") {
        // This method is called after the UI explicitly confirms deleting this
        // attempt's device copies. Keep the exact pending body in memory.
        const removed = state.pending ? removePendingCopy(state.pending) : remove(keys.draft + state.instanceId);
        if (!removed) limit("DELETE_FAILED", "已停止继续写入设备，但旧填写内容未能全部删除，可能仍保留在此设备。当前填写只在内存中继续。");
        if ((state.draft?.legacyRaw || state.pending?.legacyRaw) && read(keys.old) !== null)
          limit("LEGACY_SOURCE_REMAINS", "本次填写已停止设备保存，但旧版本原始记录仍保留在本机，尚未删除。");
        if (state.pending?.copiedFrom || state.draft?.copiedFrom || (state.draft?.migrated && !releaseOwner))
          limit("OTHER_COPIES_REMAIN", "本次填写的设备副本已停止保存；恢复来源等其他历史记录仍保留在本机。");
        pointer(null);
        state.mode = "memory";
      } else {
        state.mode = "device";
        if (state.draft) write(keys.draft + state.instanceId, state.draft);
        if (state.pending) write(keys.pending + state.pending.id, state.pending);
        if (state.mode === "device") pointer(state.instanceId);
      }
      notify();
      return snapshot();
    }); },
    clear: () => { generation++; return run(() => {
      if (!remove(keys.draft + state.instanceId))
        limit("DELETE_FAILED", "当前页答案已清除，但设备上的旧草稿未能删除，可能仍可从本机恢复列表找到。");
      state.draft = null;
      completed = false;
      notify();
      return snapshot();
    }); },
    release: async () => {
      closed = true;
      await queue;
      releaseOwner?.();
      releaseOwner = null;
    },
  };
}
