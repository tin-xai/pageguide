// Supabase configuration for the PageGuide annotator website.
// Copy this file to annotate/supabase_config.js (gitignored) and fill in the SAME project the
// extension's V2 publishers use (SUPABASE_V2_URL / SUPABASE_V2_ANON_KEY in
// sidepanel/supabase_config.js) — supabase_schema_annotation.sql is installed there.
//
// Without this file the site still works: load a JSON exported from the extension
// (⋯ → Record Annotation Trajectories → Export JSON) and annotations stay in this browser.
const SUPABASE_ANNOT_URL = 'YOUR_PROJECT_URL'; // e.g. https://ijklmnop.supabase.co
const SUPABASE_ANNOT_ANON_KEY = 'YOUR_PROJECT_ANON_KEY';
