// Generates the rejection decoder and the /guideline/* SEO pages into site/public.
//   node site/guides/build.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDELINES } from "./guidelines.mjs";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const SITE = "https://ascship.web.app";
const DECODER_API = "https://us-central1-lectern-notes.cloudfunctions.net/decodeRejection";
const FIVERR = "https://www.fiverr.com/yeetermemes/fix-your-app-store-rejection-and-get-your-ios-app-approved";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CSS = `
  :root { --bg:#0b0d10; --panel:#12151a; --panel-2:#171b21; --line:#232830; --text:#e6e9ee; --muted:#8b93a0; --accent:#5eead4; --accent-ink:#062521; --warn:#fbbf24; --good:#4ade80;
    --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace; --sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  * { box-sizing:border-box; margin:0; padding:0; }
  html { -webkit-text-size-adjust:100%; }
  body { background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.6; }
  a { color:var(--accent); }
  .wrap { max-width:780px; margin:0 auto; padding:0 16px; }
  nav { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:22px 0; flex-wrap:wrap; }
  .logo { font-family:var(--mono); font-weight:700; font-size:18px; color:var(--text); text-decoration:none; }
  .logo span { color:var(--accent); }
  nav .links { display:flex; gap:16px; font-size:14px; }
  nav .links a { color:var(--muted); text-decoration:none; }
  nav .links a:hover { color:var(--text); }
  .eyebrow { font-family:var(--mono); font-size:13px; color:var(--accent); margin:28px 0 12px; }
  h1 { font-size:clamp(30px,5vw,44px); line-height:1.1; letter-spacing:-.03em; }
  h2 { font-size:22px; letter-spacing:-.02em; margin:40px 0 12px; }
  p.lead { color:var(--muted); font-size:18px; margin:16px 0 0; }
  p { margin:0 0 12px; }
  ul, ol { padding-left:22px; margin:0 0 12px; }
  li { margin:6px 0; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px; margin:16px 0; }
  .reply { font-family:var(--mono); font-size:13.5px; white-space:pre-wrap; background:var(--panel-2); border:1px solid var(--line); border-radius:10px; padding:16px; overflow-wrap:anywhere; }
  .btn { display:inline-block; background:var(--accent); color:var(--accent-ink); border:0; border-radius:10px; padding:12px 18px; font:inherit; font-weight:600; font-size:15px; cursor:pointer; text-decoration:none; }
  .btn.ghost { background:transparent; color:var(--text); border:1px solid var(--line); }
  .btn:disabled { opacity:.6; cursor:default; }
  .cta { background:linear-gradient(135deg,#10302c,#12151a 60%); border:1px solid #1f4d47; border-radius:16px; padding:24px; margin:40px 0; }
  .cta h3 { font-size:20px; margin-bottom:6px; }
  .cta p { color:var(--muted); }
  .cta .btns { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
  .pill { display:inline-block; font-family:var(--mono); font-size:12px; border:1px solid var(--line); border-radius:999px; padding:3px 10px; color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; margin:16px 0; }
  .grid a { display:block; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px; text-decoration:none; color:var(--text); }
  .grid a:hover { border-color:var(--accent); }
  .grid b { font-family:var(--mono); color:var(--accent); display:block; font-size:14px; }
  .grid span { font-size:14px; color:var(--muted); }
  footer { color:var(--muted); font-size:13px; padding:40px 0 60px; border-top:1px solid var(--line); margin-top:56px; }
  textarea { width:100%; min-height:200px; resize:vertical; background:var(--panel-2); color:var(--text); border:1px solid var(--line); border-radius:12px; padding:14px; font:14px/1.5 var(--mono); }
  textarea:focus { outline:none; border-color:var(--accent); }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-top:12px; }
  .muted { color:var(--muted); font-size:14px; }
  .err { color:#f87171; }
  .tag { font-family:var(--mono); font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--line); }
  .tag.quick { color:var(--good); border-color:#1e4d33; } .tag.moderate { color:var(--warn); border-color:#4d3f1e; } .tag.involved { color:#f87171; border-color:#4d1e1e; }
  @media (max-width:520px) { nav .links { width:100%; } .cta .btns .btn { width:100%; text-align:center; } }
`;

