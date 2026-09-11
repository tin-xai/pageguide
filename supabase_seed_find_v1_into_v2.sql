-- PageGuide V2 — seeding the ten Find V1 questions
-- ============================================================================
-- Run AFTER supabase_schema_v2.sql, in the same (blank) V2 project. Safe to
-- re-run: every statement is an upsert keyed on the item id, and it skips any
-- row that has already been published from the extension (see the WHERE at the
-- end of each statement), so re-running never overwrites authored answers.
--
-- Source: user_study_data/tasks.json in the extension repo, which is the only
-- checked-in copy of the question set. Each V1 task carries a question, one
-- correct answer, and three distractors — and the distractors are exactly what
-- V2's incorrect arm needs, so:
--
--   correct_grounding / correct_nongrounding    <- `answer`
--   incorrect_grounding / incorrect_nongrounding <- `distractors[0]`
--
-- WHAT THIS SEED CANNOT DO, and why every row lands with in_study = false
--
-- 1. tasks.json holds no page HTML. A live Find item needs the captured page
--    or the participant is asked to check an answer against a blank frame.
-- 2. tasks.json holds no GROUNDED text. Its answers are bare sentences with no
--    [N:"…"] citation markers and no [ev:key] evidence markers, so the two
--    grounded cells below are placeholders holding bare prose. The schema's own
--    point (see its header) is that a non-grounded answer is not a grounded one
--    with the brackets stripped — the difference is authored, and a seed cannot
--    invent it.
-- 3. evidence_ground_truth is empty, so the evidence question has no answer key.
--
-- So this is the scaffold, not the study. Record the real answers in the
-- extension (Answer screen -> the four cells) and press "V2 all find", which
-- upserts the same ids through save_pageguide_find_v2_claim with the marked-up
-- text, the citation anchors, the evidence, the page HTML and the ground truth,
-- and flips in_study to true. Everything below is overwritten at that point.
--
-- Written as direct inserts rather than through save_pageguide_find_v2_claim
-- because that function needs the admin password, which belongs in the panel
-- and not pasted into a SQL file. The columns, the normalization call and the
-- legacy back-fill below mirror what the function does, so a seeded row and a
-- published one have the same shape.
-- ============================================================================

-- PEDANT-V1 — FIND X VISUAL
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$PEDANT-V1$q$,
  $q$PEDANT-V1$q$,
  $ti$“Worthless Idiot, Donkey Head”: Parodies of Pedantry on the Renaissance Stage$ti$,
  $u$https://publicdomainreview.org/essay/parodies-of-pedantry/$u$,
  'find_visual',
  $qn$In the article, find the name of the play where the pedant assumes the important part. Then look at the title-page engraving from that play. What appears in the decorative border directly below the portrait?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$“Worthless Idiot, Donkey Head”: Parodies of Pedantry on the Renaissance Stage$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  0,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "A row of small figures, animals, and a wheeled cart in a procession-like scene.",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "A row of small figures, animals, and a wheeled cart in a procession-like scene.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "A sequence of zodiac symbols inside circular medallions.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "A sequence of zodiac symbols inside circular medallions.",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- SVSF-V1 — FIND X VISUAL
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$SVSF-V1$q$,
  $q$SVSF-V1$q$,
  $ti$The looting of science fiction$ti$,
  $u$https://aeon.co/essays/silicon-valley-has-a-science-fiction-problem$u$,
  'find_visual',
  $qn$A billionaire says a famous collections of novels helped shape his aspiration for renewable energy and space shuttle. In the image of the second novel shown there, what is the spaceman doing to the ship?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$The looting of science fiction$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  1,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "Holding onto it with one hand.",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "Holding onto it with one hand.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "Standing apart from it and pointing toward a planet.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "Standing apart from it and pointing toward a planet.",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- TREE-V1 — FIND X VISUAL
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$TREE-V1$q$,
  $q$TREE-V1$q$,
  $ti$Lore of the rings$ti$,
  $u$https://aeon.co/essays/how-to-decode-the-archive-inside-ancient-tree-rings$u$,
  'find_visual',
  $qn$The essay says crossdating can also date human-crafted wood remnants, including the oak panel used by a Flemish Primitive painter. Look at the nearby portrait shown as an example. What small creature appears on the lower ledge of the portrait?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$Lore of the rings$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  2,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "A fly.",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "A fly.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "A lizard.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "A lizard.",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- MUFC-V1 — FIND X VISUAL
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$MUFC-V1$q$,
  $q$MUFC-V1$q$,
  $ti$Manchester United F.C.$ti$,
  $u$https://en.wikipedia.org/wiki/Manchester_United_F.C.$u$,
  'find_visual',
  $qn$The article says the club was saved from a winding-up order after its captain helped find four local businessmen, and soon after changed to its present name. Find the early team photograph from shortly after that renaming. What object is placed on the ground in front of the seated row?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$Manchester United F.C.$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  3,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "A football.",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "A football.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "A folded newspaper.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "A folded newspaper.",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- TESLA-V1 — FIND X VISUAL
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$TESLA-V1$q$,
  $q$TESLA-V1$q$,
  $ti$Nikola Tesla$ti$,
  $u$https://en.wikipedia.org/wiki/Nikola_Tesla$u$,
  'find_visual',
  $qn$The article says a black room was set up for a system Tesla had previously shown throughout America. What kind of lighting system was shown there, and in the lecture image for that demonstration, what large dark shape stands behind him?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$Nikola Tesla$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  4,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "Wireless lighting; a tall rectangular backdrop or screen.",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "Wireless lighting; a tall rectangular backdrop or screen.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "Wireless lighting; a large circular coil or ring-shaped frame.",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "Wireless lighting; a large circular coil or ring-shaped frame.",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- MUFC-V1-TEXT — FIND x TEXT
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$MUFC-V1-TEXT$q$,
  $q$MUFC-V1-TEXT$q$,
  $ti$Manchester United F.C.$ti$,
  $u$https://en.wikipedia.org/wiki/Manchester_United_F.C.$u$,
  'find_text',
  $qn$On this page, there is the sentence that lists three cups that Manchester United won and four clubs that won before Manchester United. In that sentence, identify the two-word club name. Take the first letter of that club name. Then find the nationality of the person who became Manchester United manager in 1986. What is the alphabet-position difference between those two first letters?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$Manchester United F.C.$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  5,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "17",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "17",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "20",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "20",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- NVIDA-V1 — FIND x TEXT
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$NVIDA-V1$q$,
  $q$NVIDA-V1$q$,
  $ti$NVIDIA$ti$,
  $u$https://en.wikipedia.org/wiki/Nvidia$u$,
  'find_text',
  $qn$On this page, there is a sentence where a person’s name appears between “2026” and “AI.” Take the last letter of that person’s last name. Then find the last listed director’s current employer. Take the first letter of that employer. Which word that contains those letters in the following?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$NVIDIA$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  6,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "Sugar",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "Sugar",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "Chief",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "Chief",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- EDU-v1 — FIND x TEXT
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$EDU-v1$q$,
  $q$EDU-v1$q$,
  $ti$Education$ti$,
  $u$https://en.wikipedia.org/wiki/Education$u$,
  'find_text',
  $qn$On this page, find the sentence where a noun appears between the words “alternative” and “encompasses.” Take the last letter of that noun. Then find the third university listed as having emerged during the medieval era. Take the first letter of that university’s name. What is the alphabet-position difference between those two letters?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$Education$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  7,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "1",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "1",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "2",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "2",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- MARS-v1 — FIND x TEXT
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$MARS-v1$q$,
  $q$MARS-v1$q$,
  $ti$Mars$ti$,
  $u$https://en.wikipedia.org/wiki/Mars$u$,
  'find_text',
  $qn$On this page, there is a sentence where a planet name appears between “Mars” and “brightness.” Take the third letter of that planet’s name. Then find the isotope whose amount on Mars is described as seven times the amount on Earth. Take the first letter of that isotope. What is the sum of the alphabet positions of those two letters?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$Mars$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  8,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "20",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "20",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "15",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "15",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- HARRY-v1 — FIND x TEXT
