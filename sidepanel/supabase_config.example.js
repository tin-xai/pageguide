// Supabase configuration for the PageGuide User Study.
// Copy this file to sidepanel/supabase_config.js (gitignored — never commit real credentials)
// and fill in your own project's URL + anon key. Find these in:
// Supabase Dashboard → Project Settings → API.
//
// Without this file, the study still works fine — results are saved to chrome.storage.local
// and downloadable as CSV from the study's final screen. Supabase is only an optional real-time
// mirror of the same data. See ../supabase_schema.sql for the table this expects.

const SUPABASE_URL = 'YOUR_PROJECT_URL'; // e.g. https://abcdefgh.supabase.co
const SUPABASE_ANON_KEY = 'YOUR_PROJECT_ANON_KEY';

// ── V2 (the four-variant study) ────────────────────────────────────────────
// V2 runs in its own Supabase project, so V1 can keep collecting untouched — see the header of
// ../supabase_schema_v2.sql. These two are what "⬆️ Publish to V2" on the study's debug screen
// writes through; leave them as placeholders and that button simply stays disabled.
//
// The anon key is enough because V2's save_pageguide_find_v2_claim is SECURITY DEFINER and
// granted to anon, gated on an admin password you set once from the SQL editor with
//   select public.set_pageguide_find_v2_admin_password('a long private password');
// The password is typed into the panel when you publish and is held in memory for that tab only.
// It never goes into this file, and no secret/service-role key is ever needed in the browser.
const SUPABASE_V2_URL = 'YOUR_V2_PROJECT_URL'; // e.g. https://ijklmnop.supabase.co
const SUPABASE_V2_ANON_KEY = 'YOUR_V2_PROJECT_ANON_KEY';