function page({ title, description, path, body, script = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}${path}">
<link rel="canonical" href="${SITE}${path}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<nav>
  <a class="logo" href="/">asc<span>ship</span></a>
  <div class="links"><a href="/rejection-decoder">Rejection decoder</a><a href="/guidelines">Common rejections</a><a href="${FIVERR}" rel="noopener">Hire me</a></div>
</nav>
${body}
<footer>Not affiliated with Apple. Guideline summaries are plain-English paraphrases; always check Apple's current App Review Guidelines. &nbsp;·&nbsp; <a href="/">ascship</a></footer>
</div>
${script}
</body>
</html>
`;
}

const cta = (lead) => `
<div class="cta">
  <h3>${esc(lead)}</h3>
  <p>I've shipped 7 apps of my own and fixed real rejections on them. Invite me to App Store Connect (no Apple ID password needed), and I'll fix it, reply to Apple and resubmit. From $45, with unlimited revisions until the original rejection is approved.</p>
  <div class="btns"><a class="btn" href="${FIVERR}" rel="noopener">Get it fixed on Fiverr</a><a class="btn ghost" href="/rejection-decoder">Decode your rejection free</a></div>
</div>`;

const out = (rel, html) => {
  const file = join(PUBLIC, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
};

// One page per guideline.
for (const g of GUIDELINES) {
  const others = GUIDELINES.filter((o) => o !== g)
    .map((o) => `<a href="/guideline/${o.slug}"><b>${esc(o.id)}</b><span>${esc(o.name)}</span></a>`).join("");
  const body = `
<div class="eyebrow">App Store Guideline ${esc(g.id)}</div>
<h1>Guideline ${esc(g.id)} rejection (${esc(g.name)}): what it means and how to fix it</h1>
<p class="lead">${esc(g.summary)}</p>

<h2>What Apple is saying</h2>
<p>${esc(g.meaning)}</p>

<h2>Common causes</h2>
<ul>${g.causes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>

<h2>How to fix it</h2>
<ol>${g.fix.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>

<h2>Do you need a new build?</h2>
<p>${esc(g.newBuild)}</p>

<h2>Reply to App Review</h2>
<p class="muted">Send this in Resolution Center (App Store Connect → your app → the rejected version) after fixing. Fill in the [brackets].</p>
<div class="reply">${esc(g.reply)}</div>

${cta(`Got a ${g.id} rejection you'd rather not deal with?`)}

<h2>Other common rejections</h2>
<div class="grid">${others}</div>`;
  out(`guideline/${g.slug}.html`, page({
    title: `App Store Guideline ${g.id} Rejection: How to Fix It (${g.name})`,
    description: `${g.summary} Plain-English explanation, common causes, step-by-step fix and a reply template for App Review.`,
    path: `/guideline/${g.slug}`,
    body,
  }));
}

// Index of guidelines.
out("guidelines.html", page({
  title: "Common App Store Rejections, Explained in Plain English",
  description: "The App Review guidelines apps get rejected under most often (2.1, 4.2, 4.3, 5.1.1, 3.1.2 and more), what each means and how to fix it.",
  path: "/guidelines",
  body: `
<div class="eyebrow">App Review, decoded</div>
<h1>Common App Store rejections, in plain English</h1>
<p class="lead">What each guideline actually means, why apps hit it, and how to get approved. Or paste your own rejection into the <a href="/rejection-decoder">decoder</a>.</p>
<div class="grid">${GUIDELINES.map((g) => `<a href="/guideline/${g.slug}"><b>${esc(g.id)}</b><span>${esc(g.name)}: ${esc(g.summary)}</span></a>`).join("")}</div>
${cta("Rather have someone fix it for you?")}`,
}));

// The decoder.
const matchData = JSON.stringify(GUIDELINES.map((g) => ({ id: g.id, name: g.name, slug: g.slug, re: g.match.source })));
out("rejection-decoder.html", page({
  title: "App Store Rejection Decoder: Paste Your Rejection, Get the Fix",
  description: "Free tool: paste the rejection message from Apple's App Review and get it explained in plain English, with a step-by-step fix and a reply to send Apple.",
  path: "/rejection-decoder",
  body: `
<div class="eyebrow">Free tool</div>
<h1>App Store rejection decoder</h1>
<p class="lead">Paste the message from App Review (Resolution Center). You'll get what Apple actually means, how to fix it, and a reply to send back.</p>

<div class="card">
  <label for="t" class="muted">Rejection message</label>
  <textarea id="t" placeholder="Guideline 2.1 - Performance - App Completeness&#10;&#10;We were unable to review your app as it crashed on launch..."></textarea>
  <div class="row">
    <button class="btn" id="go">Decode it</button>
    <span class="muted" id="status">Free. Don't paste passwords or private keys.</span>
  </div>
  <div id="quick"></div>
</div>

<div id="out"></div>

${cta("Want it fixed for you?")}

<h2>Common rejections</h2>
<div class="grid">${GUIDELINES.map((g) => `<a href="/guideline/${g.slug}"><b>${esc(g.id)}</b><span>${esc(g.name)}</span></a>`).join("")}</div>`,
  script: `<script>
(() => {
  const API = ${JSON.stringify(DECODER_API)};
  const GUIDES = ${matchData}.map(g => ({ ...g, re: new RegExp(g.re) }));
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const t = $("t"), go = $("go"), status = $("status"), out = $("out"), quick = $("quick");

  // Instant links to our guides for any guideline numbers in the text, before the AI answers.
  const guideFor = (id) => GUIDES.find(g => g.re.test("Guideline " + id));
  t.addEventListener("input", () => {
    const hits = GUIDES.filter(g => g.re.test(t.value));
    quick.innerHTML = hits.length ? '<p class="muted" style="margin-top:14px">Guides: ' +
      hits.map(g => '<a href="/guideline/' + g.slug + '">' + esc(g.id) + ' ' + esc(g.name) + '</a>').join(" · ") + '</p>' : "";
  });

  const LABEL = { quick: "Quick fix", moderate: "Moderate fix", involved: "Involved fix" };
  function render(r) {
    if (!r.is_rejection) {
      out.innerHTML = '<div class="card"><p>That doesn\\'t look like an App Review rejection. Paste the full message from Resolution Center in App Store Connect.</p></div>';
      return;
    }
    const gl = r.guidelines.map(g => {
      const guide = guideFor(g.id);
      const label = esc(g.id) + " · " + esc(g.name);
      return guide ? '<a class="pill" href="/guideline/' + guide.slug + '">' + label + '</a>' : '<span class="pill">' + label + '</span>';
    }).join(" ");
    out.innerHTML =
      '<div class="card">' +
        '<div class="row" style="margin:0 0 14px">' + gl + ' <span class="tag ' + esc(r.difficulty) + '">' + LABEL[r.difficulty] + '</span>' +
        ' <span class="tag">' + (r.needs_new_build ? "Needs a new build" : "No new build needed") + '</span></div>' +
        '<h2 style="margin-top:0">What Apple is saying</h2><p>' + esc(r.plain_english) + '</p>' +
        '<h2>Most likely cause</h2><p>' + esc(r.likely_cause) + '</p>' +
        '<h2>How to fix it</h2><ol>' + r.fix_steps.map(s => '<li>' + esc(s) + '</li>').join("") + '</ol>' +
        (r.reply_to_apple ? '<h2>Reply to App Review</h2><div class="reply" id="reply">' + esc(r.reply_to_apple) + '</div>' +
          '<div class="row"><button class="btn ghost" id="copy">Copy reply</button></div>' : "") +
      '</div>';
    const copy = $("copy");
    if (copy) copy.onclick = async () => {
      try { await navigator.clipboard.writeText(r.reply_to_apple); copy.textContent = "Copied"; } catch { copy.textContent = "Select and copy above"; }
    };
    out.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  go.onclick = async () => {
    const text = t.value.trim();
    if (text.length < 40) { status.innerHTML = '<span class="err">Paste the full rejection message (it\\'s too short).</span>'; return; }
    go.disabled = true; status.textContent = "Reading it like a reviewer would… (about 10 seconds)";
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Something went wrong. Try again in a minute.");
      render(data.result);
      status.textContent = "Done. Not what you expected? Edit the text and decode again.";
    } catch (e) {
      status.innerHTML = '<span class="err">' + esc(e.message) + '</span>';
    } finally { go.disabled = false; }
  };
})();
</script>`,
}));

// Sitemap + robots for the whole site.
const paths = ["/", "/done-for-you", "/rejection-decoder", "/guidelines", ...GUIDELINES.map((g) => `/guideline/${g.slug}`)];
out("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join("\n")}
</urlset>
`);
out("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`built ${GUIDELINES.length} guideline pages + decoder + index + sitemap`);
