#!/usr/bin/env node
// ============================================================================
// Cloudflare build-step: writes app/config.js from environment variables.
// app/config.js is gitignored (SETUP.md §4), so the GitHub-connected deploy
// has no config.js to serve until this runs. Set SUPABASE_URL and
// SUPABASE_ANON_KEY as env vars on the Cloudflare Pages/Workers project
// (Settings → Variables) - same values as your local app/config.js.
//
// Run as the project's Build command: node tools/generate-config.js
// ============================================================================
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variable.\n" +
      "Set them in the Cloudflare project's Settings → Variables and Secrets."
  );
  process.exit(1);
}

const contents = `window.APP_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(SUPABASE_URL)},
  SUPABASE_ANON_KEY: ${JSON.stringify(SUPABASE_ANON_KEY)},
  GEMMA_ENDPOINT: ${JSON.stringify(process.env.GEMMA_ENDPOINT || "")},
  GEMMA_MODEL: ${JSON.stringify(process.env.GEMMA_MODEL || "gemma")},
  GEMMA_EMBED_MODEL: ${JSON.stringify(process.env.GEMMA_EMBED_MODEL || "nomic-embed-text")},
  GEMMA_AUTH_KEY: ${JSON.stringify(process.env.GEMMA_AUTH_KEY || "")},
  // Both previously missing here entirely - the production deploy could
  // never show F6 deal findings regardless of what a local config.js had,
  // since this generator (the actual build step, per this file's own
  // header) never read or wrote either flag. Fixed alongside adding the
  // second one rather than leaving the same gap duplicated.
  DEAL_FINDINGS_ENABLED: ${process.env.DEAL_FINDINGS_ENABLED === "true"},
  PRICE_FINDINGS_ENABLED: ${process.env.PRICE_FINDINGS_ENABLED === "true"},
};
`;

fs.writeFileSync(path.join(__dirname, "..", "app", "config.js"), contents);
console.log("Wrote app/config.js from environment variables.");
