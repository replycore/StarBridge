import { __name } from "../helpers.js";
import { deferred, json, parseSSE } from "../util.js";

export function normalizeUsage(u) {
  if (!u || typeof u !== "object")
    return null;
  const o = u;
  const prompt = Number(o.prompt_tokens ?? o.input_tokens ?? o.promptTokenCount ?? 0) + Number(o.cache_read_input_tokens ?? 0) + Number(o.cache_creation_input_tokens ?? 0);
  const completion = Number(o.completion_tokens ?? o.output_tokens ?? o.candidatesTokenCount ?? 0) + Number(o.thoughtsTokenCount ?? 0);
  const upstreamTotal = Number(o.total_tokens ?? o.totalTokenCount ?? 0);
  const total = Math.max(upstreamTotal, prompt + completion);
  if (!prompt && !completion && !total)
    return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion
  };
}
__name(normalizeUsage, "normalizeUsage");
export var openaiAdapter = {
  build(ctx) {
    const body = { ...ctx.req, model: ctx.model };
    delete body.session_id;
    delete body.gw_provider;
    for (const p of ctx.drops)
      delete body[p];
    for (const p of ctx.provider.dropParams ?? [])
      delete body[p];
    if (body.stream) {
      if (ctx.provider.streamUsage === false) {
        delete body.stream_options;
      } else if (!body.stream_options) {
        body.stream_options = { include_usage: true };
      } else if (typeof body.stream_options === "object" && body.stream_options.include_usage !== true) {
        body.stream_options = {
          ...body.stream_options,
          include_usage: true
        };
      }
    } else {
      delete body.stream_options;
    }
    const headers = {
      ...ctx.provider.headers ?? {},
      "content-type": "application/json",
      authorization: `Bearer ${ctx.key.key}`
    };
    return {
      url: `${ctx.provider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      init: { method: "POST", headers, body: JSON.stringify(body) }
    };
  },
  parseJson(data) {
    const obj = data ?? {};
    return { json: obj, usage: normalizeUsage(obj.usage) };
  },
  parseStream(body) {
    // Usage extraction runs through the shared SSE parser on a
    // teed branch (the old hand-rolled tail scan misread the word
    // "usage" inside message text and broke on braces in strings).
    const usage = deferred();
    const [clientBranch, scanBranch] = body.tee();
    (async () => {
      let found = null;
      let errored = false;
      let sawData = false;
      let sawDone = false;
      try {
        const reader = parseSSE(scanBranch).getReader();
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done)
            break;
          if (!value)
            continue;
          if (value.data === "[DONE]") {
            sawDone = true;
            continue;
          }
          if (value.data)
            sawData = true;
          try {
            const parsed = JSON.parse(value.data);
            // An in-band error object is a failed generation even
            // though the transport stayed clean: mark it so the
            // settlement does not record a success.
            if (parsed && typeof parsed === "object" && parsed.error)
              errored = true;
            const u = normalizeUsage(parsed?.usage);
            if (u)
              found = u;
          } catch {
          }
        }
      } catch {
        // The upstream died mid-stream: mark the settlement so the
        // router reports a failure instead of a clean success.
        errored = true;
      }
      // EOF without [DONE] after real data events means the stream
      // was truncated mid-generation — also a failure. A completely
      // empty stream (no events at all) keeps resolving null.
      if (!sawDone && sawData)
        errored = true;
      usage.resolve(errored ? { ...(found ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }), streamError: true } : found);
    })();
    return { stream: clientBranch, usage: usage.promise };
  }
};
