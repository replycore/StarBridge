import { __name } from "./helpers.js";

// Canonical tool layer: every format boundary goes
// extract -> canonical form -> re-attach. The canonical form is
// the OpenAI function tool shape
//   {type: "function", function: {name, description, parameters, strict?}}
// whose function payload is the flat {name, description,
// parameters, strict?} record. Each converter below returns
// {tools, dropped, warnings}: `dropped` lists only real losses —
// a tool skipped outright, or a construct the target format
// cannot carry that the conversion actually removed (checked
// against what the mapping code does, never guessed). `warnings`
// are non-fatal oddities (e.g. a nameless tool) that still went
// through. All-tools-dropped keeps the existing x-gw-degraded:
// tools routing semantics — this layer only diagnoses, it never
// changes routing.

// Conversion quality by direction, documentation only: never
// consulted by routing. The "fair" legs go through the OpenAI
// shape as an intermediate (or accumulate functionCall arguments
// across stream chunks), so they lose more than the "good" ones.
export var CONVERSION_QUALITY = {
  "openai->anthropic": "good",
  "openai->gemini": "good",
  "anthropic->openai": "good",
  "gemini->openai": "fair",
  "anthropic->gemini": "fair",
  "gemini->anthropic": "fair"
};

// JSON Schema keys Gemini does not accept: cleanSchema drops them
// (recursively) instead of sending a schema the upstream 400s.
export var SCHEMA_DROP = /* @__PURE__ */ new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "strict",
  "default",
  "examples",
  "const",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "patternProperties",
  "if",
  "then",
  "else",
  "not",
  "dependentRequired",
  "nullable",
  "discriminator",
  "readOnly",
  "writeOnly",
  "deprecated"
]);
export function cleanSchema(node) {
  if (Array.isArray(node))
    return node.map(cleanSchema);
  if (!node || typeof node !== "object")
    return node;
  const src = node;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (SCHEMA_DROP.has(k))
      continue;
    out[k] = cleanSchema(v);
  }
  if (Array.isArray(out.type)) {
    const nonNull = out.type.filter((t) => t !== "null");
    if (out.type.length !== nonNull.length)
      out.nullable = true;
    if (nonNull.length === 1)
      out.type = nonNull[0];
    else if (nonNull.length === 0)
      delete out.type;
    else
      out.type = nonNull[0];
  }
  if (Array.isArray(out.anyOf)) {
    const branches = out.anyOf;
    const nonNull = branches.filter((b) => b?.type !== "null");
    if (nonNull.length !== branches.length)
      out.nullable = true;
    if (nonNull.length === 1) {
      Object.assign(out, nonNull[0]);
      delete out.anyOf;
    } else {
      out.anyOf = nonNull;
    }
  }
  if (out.properties && !out.type)
    out.type = "object";
  if (out.items && !out.type)
    out.type = "array";
  return out;
}
__name(cleanSchema, "cleanSchema");
// What cleanSchema actually removes from one schema node, so the
// diagnostic can name it: SCHEMA_DROP keys present anywhere in
// the tree, plus a multi-type `type` array (cleanSchema keeps
// only the first non-null type). A single-branch anyOf is merged
// into its parent — an equivalent rewrite, not a loss — and a
// multi-branch anyOf is kept verbatim, so neither is reported.
function droppedSchemaConstructs(node, seen) {
  if (Array.isArray(node)) {
    for (const item of node)
      droppedSchemaConstructs(item, seen);
    return;
  }
  if (!node || typeof node !== "object")
    return;
  for (const [k, v] of Object.entries(node)) {
    if (SCHEMA_DROP.has(k)) {
      seen.add(`unsupported schema key "${k}" removed`);
    } else {
      droppedSchemaConstructs(v, seen);
    }
  }
  if (Array.isArray(node.type)) {
    const nonNull = node.type.filter((t) => t !== "null");
    if (nonNull.length > 1)
      seen.add(`type array [${nonNull.map((t) => JSON.stringify(t)).join(", ")}] reduced to ${JSON.stringify(nonNull[0])}`);
  }
}
__name(droppedSchemaConstructs, "droppedSchemaConstructs");
function skippedToolName(t) {
  if (!t || typeof t !== "object")
    return "";
  return String(t.function?.name ?? t.name ?? "");
}
__name(skippedToolName, "skippedToolName");
// OpenAI-shaped tools -> Anthropic tools. The input_schema is
// passed through verbatim, so nothing inside a schema is ever
// dropped here; only a function-level `strict` (which Anthropic
// tools cannot carry) and entries without a function payload are
// reported.
export function toAnthropicTools(tools) {
  const dropped = [];
  const warnings = [];
  if (!Array.isArray(tools) || !tools.length)
    return { tools: void 0, dropped, warnings };
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object" || !t.function) {
      dropped.push({ name: skippedToolName(t), reason: "tool definition without a function payload was skipped" });
      continue;
    }
    const f = t.function;
    if (f.strict === true)
      dropped.push({ name: String(f.name ?? ""), reason: "strict is not supported on Anthropic tools" });
    if (f.name == null || f.name === "")
      warnings.push({ name: "", reason: "tool has no name" });
    out.push({
      name: f.name,
      description: f.description ?? "",
      input_schema: f.parameters ?? { type: "object", properties: {} }
    });
  }
  return { tools: out, dropped, warnings };
}
__name(toAnthropicTools, "toAnthropicTools");
// OpenAI-shaped tools -> Gemini function declarations. The
// parameters go through cleanSchema, so every construct it
// strips is a real, reportable drop; a function-level `strict`
// is likewise dropped (the declaration has no such field).
export function toGeminiTools(tools) {
  const dropped = [];
  const warnings = [];
  if (!Array.isArray(tools) || !tools.length)
    return { tools: void 0, dropped, warnings };
  const decls = [];
  for (const t of tools) {
    if (!t || typeof t !== "object" || !t.function) {
      dropped.push({ name: skippedToolName(t), reason: "tool definition without a function payload was skipped" });
      continue;
    }
    const f = t.function;
    const name = String(f.name ?? "");
    const params = f.parameters ?? { type: "object", properties: {} };
    const constructs = new Set();
    droppedSchemaConstructs(params, constructs);
    for (const reason of constructs)
      dropped.push({ name, reason });
    if (f.strict === true)
      dropped.push({ name, reason: "strict is not supported on Gemini tools" });
    if (f.name == null || f.name === "")
      warnings.push({ name: "", reason: "tool has no name" });
    decls.push({
      name: f.name,
      description: f.description ?? "",
      parameters: cleanSchema(params)
    });
  }
  return { tools: decls, dropped, warnings };
}
__name(toGeminiTools, "toGeminiTools");
// Canonical (flat {name, description, parameters, strict?} or
// OpenAI-shaped) tools -> OpenAI tools. Normalization / identity:
// OpenAI is the native shape, so nothing is ever dropped here
// except entries with neither a function payload nor a name.
export function toOpenAITools(tools) {
  const dropped = [];
  const warnings = [];
  if (!Array.isArray(tools) || !tools.length)
    return { tools: void 0, dropped, warnings };
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") {
      dropped.push({ name: "", reason: "tool definition without a function payload was skipped" });
      continue;
    }
    const f = t.function && typeof t.function === "object" ? t.function : t;
    if (typeof f.name !== "string" || f.name === "") {
      if (t.function == null && typeof t.name !== "string") {
        dropped.push({ name: "", reason: "tool definition without a function payload was skipped" });
        continue;
      }
      warnings.push({ name: "", reason: "tool has no name" });
    }
    out.push({
      type: "function",
      function: {
        name: String(f.name ?? ""),
        description: String(f.description ?? ""),
        parameters: f.parameters ?? { type: "object", properties: {} },
        ...(f.strict !== void 0 ? { strict: f.strict } : {})
      }
    });
  }
  return { tools: out, dropped, warnings };
}
__name(toOpenAITools, "toOpenAITools");
// Anthropic tools -> canonical (OpenAI-shaped) tools. Field for
// field the same mapping the Anthropic entry point used inline:
// name / description as strings ("" default), parameters from
// input_schema (default empty object schema). Nothing is dropped.
export function fromAnthropicTools(tools) {
  const dropped = [];
  const warnings = [];
  if (!Array.isArray(tools) || !tools.length)
    return { tools: void 0, dropped, warnings };
  const out = tools.map((t) => {
    const tool = t ?? {};
    return {
      type: "function",
      function: {
        name: String(tool.name ?? ""),
        description: String(tool.description ?? ""),
        parameters: tool.input_schema ?? { type: "object", properties: {} }
      }
    };
  });
  return { tools: out, dropped, warnings };
}
__name(fromAnthropicTools, "fromAnthropicTools");
// Gemini tools (a request body's tools array, each entry holding
// functionDeclarations) -> canonical (OpenAI-shaped) tools. Field
// for field the same mapping the Gemini entry point used inline:
// name / description as strings ("" default), parameters from
// the declaration (default empty object schema). A bare
// declaration (no functionDeclarations wrapper) is accepted too.
// Nothing is dropped.
export function fromGeminiTools(tools) {
  const dropped = [];
  const warnings = [];
  if (!Array.isArray(tools) || !tools.length)
    return { tools: void 0, dropped, warnings };
  const out = [];
  for (const t of tools) {
    const decls = t?.functionDeclarations ?? (t && typeof t === "object" && "name" in t ? [t] : []);
    for (const fd of decls) {
      const d = fd ?? {};
      out.push({
        type: "function",
        function: {
          name: String(d.name ?? ""),
          description: String(d.description ?? ""),
          parameters: d.parameters ?? { type: "object", properties: {} }
        }
      });
    }
  }
  return { tools: out, dropped, warnings };
}
__name(fromGeminiTools, "fromGeminiTools");
