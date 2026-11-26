import { __name } from "./helpers.js";

// Rewrite operations a provider's paramOverrides rules may use.
// `when` conditions use a separate, smaller op set (validated in
// config.js). v1 paths are dot paths with numeric indices only —
// no wildcards.
export var OVERRIDE_OPS = new Set([
  "delete", "set", "move", "copy",
  "prepend", "append",
  "trim_prefix", "trim_suffix", "ensure_prefix", "ensure_suffix",
  "trim_space", "to_lower", "to_upper",
  "replace", "regex_replace",
  "set_header", "delete_header"
]);
// Auth headers a rewrite rule may never touch — enforced here at
// runtime (a hand-edited provider record must not be able to break
// authentication) as well as at save time in config.js. A blocked
// header op is silently skipped, never thrown.
export var BLOCKED_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key"]);

function segsOf(path) {
  return String(path).split(".");
}
__name(segsOf, "segsOf");
function isIndex(seg) {
  return /^\d+$/.test(seg);
}
__name(isIndex, "isIndex");
// Resolve a dot path: {found, value}. A numeric segment indexes
// an array; any other segment keys an object. A missing key, an
// out-of-range index, or a non-container in the way all mean
// "not found" — never a throw.
function getAt(root, segs) {
  let cur = root;
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      if (!isIndex(seg))
        return { found: false };
      const i = Number(seg);
      if (i >= cur.length)
        return { found: false };
      cur = cur[i];
    } else if (cur && typeof cur === "object") {
      if (!Object.hasOwn(cur, seg))
        return { found: false };
      cur = cur[seg];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}
__name(getAt, "getAt");
// Set a dot path. With create=true (the `set` op) missing
// intermediate containers are created (an array when the next
// segment is numeric, an object otherwise); without it the path
// must already exist. An array index equal to the length appends;
// anything further out of range, or a primitive in the way,
// fails silently (returns false).
function setAt(root, segs, value, create) {
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = segs[i + 1];
    if (Array.isArray(cur)) {
      if (!isIndex(seg))
        return false;
      const idx = Number(seg);
      if (idx >= cur.length)
        return false;
      if (cur[idx] == null) {
        if (!create)
          return false;
        cur[idx] = isIndex(next) ? [] : {};
      } else if (typeof cur[idx] !== "object") {
        return false;
      }
      cur = cur[idx];
    } else if (cur && typeof cur === "object") {
      if (cur[seg] == null) {
        if (!create)
          return false;
        cur[seg] = isIndex(next) ? [] : {};
      } else if (typeof cur[seg] !== "object") {
        return false;
      }
      cur = cur[seg];
    } else {
      return false;
    }
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(cur)) {
    if (!isIndex(last))
      return false;
    const idx = Number(last);
    if (idx > cur.length)
      return false;
    cur[idx] = value;
    return true;
  }
  if (cur && typeof cur === "object") {
    cur[last] = value;
    return true;
  }
  return false;
}
__name(setAt, "setAt");
// Delete a dot path. Array elements are spliced out; object keys
// are deleted. A missing path silently does nothing (false).
function deleteAt(root, segs) {
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (Array.isArray(cur)) {
      if (!isIndex(seg))
        return false;
      const idx = Number(seg);
      if (idx >= cur.length)
        return false;
      cur = cur[idx];
    } else if (cur && typeof cur === "object") {
      if (!Object.hasOwn(cur, seg))
        return false;
      cur = cur[seg];
    } else {
      return false;
    }
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(cur)) {
    if (!isIndex(last))
      return false;
    const idx = Number(last);
    if (idx >= cur.length)
      return false;
    cur.splice(idx, 1);
    return true;
  }
  if (cur && typeof cur === "object") {
    if (!Object.hasOwn(cur, last))
      return false;
    delete cur[last];
    return true;
  }
  return false;
}
__name(deleteAt, "deleteAt");
function clone(v) {
  if (v == null || typeof v !== "object")
    return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}
