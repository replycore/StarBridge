import { __name } from "./helpers.js";
import { baseName } from "./catalog.js";

// Upstream model-list change review (item 9): models that vanish
// from a provider's list are staged, never silently deleted.
// Pure functions over the review object
// {pending, ignored, added} (stored as plain JSON in KV, see
// store.js loadSyncReview/saveSyncReview). The sync path in
// discovery.js owns the catalog mutations; these functions only
// decide what the review says and return the action to take.

// Pending is capped at 500: when staging would overflow it, the
// oldest unprotected entries are auto-confirmed (returned as
// `evict`, for the caller to delete from the catalog). Protected
// entries are never evicted for the cap — if every pending entry
// is protected the list may exceed the cap (only reachable by
// hand-building hundreds of protected entries).
export var SYNC_REVIEW_MAX_PENDING = 500;
export var SYNC_REVIEW_MAX_ADDED = 200;
// Unprotected pending removals auto-confirm after 7 days.
export var SYNC_REVIEW_AUTO_CONFIRM_MS = 7 * 24 * 36e5;

export function emptySyncReview() {
  return { pending: [], ignored: [], added: [] };
}
__name(emptySyncReview, "emptySyncReview");

// Normalize a stored (or incoming) review onto the canonical
// shape, dropping malformed entries instead of throwing: a
// corrupt KV value must load as an empty-ish review, never fail
// the sync. `change` is always "removed" in v1.
export function normalizeSyncReview(raw) {
  const out = { pending: [], ignored: [], added: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return out;
  if (Array.isArray(raw.pending)) {
    for (const e of raw.pending) {
      if (!e || typeof e !== "object")
        continue;
      const provider = typeof e.provider === "string" ? e.provider.trim() : "";
      const model = typeof e.model === "string" ? e.model.trim() : "";
      const firstSeenAt = Number(e.firstSeenAt);
      if (!provider || !model || !Number.isFinite(firstSeenAt) || firstSeenAt <= 0)
        continue;
      const entry = {
        provider,
        model,
        change: "removed",
        firstSeenAt: Math.floor(firstSeenAt),
        misses: Number.isFinite(Number(e.misses)) && Number(e.misses) > 0 ? Math.floor(Number(e.misses)) : 2
      };
      if (Array.isArray(e.protectedBy)) {
        const pb = [...new Set(e.protectedBy.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))];
        if (pb.length)
          entry.protectedBy = pb;
      }
      out.pending.push(entry);
    }
  }
  if (Array.isArray(raw.ignored)) {
    const seen = /* @__PURE__ */ new Set();
    for (const e of raw.ignored) {
      if (!e || typeof e !== "object")
        continue;
      const provider = typeof e.provider === "string" ? e.provider.trim() : "";
      const pattern = typeof e.pattern === "string" ? e.pattern.trim() : "";
      if (!provider || !pattern)
        continue;
      if (pattern.startsWith("regex:")) {
        try {
          new RegExp(pattern.slice(6), "i");
        } catch {
          continue;
        }
      }
      const key = provider + "\n" + pattern;
      if (seen.has(key))
        continue;
      seen.add(key);
      out.ignored.push({ provider, pattern });
    }
  }
  if (Array.isArray(raw.added)) {
    for (const e of raw.added) {
      if (!e || typeof e !== "object")
        continue;
      const provider = typeof e.provider === "string" ? e.provider.trim() : "";
      const model = typeof e.model === "string" ? e.model.trim() : "";
      const firstSeenAt = Number(e.firstSeenAt);
      if (!provider || !model || !Number.isFinite(firstSeenAt) || firstSeenAt <= 0)
        continue;
      out.added.push({ provider, model, firstSeenAt: Math.floor(firstSeenAt) });
    }
  }
  return out;
}
__name(normalizeSyncReview, "normalizeSyncReview");

// Validate one ignore pattern (exact model id, or "regex:..."
// with a compilable pattern). Throws Error (Chinese message) so
// the admin POST maps it to a 400 like the other normalizers.
export function normalizeSyncReviewPattern(pattern) {
  if (typeof pattern !== "string" || !pattern.trim())
    throw new Error("忽略 pattern 须为非空字符串（精确模型 id，或 regex: 前缀的正则）");
  const p = pattern.trim();
  if (p.length > 200)
    throw new Error("忽略 pattern 过长（≤200 字符）");
  if (p.startsWith("regex:")) {
    const src = p.slice(6);
    if (!src)
      throw new Error("regex: 后须带正则表达式");
    try {
      new RegExp(src, "i");
    } catch {
      throw new Error(`忽略 pattern 的正则不合法：${src}`);
    }
  }
  return p;
}
__name(normalizeSyncReviewPattern, "normalizeSyncReviewPattern");

export function matchesIgnored(review, provider, model) {
  for (const ig of review?.ignored ?? []) {
    if (ig.provider !== provider)
      continue;
    const pat = ig.pattern;
    if (typeof pat !== "string")
      continue;
    if (pat.startsWith("regex:")) {
      try {
        if (new RegExp(pat.slice(6), "i").test(model))
          return true;
      } catch {
        continue;
      }
    } else if (pat === model) {
      return true;
    }
  }
  return false;
}
__name(matchesIgnored, "matchesIgnored");