insert into public.pageguide_find_v2_claims (
  id, source_task_id, title, url, task_style, question,
  answer_variants, correctness_mode, evidence_ground_truth,
  answer_text, claim_correct, evidence, citation_anchors,
  page_title, page_html, page_bytes, in_study, task_index, updated_at
)
select
  $q$HARRY-v1$q$,
  $q$HARRY-v1$q$,
  $ti$Harry Potter$ti$,
  $u$https://en.wikipedia.org/wiki/Harry_Potter$u$,
  'find_text',
  $qn$On this page, there are five names listed in a sentence in which Harry assumptions is challenged. Take the first letter of the second name in that sentence. Then find the author who praised Rowling’s work as a feat. Take the first letter of that author’s last name. Put the two letters in alphabetical order. What two-letter string do they form?$qn$,
  v.variants,
  'balanced',
  '{}'::jsonb,
  -- Legacy single-answer columns, back-filled from the grounded variant of the
  -- key this item leans to, exactly as save_pageguide_find_v2_claim does.
  coalesce(v.variants #>> array['correct_grounding', 'answer_text'], ''),
  true,
  '[]'::jsonb,
  '[]'::jsonb,
  $ti$Harry Potter$ti$,
  '',
  0,
  false,   -- no page HTML and no authored grounding yet; see the header
  9,
  now()
from (select public.pageguide_v2_normalize_variants($v${
    "correct_grounding": {
        "answer_text": "KS",
        "citation_anchors": [],
        "evidence": []
    },
    "correct_nongrounding": {
        "answer_text": "KS",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_grounding": {
        "answer_text": "SK",
        "citation_anchors": [],
        "evidence": []
    },
    "incorrect_nongrounding": {
        "answer_text": "SK",
        "citation_anchors": [],
        "evidence": []
    }
}$v$::jsonb) as variants) v
on conflict (id) do update set
  source_task_id = excluded.source_task_id,
  title = excluded.title,
  url = excluded.url,
  task_style = excluded.task_style,
  question = excluded.question,
  answer_variants = excluded.answer_variants,
  correctness_mode = excluded.correctness_mode,
  answer_text = excluded.answer_text,
  claim_correct = excluded.claim_correct,
  task_index = excluded.task_index,
  updated_at = now()
-- Only overwrite a row that is still a seed. Once the extension has published
-- the real four answers the row carries a page, and re-running this file must
-- not put the placeholders back over authored work.
where public.pageguide_find_v2_claims.page_html = '';

-- What landed. Ten rows, each with all four cells, none live yet.
select
  id,
  task_style,
  correctness_mode,
  in_study,
  length(answer_variants #>> array['correct_grounding', 'answer_text'])   as correct_len,
  length(answer_variants #>> array['incorrect_grounding', 'answer_text']) as incorrect_len
from public.pageguide_find_v2_claims
order by task_index;
