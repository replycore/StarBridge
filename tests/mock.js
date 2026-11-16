// Mock OpenAI-compatible upstreams for local gateway tests.
// aaa (9101): models mock-a..mock-e + mock-shared-1; bad mode -> chat 500.
// bbb (9102): mock-shared-1 only; always good.
const http = require('http');
function make(port, name, models, state) {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
      if (req.url === '/__stats') return send(200, {name, chatAttempts: state.chatAttempts, mode: state.mode});
      if (req.url === '/__toggle') { state.mode = state.mode === 'bad' ? 'good' : 'bad'; return send(200, {mode: state.mode}); }
      if (req.url.endsWith('/models')) return send(200, {data: models.map(id => ({id, object:'model'}))});
      if (req.url.endsWith('/chat/completions')) {
        state.chatAttempts++;
        if (state.mode === 'bad') return send(500, {error:{message:'upstream boom from '+name}});
        let model = 'unknown';
        try { model = JSON.parse(body).model || model; } catch {}
        return send(200, {id:'chatcmpl-mock', object:'chat.completion', model, choices:[{index:0, message:{role:'assistant', content:'hello from '+name}, finish_reason:'stop'}], usage:{prompt_tokens:3, completion_tokens:4, total_tokens:7}});
      }
      return send(404, {error:{message:'mock 404'}});
    });
  });
  srv.listen(port, '127.0.0.1', () => console.log(name, 'listening', port));
}
make(9101, 'aaa', ['mock-a','mock-b','mock-c','mock-d','mock-e','mock-shared-1'], global.__a = {chatAttempts:0, mode:'bad'});
make(9102, 'bbb', ['mock-shared-1'], {chatAttempts:0, mode:'good'});