__name(clone, "clone");
function deepEqual(a, b) {
  if (a === b)
    return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
__name(deepEqual, "deepEqual");
// A rule's optional `when` condition, evaluated against the body
// as it stands when the rule runs. A missing path never matches
// (except through invert). Regex conditions that fail to compile
// at runtime — validation should have caught them — do not match.
function whenSatisfied(body, when) {
  if (when == null)
    return true;
  const { found, value: actual } = getAt(body, segsOf(when.path));
  let ok = false;
  if (found) {
    switch (when.op) {
      case "eq":
        ok = deepEqual(actual, when.value);
        break;
      case "contains":
        if (typeof actual === "string" && typeof when.value === "string")
          ok = actual.includes(when.value);
        else if (Array.isArray(actual))
          ok = actual.some((item) => deepEqual(item, when.value));
        break;
      case "regex":
        if (typeof actual === "string" && typeof when.value === "string") {
          try {
            ok = new RegExp(when.value).test(actual);
          } catch {
            ok = false;
          }
        }
        break;
      case "gt":
        ok = typeof actual === "number" && typeof when.value === "number" && actual > when.value;
        break;
      case "lt":
        ok = typeof actual === "number" && typeof when.value === "number" && actual < when.value;
        break;
      default:
        ok = false;
    }
  }
  return when.invert === true ? !ok : ok;
}
__name(whenSatisfied, "whenSatisfied");
function headerKey(headers, name) {
  const lower = name.toLowerCase();
  if (headers && typeof headers === "object") {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower)
        return k;
    }
  }
  return null;
}
__name(headerKey, "headerKey");
function applyHeaderOp(headers, rule) {
  if (!headers || typeof headers !== "object")
    return;
  const name = String(rule.path ?? "").trim();
  if (!name || BLOCKED_HEADERS.has(name.toLowerCase()))
    return;
  // A Headers instance (set/delete methods) or a plain object.
  if (typeof headers.set === "function" && typeof headers.delete === "function") {
    if (rule.op === "set_header") {
      if (typeof rule.value === "string")
        headers.set(name, rule.value);
    } else {
      headers.delete(name);
    }
    return;
  }
  if (rule.op === "set_header") {
    if (typeof rule.value !== "string")
      return;
    const existing = headerKey(headers, name);
    if (existing !== null && existing !== name)
      delete headers[existing];
    headers[name] = rule.value;
  } else {
    const existing = headerKey(headers, name);
    if (existing !== null)
      delete headers[existing];
  }
}
__name(applyHeaderOp, "applyHeaderOp");
// Apply a provider's rewrite rules to a converted outbound body
// (and its headers), in order. Pure in the send-path sense: it
// only touches the body/headers objects handed to it, which the
// caller built fresh for this request. Rules that cannot apply —
// missing path, type mismatch, out-of-range index, non-string
// target for a string op, blocked header — are silently skipped,
// never thrown, so one bad rule cannot fail the request. `set`
// creates missing intermediate objects; every other body op
// requires the path to already exist.
export function applyParamOverrides(body, headers, rules) {
  if (!Array.isArray(rules) || !rules.length)
    return body;
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || typeof rule.op !== "string" || typeof rule.path !== "string")
      continue;
    if (rule.op === "set_header" || rule.op === "delete_header") {
      applyHeaderOp(headers, rule);
      continue;
    }
    if (!body || typeof body !== "object")
      continue;
    if (!whenSatisfied(body, rule.when))
      continue;
    const segs = segsOf(rule.path);
    switch (rule.op) {
      case "delete":
        deleteAt(body, segs);
        break;
      case "set":
        if ("value" in rule)
          setAt(body, segs, clone(rule.value), true);
        break;
      case "move": {
        if (typeof rule.to !== "string")
          break;
        const src = getAt(body, segs);
        if (!src.found)
          break;
        if (deleteAt(body, segs))
          setAt(body, segsOf(rule.to), src.value, true);
        break;
      }
      case "copy": {
        if (typeof rule.to !== "string")
          break;
        const src = getAt(body, segs);
        if (!src.found)
          break;
        setAt(body, segsOf(rule.to), clone(src.value), true);
        break;
      }
      case "prepend":
      case "append": {
        if (!("value" in rule))
          break;
        const cur = getAt(body, segs);
        if (!cur.found)
          break;
        if (typeof cur.value === "string" && typeof rule.value === "string") {
          setAt(body, segs, rule.op === "prepend" ? rule.value + cur.value : cur.value + rule.value, false);
        } else if (Array.isArray(cur.value)) {
          if (rule.op === "prepend")
            cur.value.unshift(clone(rule.value));
          else
            cur.value.push(clone(rule.value));
        }
        break;
      }
      case "trim_prefix":
      case "trim_suffix":
      case "ensure_prefix":
      case "ensure_suffix": {
        if (typeof rule.value !== "string" || !rule.value)
          break;
        const cur = getAt(body, segs);
        if (!cur.found || typeof cur.value !== "string")
          break;
        let next = null;
        if (rule.op === "trim_prefix" && cur.value.startsWith(rule.value))
          next = cur.value.slice(rule.value.length);
        else if (rule.op === "trim_suffix" && cur.value.endsWith(rule.value))
          next = cur.value.slice(0, cur.value.length - rule.value.length);
        else if (rule.op === "ensure_prefix" && !cur.value.startsWith(rule.value))
          next = rule.value + cur.value;
        else if (rule.op === "ensure_suffix" && !cur.value.endsWith(rule.value))
          next = cur.value + rule.value;
        if (next !== null)
          setAt(body, segs, next, false);
        break;
      }
      case "trim_space": {
        const cur = getAt(body, segs);
        if (cur.found && typeof cur.value === "string")
          setAt(body, segs, cur.value.trim(), false);
        break;
      }
      case "to_lower":
      case "to_upper": {
        const cur = getAt(body, segs);
        if (cur.found && typeof cur.value === "string")
          setAt(body, segs, rule.op === "to_lower" ? cur.value.toLowerCase() : cur.value.toUpperCase(), false);
        break;
      }
      case "replace": {
        if (typeof rule.from !== "string" || !rule.from || typeof rule.to !== "string")
          break;
        const cur = getAt(body, segs);
        if (cur.found && typeof cur.value === "string")
          setAt(body, segs, cur.value.split(rule.from).join(rule.to), false);
        break;
      }
      case "regex_replace": {
        if (typeof rule.from !== "string" || !rule.from || typeof rule.to !== "string")
          break;
        const cur = getAt(body, segs);
        if (!cur.found || typeof cur.value !== "string")
          break;
        try {
          setAt(body, segs, cur.value.replace(new RegExp(rule.from, "g"), rule.to), false);
        } catch {
          // An uncompilable pattern at runtime is skipped, never thrown.
        }
        break;
      }
      default:
        break;
    }
  }
  return body;
}
__name(applyParamOverrides, "applyParamOverrides");
