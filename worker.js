/**
 * worker.js — a single, tiny Cloudflare Worker.
 *
 * Purpose: the GitHub Pages site (a static page, no server of its own)
 * sends chat messages here instead of calling Groq directly. This Worker
 * holds GROQ_API_KEY (required) and TAVILY_API_KEY (optional) as secrets,
 * so neither key ever appears in the page you push to GitHub.
 *
 * Tavily is used only when the user's question looks time-sensitive
 * (dates, "new decree", "2025/2026", etc.) — for everything else the
 * assistant answers from the knowledge base / Groq directly, to keep
 * responses fast and avoid unnecessary Tavily usage.
 *
 * Deploy (one time, ~2 minutes):
 *   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker (not Pages).
 *   2. Replace the default code with this whole file -> Deploy.
 *   3. Worker -> Settings -> Variables -> Add variable:
 *        name: GROQ_API_KEY, value: your key, mark it "Encrypt".
 *      (Optional) Add another: name: TAVILY_API_KEY, value: your key, "Encrypt".
 *      -> Save and deploy again.
 *   4. Copy the worker's URL (looks like https://xxx.yyy.workers.dev) and
 *      paste it into WORKER_URL near the top of the <script> in index.html,
 *      before you push index.html to GitHub.
 *
 * Optional hardening: once you know your GitHub Pages URL (e.g.
 * https://yourname.github.io), replace ALLOWED_ORIGIN below with that exact
 * URL instead of "*", so only your page can call this Worker.
 */

const ALLOWED_ORIGIN = "*";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Loose heuristic: does the question plausibly need a fresh web check
// (new decrees, dates, "هل تغير...", years 2025/2026, etc.)?
const TIME_SENSITIVE_PATTERN = /(2025|2026|2027|تاريخ|متى|آخر أجل|قرار جديد|مرسوم جديد|تعديل جديد|آخر تحديث|الجريدة الرسمية|تسجيل|الترشح|موعد)/i;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    if (!env.GROQ_API_KEY) {
      return json({ error: "server_not_configured", detail: "GROQ_API_KEY secret is missing." }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }

    const messages = body?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return json({ error: "no_messages" }, 400);
    }

    // Optional Tavily augmentation, injected as an extra system message.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (env.TAVILY_API_KEY && lastUser?.content && TIME_SENSITIVE_PATTERN.test(lastUser.content)) {
      const results = await tavilySearch(env.TAVILY_API_KEY, lastUser.content);
      if (results.length) {
        const webContext = "نتائج بحث حالية على الويب:\n" +
          results.map((r, i) => `[ويب-${i + 1}] ${r.title} — ${r.content} (${r.url})`).join("\n");
        messages.splice(messages.length - 1, 0, { role: "system", content: webContext });
      }
    }

    let groqRes;
    try {
      groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.4 })
      });
    } catch (err) {
      return json({ error: "groq_request_failed", detail: String(err) }, 502);
    }

    if (!groqRes.ok) {
      return json({ error: "groq_upstream_error", detail: await groqRes.text() }, 502);
    }

    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || "";
    return json({ reply }, 200);
  }
};

async function tavilySearch(apiKey, query, maxResults = 4) {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: maxResults,
        include_answer: false
      })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: (r.content || "").slice(0, 500)
    }));
  } catch {
    return [];
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
