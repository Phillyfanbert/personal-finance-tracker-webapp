// ============================================================================
// Supabase connection config.
// Fill these in with YOUR project values (SETUP.md §4):
//   Supabase Dashboard → Project Settings → Data API / API Keys
//
// SAFE to expose publicly: the anon key is designed for browsers and is
// powerless without RLS-passing auth. NEVER put the service_role key here.
// ============================================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_YOUR_KEY_HERE",

  // Phase 3 - Gemma natural-language parsing (OPTIONAL, README §3.6).
  // Leave GEMMA_ENDPOINT empty to keep the app on keyword parsing only.
  // For local testing: run tools/mock-gemma-server.js and use
  //   "http://localhost:11434/api/generate"
  // In production: your Cloudflare Tunnel HTTPS URL in front of Ollama.
  GEMMA_ENDPOINT: "",
  GEMMA_MODEL: "gemma",
  // Model used to embed a question for RAG retrieval (Reports Q&A's
  // relevant_history - supabase/45_expense_embeddings.sql) - separate from
  // GEMMA_MODEL since embedding and generation are different model
  // families. Must match tools/embed-expenses.js's GEMMA_EMBED_MODEL (same
  // env var name, see tools/.env.deal-agent.example) - if these ever
  // diverge, questions get embedded in a different vector space than the
  // expenses were, and retrieval silently returns nonsense matches.
  GEMMA_EMBED_MODEL: "nomic-embed-text",
  // Shared secret the tunnel's gemma-auth-proxy.js requires on every request
  // (X-Gemma-Key header) - without it, anyone who finds the Cloudflare Tunnel
  // URL could send free requests to the home GPU, since Ollama itself has no
  // auth and a quick tunnel (no owned domain) can't use Cloudflare Access.
  // Leave empty when GEMMA_ENDPOINT points at a local mock/dev server that
  // has no proxy in front of it. NOT truly secret once set here - this file
  // is public client-side config, same caveat as GEMMA_ENDPOINT itself; it
  // only stops someone who merely finds the tunnel URL, not someone reading
  // this app's own source.
  GEMMA_AUTH_KEY: "",

  // F6 stretch - live deal discovery.
  // Off by default: the deal_findings table stays dormant until you stand up
  // the home-machine search agent (Phase B/C of the proposal). Flip to true
  // once you're ready to surface machine-found (unverified) deals in the UI.
  DEAL_FINDINGS_ENABLED: false,

  // Live asset prices - same dormant-until-
  // configured shape as DEAL_FINDINGS_ENABLED above, built on the same
  // SearXNG+Gemma pipeline (tools/price-agent.js) instead of a paid price
  // API. Flip to true once that agent is actually running somewhere.
  PRICE_FINDINGS_ENABLED: false,
};
