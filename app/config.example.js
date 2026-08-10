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

  // F6 stretch - live deal discovery. Off by default: the deal_findings
  // table stays dormant until you stand up the home-machine search agent
  // (tools/deal-agent.js). Flip to true once you're ready to surface
  // machine-found (unverified) deals in the UI.
  DEAL_FINDINGS_ENABLED: false,

  // Live asset prices - same dormant-until-configured shape as
  // DEAL_FINDINGS_ENABLED above, built on the same SearXNG+Gemma pipeline
  // (tools/price-agent.js) instead of a paid price API. Flip to true once
  // that agent is actually running somewhere.
  PRICE_FINDINGS_ENABLED: false,
};
