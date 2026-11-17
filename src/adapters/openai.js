import { __name } from "../helpers.js";
import { deferred, json } from "../util.js";

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
    const decoder = new TextDecoder();
    const usage = deferred();
    let tail = "";
    const stream = body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-16384);
        },
        flush() {
          let found = null;
          let idx = 0;
          while ((idx = tail.indexOf('"usage"', idx)) !== -1) {
            const brace = tail.indexOf("{", idx);
            if (brace === -1)
              break;
            let depth = 0;
            let end = -1;
            for (let i = brace; i < tail.length; i++) {
              if (tail[i] === "{")
                depth += 1;
              else if (tail[i] === "}") {
                depth -= 1;
                if (depth === 0) {
                  end = i;
                  break;
                }
              }
            }
            if (end === -1)
              break;
            try {
              const u = normalizeUsage(JSON.parse(tail.slice(brace, end + 1)));
              if (u)
                found = u;
            } catch {
            }
            idx = end + 1;
          }
          usage.resolve(found);
        }
      })
    );
    return { stream, usage: usage.promise };
  }
};