// Protection (never auto-confirmed): (1) the model is a value in
// any provider's modelMapping (compared lowercase, with the
// baseName fallback the runtime walk uses — a mapped name may
// carry an effort suffix); (2) the model is matched by a
// custom-group keyword (case-insensitive substring, same match
// as buildCustomGroup). Returns e.g. ["mapping:pid",
// "custom-group:id"] (empty when unprotected).
export function computeProtectedBy(providers, customGroups, model) {
  const out = [];
  const m = String(model ?? "").toLowerCase();
  if (!m)
    return out;
  for (const p of providers ?? []) {
    const vals = Object.values(p?.modelMapping ?? {});
    if (vals.some((v) => typeof v === "string" && (v.toLowerCase() === m || baseName(v).toLowerCase() === m)))
      out.push("mapping:" + p.id);
  }
  for (const g of customGroups ?? []) {
    const ks = (g?.keywords ?? []).map((k) => String(k).toLowerCase()).filter(Boolean);
    if (ks.some((k) => m.includes(k)))
      out.push("custom-group:" + g.id);
  }
  return out;
}
__name(computeProtectedBy, "computeProtectedBy");

// Stage one removal. Callers invoke this only at misses >= 2
// (the 2-miss grace is unchanged — staging happens at the second
// miss, not the first). Returns:
//   {action: "stage"} — keep the catalog entry (caller stamps
//     staleSince on it), pending entry upserted (firstSeenAt kept
//     from an existing entry; protectedBy recomputed).
//   {action: "delete"} — the model matches the ignore list, so
//     the deletion takes effect now instead of staging.
//   {action: "keep"} — misses < 2 (defensive; callers check first).
// `evict` lists pending entries dropped to respect the 500 cap
// (oldest unprotected first); the caller deletes those from the
// catalog too — auto-confirming them is what keeps the queue
// bounded. The review object is mutated in place; the caller
// persists it (saveSyncReview) once per sync.
export function stageRemoval(review, { provider, model, misses, now, protectedBy }) {
  if (!review || typeof review !== "object")
    return { action: "keep", evict: [] };
  if (!Array.isArray(review.pending))
    review.pending = [];
  if (!Array.isArray(review.ignored))
    review.ignored = [];
  if (!(misses >= 2))
    return { action: "keep", evict: [] };
  if (matchesIgnored(review, provider, model)) {
    clearPending(review, provider, model);
    return { action: "delete", evict: [] };
  }
  const t = now ?? Date.now();
  const existing = review.pending.find((e) => e.provider === provider && e.model === model);
  if (existing) {
    existing.misses = misses;
    existing.firstSeenAt = existing.firstSeenAt ?? t;
    if (protectedBy?.length)
      existing.protectedBy = [...protectedBy];
    else
      delete existing.protectedBy;
  } else {
    const entry = { provider, model, change: "removed", firstSeenAt: t, misses };
    if (protectedBy?.length)
      entry.protectedBy = [...protectedBy];
    review.pending.push(entry);
  }
  // Cap the queue: auto-confirm the oldest unprotected entries
  // (they leave `pending` here; the caller deletes them from the
  // catalog). Protected entries are never evicted for the cap.
  const evict = [];
  if (review.pending.length > SYNC_REVIEW_MAX_PENDING) {
    const ordered = [...review.pending]
      .filter((e) => !e.protectedBy?.length)
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    for (const e of ordered) {
      if (review.pending.length <= SYNC_REVIEW_MAX_PENDING)
        break;
      review.pending = review.pending.filter((x) => x !== e);
      evict.push({ provider: e.provider, model: e.model });
    }
  }
  return { action: "stage", evict };
}
__name(stageRemoval, "stageRemoval");

// A reappearing model clears its pending entry (and the caller
// clears staleSince on the catalog entry). Returns true when an
// entry was removed.
export function clearPending(review, provider, model) {
  if (!review || !Array.isArray(review.pending))
    return false;
  const before = review.pending.length;
  review.pending = review.pending.filter((e) => !(e.provider === provider && e.model === model));
  return review.pending.length !== before;
}
__name(clearPending, "clearPending");

// Informational only: an addition auto-enters the catalog, and a
// short recent-additions list is kept for display. Capped at 200
// (oldest dropped); never blocks anything.
export function recordAdded(review, provider, model, now) {
  if (!review || typeof review !== "object")
    return;
  if (!Array.isArray(review.added))
    review.added = [];
  const t = now ?? Date.now();
  if (review.added.some((e) => e.provider === provider && e.model === model))
    return;
  review.added.push({ provider, model, firstSeenAt: t });
  if (review.added.length > SYNC_REVIEW_MAX_ADDED)
    review.added = review.added.slice(review.added.length - SYNC_REVIEW_MAX_ADDED);
}
__name(recordAdded, "recordAdded");

// 7-day auto-confirm (decision 3): unprotected pending entries
// whose firstSeenAt is over 7 days old are confirmed — removed
// from `pending` here, and the caller deletes them from the
// catalog. Protected entries never auto-confirm. Returns the
// confirmed entries (empty when nothing is due).
export function autoConfirmExpired(review, now) {
  if (!review || !Array.isArray(review.pending))
    return [];
  const t = now ?? Date.now();
  const due = review.pending.filter(
    (e) => !e.protectedBy?.length && t - e.firstSeenAt > SYNC_REVIEW_AUTO_CONFIRM_MS
  );
  if (!due.length)
    return [];
  const dueSet = new Set(due);
  review.pending = review.pending.filter((e) => !dueSet.has(e));
  return due.map((e) => ({ provider: e.provider, model: e.model }));
}
__name(autoConfirmExpired, "autoConfirmExpired");
