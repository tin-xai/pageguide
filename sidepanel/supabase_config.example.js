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
