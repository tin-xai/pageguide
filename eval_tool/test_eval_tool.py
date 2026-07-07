import json
import os
import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from eval_tool.app import build_phase3_rows, create_app, default_tasks, filter_options
from eval_tool.credentials import Account
from eval_tool.ece import aggregate_task, compute_ece, ece_payload, is_bot_detection_failure
from eval_tool.judge import DEFAULT_LLM_MODEL, LlmJudge, configured_judge_model, normalize_grounding_label, normalize_judge_response
from eval_tool.runner import PlaywrightGuideRunner, _zero_step_explanation, classify_failure_reason, configured_task_model, normalize_input_mode, normalize_max_steps, normalize_region_capture_mode, region_capture_mode_label
from eval_tool.scoring import (
    ALL_FORMULAS,
    apply_manual_evaluation,
    chart_payload,
    compute_confidence,
    effective_success,
    enrich_step_scores,
    evaluation_for_inspector,
    score_step,
    task_outcome,
)
from eval_tool.step_confidence import (
    SpecProgressClient,
    backfill_computed_loop,
    backfill_element_step_similarity,
    backfill_g_progress,
    compute_loop_score,
    compute_loop_score_updated,
    compute_spec_confidence,
    element_key,
    format_low_grounding_summary,
    g_grounding,
    infer_predicted_goal_state,
    loop_metrics_summary,
    low_grounding_summary,
)
from eval_tool.mind2web_levels import (
    difficulty_counts,
    effective_task_difficulty,
    filter_tasks_by_difficulty,
    infer_difficulty_from_reference_length,
    reference_step_count,
)
from eval_tool.tasks import load_tasks, display_task_name, short_site_name


class FollowingPromptShapeTest(unittest.TestCase):
    def _shape_block(self, n_oracle):
        from eval_tool.following_rate import build_following_prompt
        oracle = [{"index": i + 1, "key": f"oracle_{i + 1}", "text": f"step {i + 1}", "url": "u"} for i in range(n_oracle)]
        agent = [{"step": 1, "action": "click", "instruction": "x", "target": "t", "url": "u"}]
        p = build_following_prompt({"task": "t"}, oracle, agent)
        # Only inspect the JSON shape example, not the surrounding rules text.
        start = p.index("{", p.index("exact shape"))
        end = p.index("Rules:")
        return p[start:end]

    def test_shape_has_one_key_per_oracle_step_no_extras(self):
        block = self._shape_block(2)
        # The pre-satisfied key must be empty (no agent steps), not [1, 2].
        self.assertIn('"oracle_1": []', block)
        self.assertIn('"oracle_2": [1, 2]', block)
        self.assertNotIn("oracle_3", block)  # must not invent a third oracle key
        self.assertIn('"pre_satisfied": ["oracle_1"]', block)

    def test_shape_scales_to_three_oracle_steps(self):
        block = self._shape_block(3)
        self.assertIn('"oracle_1": []', block)
        self.assertIn('"oracle_2": [1, 2]', block)
        self.assertIn('"oracle_3": [3, 4]', block)
        self.assertNotIn("oracle_4", block)

    def test_pre_satisfied_example_key_has_empty_array(self):
        # Regression: the key listed in pre_satisfied must map to [] in the example.
        block = self._shape_block(2)
        self.assertIn('"oracle_1": []', block)
        self.assertNotIn('"oracle_1": [1, 2]', block)

    def test_shape_single_oracle_step(self):
        block = self._shape_block(1)
        # A lone oracle step is shown as a normal mapping with no pre-satisfied claim.
        self.assertIn('"oracle_1": [1, 2]', block)
        self.assertNotIn("oracle_2", block)
        self.assertIn('"pre_satisfied": []', block)

    def test_long_target_is_truncated_to_100_chars(self):
        from eval_tool.following_rate import _target_text
        long = "Select a Store Search by zip or city, state Sorry, no store within 100 miles" * 5
        out = _target_text({"target": {"text": long}})
        self.assertEqual(len(out), 100)
        self.assertTrue(out.endswith("…"))

    def test_short_target_is_left_unchanged(self):
        from eval_tool.following_rate import _target_text
        out = _target_text({"target": {"text": "Shop My Store"}})
        self.assertEqual(out, "Shop My Store")

    def test_prompt_agent_target_capped_at_100(self):
        from eval_tool.following_rate import build_following_prompt, _target_text
        long = "x" * 400
        agent = [{"step": 1, "action": "click", "instruction": "i",
                  "target": _target_text({"target": {"text": long}}), "url": "u"}]
        oracle = [{"index": 1, "key": "oracle_1", "text": "s", "url": "u"}]
        p = build_following_prompt({"task": "t"}, oracle, agent)
        agent_line = next(l for l in p.splitlines() if l.startswith("1. action="))
        target_part = agent_line.split("target=", 1)[1].split("; URL", 1)[0]
        self.assertLessEqual(len(target_part), 100)


class AnnotatedDifficultyTest(unittest.TestCase):
    def test_difficulty_from_subgoal_count(self):
        from eval_tool.mind2web_levels import effective_task_difficulty, reference_step_count
        from eval_tool.tasks import EvalTask
        easy = EvalTask(name="t", task_id="annotated-0", task="t", website_url="u",
                        annotated_subgoals=["Visit site.", "Do a thing."])
        medium = EvalTask(name="t", task_id="annotated-6", task="t", website_url="u",
                          annotated_subgoals=["a", "b", "c", "d", "e", "f"])
        self.assertEqual(reference_step_count(easy), 2)
        self.assertEqual(effective_task_difficulty(easy), "easy")
        self.assertEqual(reference_step_count(medium), 6)
        self.assertEqual(effective_task_difficulty(medium), "medium")

    def test_embedded_number_in_subgoal_does_not_inflate_count(self):
        # Regression: a subgoal mentioning "zip code 90028" must not be read as
        # ~90 steps by the numbered-list regex; the count is the subgoal length.
        from eval_tool.mind2web_levels import effective_task_difficulty, reference_step_count
        from eval_tool.tasks import EvalTask
        task = EvalTask(name="t", task_id="annotated-0", task="t", website_url="u",
                        annotated_subgoals=["Visit the Gamestop website.",
                                            "Search using zip code 90028 and set as home store."])
        self.assertEqual(reference_step_count(task), 2)
        self.assertEqual(effective_task_difficulty(task), "easy")

    def test_difficulty_from_subgoals_via_dict(self):
        from eval_tool.mind2web_levels import effective_task_difficulty
        self.assertEqual(effective_task_difficulty({"annotated_subgoals": ["a", "b", "c"]}), "easy")
        self.assertEqual(effective_task_difficulty({"annotated_subgoals": list("abcdefg")}), "medium")


class McNemarTest(unittest.TestCase):
    def test_no_discordant_pairs_is_not_significant(self):
        from eval_tool.stats import mcnemar_test
        r = mcnemar_test(0, 0)
        self.assertEqual(r["n"], 0)
        self.assertEqual(r["p_value"], 1.0)
        self.assertEqual(r["method"], "none")
        self.assertFalse(r["significant"])

    def test_exact_binomial_for_small_discordant_count(self):
        from eval_tool.stats import mcnemar_test
        r = mcnemar_test(8, 1)  # n=9 < 25 -> exact
        self.assertEqual(r["method"], "exact binomial")
        self.assertAlmostEqual(r["p_value"], 0.0390625, places=6)
        self.assertTrue(r["significant"])

    def test_chi_square_for_large_discordant_count(self):
        from eval_tool.stats import mcnemar_test
        r = mcnemar_test(30, 10)  # n=40 >= 25 -> corrected chi-square
        self.assertEqual(r["method"], "chi-square (continuity-corrected)")
        self.assertAlmostEqual(r["statistic"], 9.025, places=3)
        self.assertAlmostEqual(r["p_value"], 0.002663, places=5)
        self.assertTrue(r["significant"])

    def test_p_value_is_symmetric_in_b_and_c(self):
        from eval_tool.stats import mcnemar_test
        self.assertAlmostEqual(mcnemar_test(8, 1)["p_value"], mcnemar_test(1, 8)["p_value"], places=9)
        self.assertAlmostEqual(mcnemar_test(30, 10)["p_value"], mcnemar_test(10, 30)["p_value"], places=9)

    def test_endpoint_returns_stats(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        resp = server_app.test_client().get("/api/mcnemar?b=8&c=1")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertAlmostEqual(data["p_value"], 0.0390625, places=6)
        self.assertTrue(data["significant"])

    def test_endpoint_handles_bad_args(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        resp = server_app.test_client().get("/api/mcnemar?b=abc")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["n"], 0)  # non-int -> 0, c absent -> 0


class JudgeTemperatureTest(unittest.TestCase):
    def test_default_temperature_is_zero(self):
        from eval_tool.judge import LlmJudge, DEFAULT_JUDGE_TEMPERATURE
        self.assertEqual(DEFAULT_JUDGE_TEMPERATURE, 0.0)
        self.assertEqual(LlmJudge().temperature, 0.0)

    def test_temperature_is_configurable_and_clamped(self):
        from eval_tool.judge import LlmJudge, normalize_temperature
        self.assertEqual(LlmJudge(temperature=0.7).temperature, 0.7)
        self.assertEqual(normalize_temperature(5), 2.0)     # clamp high
        self.assertEqual(normalize_temperature(-1), 0.0)    # clamp low
        self.assertEqual(normalize_temperature(""), 0.0)    # blank -> default
        self.assertEqual(normalize_temperature("abc"), 0.0)  # invalid -> default

    def test_temperature_reaches_request_body(self):
        from eval_tool.judge import LlmJudge
        captured = {}

        class _FakeResp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self):
                return json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode()

        def _fake_urlopen(req, timeout=90):
            captured["body"] = json.loads(req.data.decode())
            return _FakeResp()

        judge = LlmJudge(api_key="sk-test", temperature=0.9)
        with patch("urllib.request.urlopen", _fake_urlopen):
            judge._call_openai("prompt", None)
        self.assertEqual(captured["body"]["temperature"], 0.9)


class EvalToolTest(unittest.TestCase):
    def test_following_rate_scores_mapping_with_urls_and_pre_satisfied_start(self):
        from eval_tool.following_rate import score_following_for_task

        class FakeJudge:
            api_key = "key"
            def __init__(self):
                self.prompt = ""
            def _call_openai(self, prompt, image_b64):
                self.prompt = prompt
                return json.dumps({
                    "oracle_1": [],
                    "oracle_2": [1, 2, 3, 4, 5],
                    "oracle_3": [6],
                    "oracle_4": [7],
                    "pre_satisfied": ["oracle_1"],
                })

        judge = FakeJudge()
        result = score_following_for_task({
            "task": {
                "task": "Download the environmental impact report.",
                "website_url": "https://new.mta.info/",
                "reference_steps": "\n".join([
                    "1. Visit the MTA website.",
                    "2. Navigate to the Jamaica Bus Depot expansion project page.",
                    "3. Locate the environmental impact statement details section.",
                    "4. Open or download the report.",
                ]),
                "annotated_reference_urls": [
                    "https://new.mta.info/",
                    "https://new.mta.info/project/jamaica-bus-depot-expansion",
                    "https://new.mta.info/project/jamaica-bus-depot-expansion#environmental-review",
                    "https://new.mta.info/document/jamaica-bus-depot-feis.pdf",
                ],
            },
            "steps": [
                {"isInitial": True, "step": 0, "url": "https://new.mta.info/"},
                {"step": 1, "action": "click", "instruction": "Click Menu", "target": {"text": "Menu"}, "url": "https://new.mta.info/"},
                {"step": 2, "action": "click", "instruction": "Click Search", "target": {"text": "Search"}, "url": "https://new.mta.info/"},
                {"step": 3, "action": "type", "instruction": "Type search query", "target": {"text": "Search"}, "url": "https://new.mta.info/search"},
                {"step": 4, "action": "press", "instruction": "Press Enter", "target": {"text": "Search"}, "url": "https://new.mta.info/search"},
                {"step": 5, "action": "click", "instruction": "Click result", "target": {"text": "Jamaica Bus Depot"}, "url": "https://new.mta.info/search?q=Jamaica"},
                {"step": 6, "action": "scroll", "instruction": "Scroll to review section", "target": {"text": "Environmental review"}, "url": "https://new.mta.info/project/jamaica-bus-depot-expansion"},
                {"step": 7, "action": "click", "instruction": "Click Final Environmental Impact Statement PDF", "target": {"text": "PDF"}, "url": "https://new.mta.info/project/jamaica-bus-depot-expansion#environmental-review"},
                {"step": 8, "action": "click", "instruction": "Click unrelated footer link", "target": {"text": "Careers"}, "url": "https://new.mta.info/document/jamaica-bus-depot-feis.pdf"},
            ],
        }, model="openai/gpt-4o", judge=judge)

        self.assertTrue(result["available"])
        self.assertEqual(result["pre_satisfied"], ["oracle_1"])
        self.assertEqual(result["matched_agent_steps"], 7)
        self.assertEqual(result["total_agent_steps"], 8)
        self.assertEqual(result["completed_oracle_steps"], 3)
        self.assertEqual(result["actionable_oracle_steps"], 3)
        self.assertAlmostEqual(result["following_rate"], 7 / 8)
        self.assertAlmostEqual(result["completion_rate"], 1.0)
        self.assertIn("Oracle plan with recorded/reference URLs", judge.prompt)
        self.assertIn("https://new.mta.info/project/jamaica-bus-depot-expansion#environmental-review", judge.prompt)
        self.assertIn("Agent trajectory with recorded URLs", judge.prompt)

    def test_following_rate_normalization_ignores_invalid_and_duplicate_agent_steps(self):
        from eval_tool.following_rate import normalize_following_mapping

        oracle = [
            {"key": "oracle_1", "index": 1, "text": "A", "url": ""},
            {"key": "oracle_2", "index": 2, "text": "B", "url": ""},
        ]
        agent = [
            {"step": 1, "instruction": "one"},
            {"step": 2, "instruction": "two"},
        ]
        result = normalize_following_mapping(
            {"oracle_1": [1, "1", 99, "bad"], "oracle_2": [2]},
            oracle,
            agent,
        )
        self.assertEqual(result["mapping"], {"oracle_1": [1], "oracle_2": [2]})
        self.assertEqual(result["matched_agent_steps"], 2)
        self.assertEqual(result["completed_oracle_steps"], 2)
        self.assertAlmostEqual(result["following_rate"], 1.0)
        self.assertAlmostEqual(result["completion_rate"], 1.0)

    def test_llm_grounding_label_normalizer_accepts_expected_forms(self):
        self.assertEqual(normalize_grounding_label("Grounded"), "grounded")
        self.assertEqual(normalize_grounding_label("grounded"), "grounded")
        self.assertEqual(normalize_grounding_label("Not Grounded"), "not_grounded")
        self.assertEqual(normalize_grounding_label("not_grounded"), "not_grounded")
        self.assertEqual(normalize_grounding_label("non-grounded"), "not_grounded")
        self.assertIsNone(normalize_grounding_label("maybe"))

    def test_rerun_llm_grounding_labels_stores_per_model_and_skips_inapplicable_steps(self):
        from eval_server.app import rerun_trajectory_llm_grounding_labels

        class FakeJudge:
            api_key = "key"
            def __init__(self):
                self.calls = []
            def judge_grounding_label(self, task, step, element_text):
                self.calls.append((step["step"], element_text))
                return {
                    "available": True,
                    "label": "not_grounded" if step["step"] == 2 else "grounded",
                    "reason": f"reason {step['step']}",
                    "prompt": "prompt",
                    "raw_response": '{"label":"grounded"}',
                }

        trajectory = {
            "task": {"task": "Find a thing"},
            "steps": [
                {"step": 0, "isInitial": True},
                {"step": 1, "action": "click", "instruction": "Click Where", "target": {"llmIndex": 1, "text": "Where"}},
                {"step": 2, "action": "click", "instruction": "Click orange product", "target": {"llmIndex": 2, "text": "Blue dress"}},
                {"step": 3, "action": "scroll", "instruction": "Scroll down", "target": {"llmIndex": 3, "text": "Results"}},
                {"step": 4, "action": "click", "instruction": "Click missing", "target": {"text": "Missing index"}},
            ],
        }
        fake = FakeJudge()
        summary = rerun_trajectory_llm_grounding_labels(trajectory, model="openai/gpt-4o", judge=fake)

        self.assertTrue(summary["updated"])
        self.assertEqual(summary["steps_scored"], 2)
        self.assertEqual(summary["grounded"], 1)
        self.assertEqual(summary["not_grounded"], 1)
        self.assertEqual([call[0] for call in fake.calls], [1, 2])
        self.assertEqual(trajectory["steps"][1]["grounded_llm_labels"]["openai/gpt-4o"]["label"], "grounded")
        self.assertEqual(trajectory["steps"][2]["grounded_llm_labels"]["openai/gpt-4o"]["label"], "not_grounded")

        class GroundedJudge(FakeJudge):
            def judge_grounding_label(self, task, step, element_text):
                return {"available": True, "label": "grounded", "reason": "other", "prompt": "p2", "raw_response": "{}"}

        rerun_trajectory_llm_grounding_labels(trajectory, model="google/gemini-2.5-flash", judge=GroundedJudge())
        self.assertEqual(trajectory["steps"][2]["grounded_llm_labels"]["openai/gpt-4o"]["label"], "not_grounded")
        self.assertEqual(trajectory["steps"][2]["grounded_llm_labels"]["google/gemini-2.5-flash"]["label"], "grounded")

    def test_rerun_llm_grounding_labels_invalid_output_is_unavailable(self):
        from eval_server.app import rerun_trajectory_llm_grounding_labels

        class BadJudge:
            api_key = "key"
            def judge_grounding_label(self, task, step, element_text):
                return {"available": False, "label": None, "reason": "invalid"}

        trajectory = {
            "task": {"task": "Do thing"},
            "steps": [{"step": 1, "action": "click", "instruction": "Click Search", "target": {"llmIndex": 1, "text": "Search"}}],
        }
        summary = rerun_trajectory_llm_grounding_labels(trajectory, model="openai/gpt-4o", judge=BadJudge())
        self.assertFalse(summary["updated"])
        self.assertEqual(summary["steps_scored"], 0)
        self.assertEqual(summary["steps_skipped"], 1)
        self.assertNotIn("grounded_llm_labels", trajectory["steps"][0])

    def test_full_confidence_uses_grounding_and_loop_penalty(self):
        # Full Confidence = clip(G_grounding * (1 - 0.5 * L_t_u), 0, 1): cosine element-step
        # grounding (bucketed) times the loop penalty, no progress term.
        step = {"action": "click", "target": {"llmIndex": 3}, "element_step_similarity": 0.9, "computed_loop_updated": 0.2}
        self.assertAlmostEqual(compute_confidence(step, "full"), 0.9)  # 1.0 * (1 - 0.5*0.2)
        # Legacy LLM-self-report families are unchanged.
        parts = {"grounded": 0.8, "loop": 0.1, "progress": 0.5}
        self.assertAlmostEqual(compute_confidence(parts, "reduced"), 0.736)
        self.assertAlmostEqual(compute_confidence(parts, "noloop"), 0.92)

    def test_full_confidence_ignores_progress_and_buckets_grounding(self):
        def step(sim, loop=0.0, **extra):
            return {"action": "click", "target": {"llmIndex": 1}, "element_step_similarity": sim, "computed_loop_updated": loop, **extra}
        self.assertAlmostEqual(compute_confidence(step(0.90), "full"), 1.0)   # >= 0.84 -> 1.0
        self.assertAlmostEqual(compute_confidence(step(0.80), "full"), 0.5)   # >= 0.78 -> 0.5
        self.assertAlmostEqual(compute_confidence(step(0.50), "full"), 0.1)   # below -> 0.1
        self.assertAlmostEqual(compute_confidence(step(0.90, loop=0.5), "full"), 0.75)  # 1.0 * (1 - 0.25)
        # Progress no longer affects Full Confidence.
        self.assertEqual(compute_confidence(step(0.90, progress=1.0), "full"),
                         compute_confidence(step(0.90, progress=0.0), "full"))

    def test_g_grounding_uses_element_step_similarity_thresholds(self):
        self.assertEqual(g_grounding({"action": "click", "target": {"llmIndex": 7, "text": "Go"}}), 1.0)
        self.assertEqual(g_grounding({"action": "click", "target": {"llmIndex": 7}, "element_step_similarity": 0.84}), 1.0)
        self.assertEqual(g_grounding({"action": "click", "target": {"llmIndex": 7}, "element_step_similarity": 0.83}), 0.5)
        self.assertEqual(g_grounding({"action": "click", "target": {"llmIndex": 7}, "element_step_similarity": 0.78}), 0.5)
        self.assertEqual(g_grounding({"action": "click", "target": {"llmIndex": 7}, "element_step_similarity": 0.77}), 0.1)
        self.assertEqual(g_grounding({"action": "click", "target": {"text": "Go"}}), 0.0)
        self.assertEqual(g_grounding({"action": "click", "target": {}}), 0.0)
        self.assertIsNone(g_grounding({"action": "scroll_down", "target": {"llmIndex": 7}}))
        self.assertIsNone(g_grounding({"action": "done"}))
        self.assertIsNone(g_grounding({"isInitial": True, "target": {"llmIndex": 1}}))

    def test_grounding_boundary_metrics_defaults_grounded_and_excludes_unscored(self):
        from eval_server.app import grounding_boundary_metrics

        steps = [
            {"step": 0, "isInitial": True, "element_step_similarity": 0.0},
            {"step": 1, "element_step_similarity": 0.8},  # default human grounded, predicted grounded
            {"step": 2, "element_step_similarity": 0.7},  # default human grounded, predicted non-grounded
            {"step": 3, "element_step_similarity": 0.9, "grounded_human_label": "non_grounded"},
            {"step": 4, "element_step_similarity": 0.2, "grounded_human_label": "non_grounded"},
            {"step": 5},
        ]
        metrics = grounding_boundary_metrics(steps, threshold=0.8)
        self.assertEqual(metrics["total"], 4)
        self.assertEqual(metrics["tp"], 1)
        self.assertEqual(metrics["fn"], 1)
        self.assertEqual(metrics["fp"], 1)
        self.assertEqual(metrics["tn"], 1)
        self.assertAlmostEqual(metrics["accuracy"], 0.5)
        self.assertAlmostEqual(metrics["precision"], 0.5)
        self.assertAlmostEqual(metrics["recall"], 0.5)
        self.assertAlmostEqual(metrics["f1"], 0.5)
        self.assertEqual(len(metrics["mismatches"]), 2)

    def test_grounding_boundary_metrics_zero_denominators_are_unavailable(self):
        from eval_server.app import grounding_boundary_metrics

        metrics = grounding_boundary_metrics([
            {"step": 1, "element_step_similarity": 0.2, "grounded_human_label": "non_grounded"},
        ], threshold=0.8)
        self.assertEqual(metrics["tn"], 1)
        self.assertIsNone(metrics["precision"])
        self.assertIsNone(metrics["recall"])
        self.assertIsNone(metrics["f1"])

    def test_grounding_youden_index_returns_best_threshold(self):
        from eval_server.app import grounding_youden_index

        summary = grounding_youden_index([
            {"step": 1, "element_step_similarity": 0.9},  # default grounded
            {"step": 2, "element_step_similarity": 0.7},
            {"step": 3, "element_step_similarity": 0.4, "grounded_human_label": "non_grounded"},
            {"step": 4, "element_step_similarity": 0.2, "grounded_human_label": "non_grounded"},
        ])
        self.assertAlmostEqual(summary["threshold"], 0.7)
        self.assertAlmostEqual(summary["youden_j"], 1.0)
        self.assertAlmostEqual(summary["tpr"], 1.0)
        self.assertAlmostEqual(summary["fpr"], 0.0)

    def test_backfill_element_step_similarity_embeds_instruction_and_element_text(self):
        result = {"steps": [
            {"isInitial": True, "target": {"llmIndex": 1}},
            {"step": 1, "action": "click", "instruction": "Click Search", "target": {"llmIndex": 1, "text": "Search"}},
            {"step": 2, "action": "click", "instruction": "", "target": {"llmIndex": 2, "text": "Filter"}},
            {"step": 3, "action": "click", "instruction": "Click missing", "target": {"text": "Missing"}},
            {"step": 4, "action": "done", "instruction": "Done", "target": {"llmIndex": 4, "text": "Done"}},
        ]}
        client = Mock()
        client.available = True
        client.embed.return_value = [[1.0, 0.0], [1.0, 0.0]]
        self.assertTrue(backfill_element_step_similarity(result, client))
        self.assertAlmostEqual(result["steps"][1]["element_step_similarity"], 1.0)
        self.assertAlmostEqual(result["steps"][2]["element_step_similarity"], 0.0)
        self.assertNotIn("element_step_similarity", result["steps"][3])
        self.assertNotIn("element_step_similarity", result["steps"][4])
        client.embed.assert_called_once_with(["Click Search", "Search"])

    def test_spec_progress_client_default_embed_model(self):
        # The backfill must request a model OpenRouter actually serves on /v1/embeddings
        # (text-embedding-ada-002 is hosted there); otherwise embeds return no vectors and
        # element_step_similarity stays null. Keep this in sync with EMBED_MODEL in
        # background/service-worker.js so live and backfill scores agree.
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(SpecProgressClient().embed_model, "openai/text-embedding-ada-002")

    def test_spec_progress_client_embed_model_env_override(self):
        with patch.dict("os.environ", {"PAGEGUIDE_EVAL_EMBED_MODEL": "openai/text-embedding-3-small"}, clear=True):
            self.assertEqual(SpecProgressClient().embed_model, "openai/text-embedding-3-small")

    def test_low_grounding_summary_flags_steps_below_one(self):
        steps = [
            {"isInitial": True, "target": {"llmIndex": 1}},
            {"step": 1, "action": "click", "target": {"llmIndex": 7, "text": "Go"}, "grounded": 0.8},
            {"step": 2, "action": "click", "target": {"llmIndex": 2, "text": "Go"}, "grounded": 1.0, "element_step_similarity": 0.78},
            {"step": 3, "action": "click", "target": {}, "grounded": 1.0},
            {"step": 4, "action": "scroll_down", "target": {"llmIndex": 7}, "grounded": 0.0},
        ]
        summary = low_grounding_summary(steps)
        self.assertTrue(summary["has_issue"])
        self.assertEqual(summary["count"], 2)
        self.assertAlmostEqual(summary["min_grounding"], 0.0)
        self.assertEqual(summary["steps"], [{"step": 2, "g_ground": 0.5}, {"step": 3, "g_ground": 0.0}])
        self.assertIn("Step 2: 0.5", format_low_grounding_summary(summary))

    def test_low_grounding_summary_ignores_fully_grounded_tasks(self):
        summary = low_grounding_summary([
            {"step": 1, "action": "click", "target": {"llmIndex": 1}, "grounded": 0.9},
            {"step": 2, "action": "type", "target": {"llmIndex": 2}, "grounded": 0.8},
        ])
        self.assertFalse(summary["has_issue"])
        self.assertEqual(summary["count"], 0)
        self.assertEqual(format_low_grounding_summary(summary), "")

    def test_low_grounding_summary_ignores_llm_grounded_when_rule_score_is_one(self):
        summary = low_grounding_summary([
            {"step": 3, "action": "click", "target": {"llmIndex": 3}, "grounded": 0.9},
            {"step": 4, "action": "click", "target": {"llmIndex": 19}, "grounded": 0.9},
        ])
        self.assertFalse(summary["has_issue"])
        self.assertEqual(summary["count"], 0)

    def test_infer_predicted_goal_state_from_step_records(self):
        result = {
            "steps": [
                {"step": 1, "predictedGoalState": "Hurricane Harbor Phoenix page is open"},
            ]
        }
        self.assertEqual(
            infer_predicted_goal_state(result),
            "Hurricane Harbor Phoenix page is open",
        )

    def test_compute_spec_confidence_variants(self):
        # index grounded (1.0), loop 0.4, goal relevance 0.6 -> G_t = 0.8
        step = {"action": "click", "target": {"llmIndex": 3}, "loop": 0.4, "g_goal_relevance_score": 0.6}
        self.assertAlmostEqual(compute_spec_confidence(step, "spec_full"), 0.64)      # 0.8 * (1 - 0.5*0.4)
        self.assertAlmostEqual(compute_spec_confidence(step, "spec_noloop"), 0.8)      # no loop penalty
        self.assertAlmostEqual(compute_spec_confidence(step, "spec_noprogress"), 0.8)  # G_t = grounding 1.0 -> *0.8

    def test_compute_spec_confidence_honors_legacy_field_name(self):
        # Stored runs use the old `g_progress_score` key; it must still be read.
        step = {"action": "click", "target": {"llmIndex": 3}, "loop": 0.4, "g_progress_score": 0.6}
        self.assertAlmostEqual(compute_spec_confidence(step, "spec_full"), 0.64)

    def test_compute_spec_confidence_missing_relevance_falls_back_to_grounding(self):
        # No goal-relevance embedding -> grounding-only (no fabricated neutral value).
        step = {"action": "click", "target": {"llmIndex": 3, "text": "Buy"}, "loop": 0.0, "element_step_similarity": 0.78}
        self.assertAlmostEqual(compute_spec_confidence(step, "spec_full"), 0.5)
        self.assertIsNone(compute_spec_confidence({"action": "done"}, "spec_full"))

    def test_compute_spec_confidence_prefers_updated_loop_with_legacy_fallback(self):
        base = {"action": "click", "target": {"llmIndex": 3}, "computed_loop": 0.0, "computed_loop_updated": 0.6}
        self.assertAlmostEqual(compute_spec_confidence(base, "spec_noprogress"), 0.7)

        legacy = {"action": "click", "target": {"llmIndex": 3}, "computed_loop": 0.6}
        self.assertAlmostEqual(compute_spec_confidence(legacy, "spec_noprogress"), 0.7)

    def test_action_key_is_text_based(self):
        # Reference _action_key: first non-empty of element_text/desc/description/instruction.
        self.assertEqual(element_key({"target": {"text": "  Search "}}), "search")
        self.assertEqual(element_key({"instruction": "Click Save"}), "click save")
        # element_text wins over instruction.
        self.assertEqual(element_key({"target": {"text": "Search"}, "instruction": "x"}), "search")
        self.assertEqual(element_key({}), "")

    def test_compute_loop_score_matches_reference(self):
        # Worked example from the reference implementation.
        actions = [
            {"type": "click", "target": {"text": "Search"}},
            {"type": "click", "target": {"text": "Filters"}},
            {"type": "click", "target": {"text": "Search"}},
            {"type": "click", "target": {"text": "Search"}},
        ]
        self.assertEqual(compute_loop_score(actions[0], actions[:0]), 0.0)      # no prev
        self.assertEqual(compute_loop_score(actions[1], actions[:1]), 0.0)      # 0/10
        self.assertAlmostEqual(compute_loop_score(actions[2], actions[:2]), 0.1)    # 1/10
        self.assertAlmostEqual(compute_loop_score(actions[3], actions[:3]), 0.2)  # 2/10

    def test_updated_loop_requires_same_action_type_and_text(self):
        actions = [
            {"action": "click", "target": {"text": "Search"}},
            {"action": "type", "target": {"text": "Search"}},
            {"action": "click", "target": {"text": "Search"}},
        ]
        self.assertEqual(compute_loop_score_updated(actions[1], actions[:1]), 0.0)
        self.assertAlmostEqual(compute_loop_score_updated(actions[2], actions[:2]), 0.1)

    def test_backfill_computed_loop_uses_prev_action_denominator(self):
        steps = [
            {"step": 0, "isInitial": True},
            {"step": 1, "action": "click", "target": {"text": "Search"}},
            {"step": 2, "action": "click", "target": {"text": "Filters"}},
            {"step": 3, "action": "click", "target": {"text": "Search"}},
            {"step": 4, "action": "click", "target": {"text": "Search"}},
        ]
        backfill_computed_loop({"steps": steps})
        self.assertEqual(steps[0]["computed_loop"], 0.0)        # initial excluded
        self.assertEqual(steps[0]["computed_loop_updated"], 0.0)
        self.assertEqual(steps[1]["computed_loop"], 0.0)        # 0/10 -> 0
        self.assertEqual(steps[2]["computed_loop"], 0.0)        # 0/10
        self.assertAlmostEqual(steps[3]["computed_loop"], 0.1)  # 1/10
        self.assertAlmostEqual(steps[4]["computed_loop"], 0.2)  # 2/10
        self.assertEqual(steps[1]["action_key_updated"], "click: search")
        self.assertAlmostEqual(steps[3]["computed_loop_updated"], 0.1)
        self.assertAlmostEqual(steps[4]["computed_loop_updated"], 0.2)

    def test_backfill_updated_loop_does_not_match_click_and_type_same_text(self):
        steps = [
            {"step": 0, "isInitial": True},
            {"step": 1, "action": "click", "target": {"text": "Search"}},
            {"step": 2, "action": "type", "target": {"text": "Search"}},
            {"step": 3, "action": "click", "target": {"text": "Search"}},
        ]
        backfill_computed_loop({"steps": steps})
        self.assertEqual(steps[2]["computed_loop_updated"], 0.0)
        self.assertAlmostEqual(steps[3]["computed_loop_updated"], 0.1)

    def test_loop_metrics_summary_counts_steps_above_half(self):
        steps = [{"step": 0, "isInitial": True}]
        for i in range(1, 10):  # 9 steps
            steps.append({"step": i, "action": "click", "target": {"text": "Search"}})
        summary = loop_metrics_summary(steps)
        self.assertEqual(summary["loop_steps_updated"], 3)  # steps 7, 8, 9 (L_t_u values: 0.6, 0.7, 0.8)
        self.assertEqual(summary["loop_task_updated"], 1)
        self.assertAlmostEqual(summary["min_loop_updated"], 0.0)
        self.assertAlmostEqual(summary["max_loop_updated"], 0.8)

    def test_loop_metrics_summary_zero_when_no_step_exceeds_half(self):
        steps = [{"step": 0, "isInitial": True}]
        for i in range(1, 9):
            steps.append({"step": i, "action": "click", "target": {"text": f"Unique {i}"}})
        for i in range(9, 15):  # 6 steps of Select My Car
            steps.append({"step": i, "action": "click", "target": {"text": "Select My Car"}})
        summary = loop_metrics_summary(steps)
        self.assertEqual(summary["loop_steps_updated"], 0)  # max loop score is 5/10 = 0.5, which is not > 0.5
        self.assertEqual(summary["loop_task_updated"], 1)
        self.assertAlmostEqual(summary["max_loop_updated"], 0.5)

    def test_loop_metrics_summary_task_flag_uses_point_three_threshold(self):
        steps = [{"step": 0, "isInitial": True}]
        for i in range(1, 5):
            steps.append({"step": i, "action": "click", "target": {"text": "Search"}})
        summary = loop_metrics_summary(steps)
        self.assertEqual(summary["loop_task_updated"], 1)
        self.assertAlmostEqual(summary["max_loop_updated"], 0.3)

    def test_mind2web_difficulty_buckets(self):
        self.assertEqual(infer_difficulty_from_reference_length(5), "easy")
        self.assertEqual(infer_difficulty_from_reference_length(6), "medium")
        self.assertEqual(infer_difficulty_from_reference_length(12), "medium")
        self.assertEqual(infer_difficulty_from_reference_length(13), "hard")
        counts = difficulty_counts(load_tasks("mind2web"))
        self.assertEqual(sum(counts.values()), 100)
        self.assertEqual(counts["easy"], 39)
        self.assertEqual(counts["medium"], 50)
        self.assertEqual(counts["hard"], 11)

    def test_filter_mind2web_by_difficulty(self):
        tasks = load_tasks("mind2web")
        easy = filter_tasks_by_difficulty(tasks, "easy")
        self.assertTrue(easy)
        self.assertTrue(all(effective_task_difficulty(task) == "easy" for task in easy))

    def test_difficulty_prefers_reference_length_over_dataset_label(self):
        task = {"reference_length": "11", "level": "Hard"}
        self.assertEqual(effective_task_difficulty(task), "medium")

    def test_reference_step_count_prefers_reference_length_over_reference_steps(self):
        task = {"reference_length": "4", "reference_steps": "1. One\n2. Two\n3. Three\n4. Four\n5. Five\n6. Six"}
        self.assertEqual(reference_step_count(task), 4)
        self.assertEqual(effective_task_difficulty(task), "easy")

    def test_no_login_difficulty_uses_reference_ground_truth_steps(self):
        tasks = load_tasks("no_login")
        counts = difficulty_counts(tasks)
        self.assertEqual(counts["easy"], 6)
        self.assertEqual(counts["medium"], 6)
        self.assertEqual(counts["hard"], 0)
        self.assertEqual(reference_step_count(tasks[0]), 6)

    def test_reference_step_count_handles_embedded_numbered_steps(self):
        task = {"reference_steps": "1. Open site\n2. Type Austin 3. Click Search 4. Filter"}
        self.assertEqual(reference_step_count(task), 4)

    def test_task_set_options_and_labels_include_annotated_dataset(self):
        from eval_tool.storage import task_set_options, normalize_task_set, task_set_label
        ids = {opt["id"] for opt in task_set_options()}
        self.assertIn("annotated", ids)
        self.assertEqual(normalize_task_set("annotated"), "annotated")
        self.assertEqual(task_set_label("annotated"), "Annotated Dataset")
        self.assertEqual(task_set_label("online_mind2web"), "Online-Mind2Web")
        # Unknown / missing sources degrade gracefully instead of mislabeling.
        self.assertEqual(task_set_label(""), "Unknown")
        self.assertEqual(task_set_label("something_else"), "something_else")

    def test_load_annotated_json_dataset(self):
        from eval_tool.tasks import _load_json_tasks
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AnnotatedDataset.json"
            path.write_text(json.dumps([
                {
                    "index": 0,
                    "task": "Find the closest store",
                    "key_nodes": [
                        {"content": {"url": None}},
                        {"content": {"url": "https://www.example.com/"}, "match_function_name": "url_included_match"},
                        {"content": {"url": "https://www.example.com/search?q=store"}, "match_function_name": "url_exactly_match"},
                    ],
                    "subgoals": ["Visit the site.", "Search for the store."],
                },
                # No usable URL -> skipped.
                {"index": 1, "task": "No url task", "key_nodes": [{"content": {"url": None}}], "subgoals": []},
                # No task text -> skipped.
                {"index": 2, "task": "", "key_nodes": [{"content": {"url": "https://x.com/"}}]},
            ]), encoding="utf-8")
            tasks = _load_json_tasks(path)
        self.assertEqual(len(tasks), 1)
        task = tasks[0]
        self.assertEqual(task.task_id, "annotated-0")
        self.assertEqual(task.task, "Find the closest store")
        self.assertEqual(task.website_url, "https://www.example.com/")
        self.assertEqual(task.reference_steps, "Visit the site.\nSearch for the store.")
        self.assertEqual(task.success_criteria, "Visit the site.\nSearch for the store.")
        self.assertEqual(task.annotated_subgoals, ["Visit the site.", "Search for the store."])
        self.assertEqual(task.annotated_reference_urls, ["", "https://www.example.com/", "https://www.example.com/search?q=store"])
        self.assertEqual(task.annotated_match_functions, ["", "url_included_match", "url_exactly_match"])

    def test_load_tasks_dispatches_annotated_dataset_to_json_loader(self):
        # The real dataset file ships with the repo; the "annotated" task set must resolve to it.
        tasks = load_tasks("annotated")
        self.assertTrue(tasks)
        self.assertTrue(all(t.website_url for t in tasks))
        self.assertTrue(all(t.task_id.startswith("annotated-") for t in tasks))

    def test_eval_server_dashboard_filters_no_login_by_reference_steps(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        with patch("eval_server.app.list_auto_runs", return_value=[]), \
             patch("eval_server.app.collect_starred_tasks", return_value=[]):
            response = server_app.test_client().get("/?tab=automatic&task_set=no_login&difficulty=easy")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Reference Length:", response.data)
        self.assertIn(b"Easy (6)", response.data)
        self.assertIn(b"Medium (6)", response.data)
        self.assertIn(b"Hard (0)", response.data)
        self.assertIn(b'value=\"easy\" selected', response.data)
        self.assertIn(b'data-difficulty=\"easy\"', response.data)
        self.assertNotIn(b'data-difficulty=\"medium\"', response.data)
        self.assertNotIn(b'data-difficulty=\"hard\"', response.data)

    def test_eval_server_dashboard_filters_online_mind2web_by_reference_length(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        with patch("eval_server.app.list_auto_runs", return_value=[]), \
             patch("eval_server.app.collect_starred_tasks", return_value=[]):
            response = server_app.test_client().get("/?tab=automatic&task_set=online_mind2web&difficulty=hard")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Reference Length:", response.data)
        self.assertIn(b"Easy (80)", response.data)
        self.assertIn(b"Medium (176)", response.data)
        self.assertIn(b"Hard (44)", response.data)
        self.assertIn(b'value=\"hard\" selected', response.data)
        self.assertIn(b'data-difficulty=\"hard\"', response.data)
        self.assertNotIn(b'data-difficulty=\"medium\"', response.data)
        self.assertNotIn(b'data-difficulty=\"easy\"', response.data)

    def test_run_detail_renders_per_task_sparkline_with_metric_series(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {"run_id": "r1", "status": "completed", "task_ids": ["t1"], "task_set": "no_login"}
        result = {
            "task_id": "t1", "task": {"task": "Do thing"}, "session_id": "s1",
            "judge": {"success": True},
            "steps": [
                {"step": 1, "action": "click", "target": {"llmIndex": 1},
                 "element_step_similarity": 0.9, "computed_loop_updated": 0.0},
                {"step": 2, "action": "click", "target": {"llmIndex": 2},
                 "element_step_similarity": 0.6, "computed_loop_updated": 0.7},
            ],
        }
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.list_task_results", return_value=[result]), \
             patch("eval_server.app.is_running", return_value=False), \
             patch("eval_server.app.load_stars", return_value={}):
            response = server_app.test_client().get("/runs/r1")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'class="task-sparkline"', response.data)
        self.assertIn(b"toggleSparkMetric(", response.data)
        # The metric is presented as Step Uncertainty (inverted), not Confidence.
        self.assertIn(b"Step Uncertainty", response.data)
        self.assertNotIn(b"Full Confidence", response.data)
        # The serialized per-step series feeding the sparkline carries the three metrics.
        self.assertIn(b"step_uncertainty", response.data)
        self.assertIn(b"element_step_similarity", response.data)
        self.assertIn(b"computed_loop_updated", response.data)

    def test_step_metrics_emits_step_uncertainty_as_one_minus_confidence(self):
        from eval_server.app import _step_metrics, _to_uncertainty
        steps = [
            {"step": 1, "action": "click", "target": {"llmIndex": 1},
             "element_step_similarity": 0.9, "computed_loop_updated": 0.0},
            {"step": 2, "action": "click", "target": {"llmIndex": 2},
             "element_step_similarity": 0.6, "computed_loop_updated": 0.7},
        ]
        metrics, _ = _step_metrics(steps)
        for m in metrics:
            self.assertIn("step_uncertainty", m)
            if m["mech_confidence"] is None:
                self.assertIsNone(m["step_uncertainty"])
            else:
                self.assertAlmostEqual(m["step_uncertainty"], 1.0 - m["mech_confidence"])
        # Helper clamps and passes None through.
        self.assertIsNone(_to_uncertainty(None))
        self.assertEqual(_to_uncertainty(0.0), 1.0)
        self.assertEqual(_to_uncertainty(1.0), 0.0)
        self.assertEqual(_to_uncertainty(1.5), 0.0)

    def test_step_metrics_uncertainty_uses_raw_grounding_not_bucketed(self):
        # G=0.84 buckets to 1.0 under g_grounding, so the OLD path gave uncertainty 0.0. The raw
        # formula U = 1 - G*(1-0.5*L) gives 0.16 at loop 0 (loop is recomputed to 0 for a lone step).
        from eval_server.app import _step_metrics
        steps = [{"step": 1, "action": "click", "target": {"llmIndex": 1},
                  "element_step_similarity": 0.84, "computed_loop_updated": 0.0}]
        metrics, _ = _step_metrics(steps)
        self.assertAlmostEqual(metrics[0]["step_uncertainty"], 0.16)
        self.assertAlmostEqual(metrics[0]["mech_confidence"], 0.84)

    def test_grounding_metrics_counts_mid_trajectory_tasks_by_outcome(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {"run_id": "rG", "status": "completed", "task_ids": ["p1", "f1"], "task_model": "openai/gpt-4.1-nano"}

        def steps(target_sims):
            # Loop (L_t_u) is recomputed from action+target text by backfill_computed_loop, so we
            # drive it via repeated targets. target_sims is a list of (target_text, similarity).
            out = [{"step": 0, "isInitial": True}]
            for i, (tgt, sim) in enumerate(target_sims, start=1):
                out.append({"step": i, "action": "click", "target": {"text": tgt, "llmIndex": i},
                            "instruction": "click " + tgt, "element_step_similarity": sim})
            return out

        # Passed task: same target every step -> interior L_t_u = 1.0 (>=0.3), and interior step 3
        # is misgrounded (0.5 < 0.8). First & last are excluded but here interior alone qualifies.
        passed = {"task_id": "p1", "task": {"task": "p"}, "judge": {"success": True},
                  "steps": steps([("Watch", 0.9), ("Watch", 0.9), ("Watch", 0.5), ("Watch", 0.9), ("Watch", 0.9)])}
        # Failed task: distinct targets (no loop) and only the FIRST and LAST steps misgrounded;
        # the interior is clean -> neither mid flag should trip.
        failed = {"task_id": "f1", "task": {"task": "f"}, "judge": {"success": False},
                  "steps": steps([("A", 0.5), ("B", 0.9), ("C", 0.9), ("D", 0.9), ("E", 0.5)])}

        with TemporaryDirectory() as tmp:
            import eval_server.app as sapp
            tasks_dir = Path(tmp) / "rG" / "tasks"
            tasks_dir.mkdir(parents=True)
            for r in (passed, failed):
                (tasks_dir / (r["task_id"] + ".json")).write_text(json.dumps(r), encoding="utf-8")
            with patch("eval_server.app.load_run", return_value=run), \
                 patch.object(sapp, "RUNS_DIR", tmp):
                resp = server_app.test_client().post("/api/grounding_metrics", json={
                    "run_ids": ["rG"], "threshold": 0.8, "label_source": "human", "outcome_filter": "all",
                })
        self.assertEqual(resp.status_code, 200)
        model = sapp._grounding_display_model_name("openai/gpt-4.1-nano")
        groups = resp.get_json()["__summary"]["models"][model]["groups"]
        # Passed task has an interior misgrounded + loop(>=0.3) step; failed task does not.
        self.assertEqual(groups["success"]["tasks_with_mid_misgrounding"], 1)
        self.assertEqual(groups["success"]["tasks_with_mid_loop"], 1)
        self.assertEqual(groups["failed"]["tasks_with_mid_misgrounding"], 0)
        self.assertEqual(groups["failed"]["tasks_with_mid_loop"], 0)

    def test_dashboard_runs_included_carries_feature_filter_flags(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        runs = [{
            "run_id": "run-abc", "status": "completed", "task_ids": ["t1"],
            "task_model": "openai/gpt-4.1-nano",
            "automatic_planning_mode": True,
            "inject_grounding_warning": True,
            "inject_looping_warning": False,
        }]
        with patch("eval_server.app.list_auto_runs", return_value=runs), \
             patch("eval_server.app.collect_starred_tasks", return_value=[]):
            response = server_app.test_client().get("/?tab=automatic")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'class="run-feature-filter"', response.data)
        self.assertIn(b'applyRunFeatureFilter()', response.data)
        # Flags surface as data-attributes the client filter reads (planning/grounding on, loop off).
        self.assertIn(b'data-planning="1"', response.data)
        self.assertIn(b'data-grounding="1"', response.data)
        self.assertIn(b'data-loop="0"', response.data)

    def test_score_step_dispatches_by_family(self):
        step = {"action": "click", "target": {"llmIndex": 1}, "grounded": 0.8, "loop": 0.1, "progress": 0.5}
        self.assertEqual(score_step(step, "full"), compute_confidence(step, "full"))
        self.assertEqual(score_step(step, "spec_full"), compute_spec_confidence(step, "spec_full"))
        self.assertEqual(set(ALL_FORMULAS), {"full", "reduced", "noloop", "spec_full", "spec_noloop", "spec_noprogress"})

    def test_effective_success_prefers_human_override(self):
        self.assertTrue(effective_success({"judge": {"success": False}, "human_success": True}))
        self.assertFalse(effective_success({"judge": {"success": True}, "human_success": False}))
        self.assertTrue(effective_success({"judge": {"success": True}}))
        self.assertFalse(effective_success({"judge": {"success": False}}))
        self.assertTrue(effective_success({"evaluation": {"status": "success"}, "judge": {"success": False}}))

    def test_task_outcome_prefers_manual_and_saved_evaluation(self):
        self.assertEqual(task_outcome({"human_success": True, "judge": {"success": False}}), "success")
        self.assertEqual(task_outcome({"evaluation": {"status": "failed"}, "judge": {"success": True}}), "failed")
        self.assertEqual(task_outcome({"judge": {"success": True}}), "success")
        self.assertEqual(task_outcome({"judge": {"success": False}}), "failed")
        self.assertEqual(task_outcome({}), "pending")

    def test_evaluation_for_inspector_prefills_from_llm_judge(self):
        evaluation, source = evaluation_for_inspector({
            "judge": {"success": False, "failureCategory": "ACCESS DENIED", "reason": "Blocked"},
        })
        self.assertEqual(source, "llm_judge")
        self.assertEqual(evaluation["status"], "failed")
        self.assertIn("ACCESS DENIED", evaluation["error_types"])

    def test_apply_manual_evaluation_syncs_human_success(self):
        updated = apply_manual_evaluation(
            {"judge": {"success": False}, "task_id": "t1"},
            status="success",
            notes="Looks correct to me",
        )
        self.assertTrue(updated["human_success"])
        self.assertEqual(updated["evaluation"]["status"], "success")
        self.assertEqual(updated["evaluation"]["source"], "human")
        self.assertTrue(effective_success(updated))

    def test_compute_ece_zero_when_calibrated_and_nonzero_on_gap(self):
        calibrated = compute_ece([1.0, 1.0, 0.0], [1.0, 1.0, 0.0], n_bins=5)
        self.assertAlmostEqual(calibrated["ece"], 0.0)
        gap = compute_ece([0.9, 0.9], [1.0, 0.0], n_bins=5)
        self.assertAlmostEqual(gap["ece"], 0.4)  # |0.5 - 0.9|
        self.assertEqual(len(gap["bins"]), 5)

    def test_aggregate_task_modes(self):
        steps = [
            {"step": 1, "action": "click", "target": {"llmIndex": 1}, "loop": 0.0, "g_goal_relevance_score": 1.0},  # 1.0
            {"step": 2, "action": "click", "target": {"llmIndex": 2, "text": "x"}, "loop": 0.0, "g_goal_relevance_score": 0.0, "element_step_similarity": 0.78},  # 0.25
            {"step": 0, "isInitial": True},
            {"step": 3, "action": "scroll_down"},  # excluded (no grounding)
        ]
        self.assertAlmostEqual(aggregate_task(steps, "spec_full", "last"), 0.25)
        self.assertAlmostEqual(aggregate_task(steps, "spec_full", "min"), 0.25)
        self.assertAlmostEqual(aggregate_task(steps, "spec_full", "mean"), 0.625)

    def test_ece_payload_excludes_bot_detection_and_uses_effective_label(self):
        results = [
            {
                "task_id": "ok", "task": {"task": "t"},
                "judge": {"success": False}, "human_success": True,
                "steps": [{"step": 1, "action": "click", "target": {"llmIndex": 1}, "loop": 0.0}],
            },
            {
                "task_id": "blocked", "task": {"task": "t"},
                "judge": {"success": False, "failureCategory": "ACCESS DENIED"},
                "steps": [{"step": 1, "action": "click", "target": {"llmIndex": 1}, "loop": 0.0}],
            },
        ]
        self.assertTrue(is_bot_detection_failure(results[1]))
        payload = ece_payload(results, "spec_full")
        self.assertEqual(payload["n"], 1)
        self.assertEqual(payload["excluded_bot_detection"], 1)
        self.assertEqual(payload["points"][0]["label"], 1.0)  # human override wins

    def test_set_task_label_route_persists_override(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "r1", "status": "completed", "task_ids": ["t1"]}
        result = {"task_id": "t1", "judge": {"success": False}, "steps": []}
        saved = []
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.load_task_result", return_value=result), \
             patch("eval_tool.app.save_task_result", side_effect=lambda r, t, d: saved.append(d)):
            response = app.test_client().post("/runs/r1/tasks/t1/label", data={"human_success": "true"})
        self.assertEqual(response.status_code, 302)
        self.assertIs(saved[-1]["human_success"], True)
        self.assertTrue(effective_success(saved[-1]))

    def test_rerun_with_gt_route_enables_ground_truth_mode(self):
        app = create_app()
        app.config.update(TESTING=True)
        task = load_tasks("no_login")[0]
        source = {
            "run_id": "r1", "status": "completed", "task_set": "no_login",
            "task_ids": [task.task_id], "max_steps": 15,
            "task_model": DEFAULT_LLM_MODEL, "judge_model": DEFAULT_LLM_MODEL,
        }
        fake_run = {"run_id": "r1-gt", "created_at": "now", "status": "queued", "task_ids": []}
        saved = []
        with patch("eval_tool.app.load_run", return_value=source), \
             patch("eval_tool.app.create_run", return_value=fake_run), \
             patch("eval_tool.app.save_run", side_effect=lambda run: saved.append(run) or run), \
             patch("eval_tool.app.start_run") as start_run:
            response = app.test_client().post("/runs/r1/rerun-with-gt")
        self.assertEqual(response.status_code, 302)
        self.assertTrue(saved[-1]["ground_truth_mode"])
        self.assertEqual(saved[-1]["gt_of"], "r1")
        self.assertEqual(start_run.call_args.args[1][0].task_id, task.task_id)

    def test_run_page_renders_five_plots_inline(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "r1", "status": "completed", "task_ids": ["t1"]}
        result = {
            "task_id": "t1", "task": {"task": "Do thing"},
            "judge": {"success": True},
            "steps": enrich_step_scores([
                {"step": 1, "action": "click", "target": {"llmIndex": 1}, "loop": 0.0, "progress": 0.5, "grounded": 0.9},
            ]),
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.list_task_results", return_value=[result]), \
             patch("eval_tool.app.is_running", return_value=False), \
             patch("eval_tool.app.backfill_spec_progress"):
            response = app.test_client().get("/runs/r1")
        self.assertEqual(response.status_code, 200)
        for canvas_id in (b'id="plotA"', b'id="plotC"', b'id="plotD"', b'id="plotE"', b'id="calibration"'):
            self.assertIn(canvas_id, response.data)

    def test_completed_run_can_rerun_subgoal_progress(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "r1", "status": "completed", "task_ids": ["t1"]}
        result = {
            "task_id": "t1", "task": {"task": "Do thing"},
            "judge": {"success": True},
            "steps": enrich_step_scores([
                {"step": 1, "action": "click", "target": {"llmIndex": 1}, "loop": 0.0, "progress": 0.5, "grounded": 0.9},
            ]),
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.list_task_results", return_value=[result]), \
             patch("eval_tool.app.is_running", return_value=False), \
             patch("eval_tool.app.backfill_spec_progress"), \
             patch("eval_tool.app.rerun_subgoal_progress_for_results", return_value={
                 "tasks_updated": 1,
                 "tasks_skipped": 0,
                 "steps_scored": 1,
             }) as rerun:
            client = app.test_client()
            page = client.get("/runs/r1")
            self.assertEqual(page.status_code, 200)
            self.assertIn(b"Rerun Subgoal Progress", page.data)

            response = client.post("/runs/r1/subgoal-progress/rerun")
        self.assertEqual(response.status_code, 302)
        self.assertIn("subgoal_rerun=1", response.headers["Location"])
        rerun.assert_called_once()

    def test_completed_task_page_can_rerun_subgoal_progress_for_one_task(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "r1", "status": "completed", "task_ids": ["t1"]}
        result = {
            "task_id": "t1",
            "task": {"name": "task one", "task": "Do thing", "website_url": "https://example.test"},
            "judge": {"success": True, "confidence": 0.9, "reason": "Done"},
            "terminal_reason": "DONE",
            "steps": enrich_step_scores([
                {"step": 1, "action": "click", "target": {"llmIndex": 1}, "loop": 0.0, "progress": 0.5, "grounded": 0.9},
            ]),
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.load_task_result", return_value=result), \
             patch("eval_tool.app.is_running", return_value=False), \
             patch("eval_tool.app.rerun_subgoal_progress_for_results", return_value={
                 "tasks_updated": 1,
                 "tasks_skipped": 0,
                 "steps_scored": 1,
             }) as rerun:
            client = app.test_client()
            page = client.get("/runs/r1/tasks/t1")
            self.assertEqual(page.status_code, 200)
            self.assertIn(b"Rerun Subgoal Progress for This Task", page.data)

            response = client.post("/runs/r1/tasks/t1/subgoal-progress/rerun")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/runs/r1/tasks/t1", response.headers["Location"])
        self.assertIn("subgoal_rerun=1", response.headers["Location"])
        rerun.assert_called_once()
        self.assertEqual(rerun.call_args.args[1], [result])

    def test_charts_route_redirects_to_run_page(self):
        app = create_app()
        app.config.update(TESTING=True)
        with patch("eval_tool.app.load_run", return_value={"run_id": "r1"}):
            response = app.test_client().get("/runs/r1/charts")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/runs/r1", response.headers["Location"])

    def test_chart_payload_aggregates_by_step(self):
        result = {
            "task_id": "t1",
            "task": {"task": "Do thing"},
            "judge": {"success": True},
            "steps": enrich_step_scores([
                {"step": 1, "action": "click", "target": {"llmIndex": 1}, "element_step_similarity": 0.9, "computed_loop_updated": 0.0},
                {"step": 2, "action": "click", "target": {"llmIndex": 2}, "element_step_similarity": 0.9, "computed_loop_updated": 0.5},
            ]),
        }
        payload = chart_payload([result])
        self.assertEqual(payload["aggregate"][0]["step"], 1)
        self.assertAlmostEqual(payload["aggregate"][0]["full"], 1.0)  # G_grounding 1.0 * (1 - 0.5*0.0)
        self.assertEqual(payload["tasks"][0]["task_id"], "t1")

    def test_chart_payload_accepts_full_ground_truth_formula(self):
        result = {
            "task_id": "t1",
            "task": {"task": "Do thing"},
            "judge": {"success": False},
            "steps": [{
                "step": 1,
                "confidence_versions": {
                    "full": 0.7,
                    "reduced": 0.6,
                    "noloop": 0.8,
                    "full_ground_truth": 0.9,
                },
            }],
        }
        payload = chart_payload([result])
        self.assertIn("full_ground_truth", payload["formulas"])
        self.assertAlmostEqual(payload["aggregate"][0]["full_ground_truth"], 0.9)

    def test_chart_payload_keeps_zero_step_task_for_per_task_display(self):
        payload = chart_payload([{
            "task_id": "t-empty",
            "task": {"task": "No steps"},
            "judge": {"success": False},
            "steps": [],
        }])
        self.assertEqual(payload["tasks"][0]["task_id"], "t-empty")
        self.assertEqual(payload["tasks"][0]["points"], [])
        self.assertEqual(payload["aggregate"], [])

    def test_normalize_judge_response_defaults_unknown_category(self):
        normalized = normalize_judge_response({
            "success": False,
            "failureCategory": "SOMETHING ELSE",
            "reason": "unclear",
            "confidence": 2,
        })
        self.assertEqual(normalized["failureCategory"], "UNKNOWN FAILURE")
        self.assertEqual(normalized["confidence"], 1.0)

    def test_judge_llm_failure_is_non_fatal(self):
        judge = LlmJudge(api_key="test")
        with TemporaryDirectory() as tmp:
            screenshot = Path(tmp) / "shot.png"
            screenshot.write_bytes(b"fake")
            with patch.object(judge, "_call_openai", side_effect=RuntimeError("HTTP Error 402: Payment Required")):
                result = judge.judge_final_screenshot({"task": "Do thing"}, screenshot)
        self.assertFalse(result["success"])
        self.assertEqual(result["failureCategory"], "UNKNOWN FAILURE")
        self.assertIn(DEFAULT_LLM_MODEL, result["reason"])

    def test_default_models_are_gemini_flash_lite(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(configured_task_model(), DEFAULT_LLM_MODEL)
            self.assertEqual(configured_judge_model(), DEFAULT_LLM_MODEL)
            self.assertEqual(LlmJudge(api_key="test").model, DEFAULT_LLM_MODEL)

    def test_csv_loader_keeps_all_runnable_rows_and_maps_ground_truth_steps(self):
        tasks = load_tasks("no_login")
        self.assertGreaterEqual(len(tasks), 2)
        self.assertTrue(any(task.task_id.startswith("csv-") for task in tasks))
        self.assertTrue(any("\n" in task.reference_steps for task in tasks if task.reference_steps))

    def test_csv_loader_can_switch_between_no_login_and_login_sets(self):
        no_login = load_tasks("no_login")
        login = load_tasks("login")
        self.assertTrue(any("expedia" in task.name.lower() for task in no_login))
        self.assertTrue(any((task.need_login or "").lower() == "yes" for task in login))

    def test_rerun_current_csv_route_uses_all_current_csv_tasks(self):
        app = create_app()
        app.config.update(TESTING=True)
        fake_run = {"run_id": "test-rerun", "created_at": "now", "status": "queued", "task_ids": []}
        with patch("eval_tool.app.create_run", return_value=fake_run), \
             patch("eval_tool.app.start_run") as start_run:
            response = app.test_client().post("/runs/rerun-current-csv")
        self.assertEqual(response.status_code, 302)
        args = start_run.call_args.args
        self.assertEqual(len(args[1]), len(default_tasks(load_tasks("no_login"))))

    def test_create_run_uses_selected_task_set(self):
        app = create_app()
        app.config.update(TESTING=True)
        login_task = load_tasks("login")[0]
        fake_run = {"run_id": "test-login-run", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_tool.app.create_run", return_value=fake_run), \
             patch("eval_tool.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_tool.app.start_run") as start_run:
            response = app.test_client().post("/runs", data={
                "task_set": "login",
                "max_steps": "27",
                "task_model": "google/gemini-2.5-pro",
                "judge_model": "openai/gpt-4o",
                "task_ids": [login_task.task_id],
            })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(start_run.call_args.args[1][0].task_id, login_task.task_id)
        self.assertEqual(saved_runs[-1]["max_steps"], 27)
        self.assertEqual(saved_runs[-1]["task_model"], "google/gemini-2.5-pro")
        self.assertEqual(saved_runs[-1]["judge_model"], "openai/gpt-4o")

    def test_create_run_invalid_models_fall_back_to_default(self):
        app = create_app()
        app.config.update(TESTING=True)
        task = load_tasks("no_login")[0]
        fake_run = {"run_id": "test-model-run", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_tool.app.create_run", return_value=fake_run), \
             patch("eval_tool.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_tool.app.start_run"):
            response = app.test_client().post("/runs", data={
                "task_model": "not-a-real-model",
                "judge_model": "also-bad",
                "task_ids": [task.task_id],
            })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(saved_runs[-1]["task_model"], DEFAULT_LLM_MODEL)
        self.assertEqual(saved_runs[-1]["judge_model"], DEFAULT_LLM_MODEL)

    def test_normalize_max_steps_clamps_invalid_values(self):
        self.assertEqual(normalize_max_steps("22"), 22)
        self.assertEqual(normalize_max_steps("0"), 1)
        self.assertEqual(normalize_max_steps("500"), 100)
        self.assertEqual(normalize_max_steps("bad"), 15)

    def test_check_all_tasks_is_only_a_select_panel_button(self):
        app = create_app()
        app.config.update(TESTING=True)
        response = app.test_client().get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'id="check-all-tasks"', response.data)
        self.assertIn(b'type="button"', response.data)
        self.assertNotIn(b"/runs/check-all-tasks", response.data)

    def test_home_page_load_does_not_create_or_start_run(self):
        app = create_app()
        app.config.update(TESTING=True)
        with patch("eval_tool.app.create_run") as create_run, \
             patch("eval_tool.app.start_run") as start_run:
            response = app.test_client().get("/")
        self.assertEqual(response.status_code, 200)
        create_run.assert_not_called()
        start_run.assert_not_called()

    def test_home_page_renders_task_set_toggle_defaulting_to_no_login(self):
        app = create_app()
        app.config.update(TESTING=True)
        response = app.test_client().get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"guide_task_no_log_in.csv", response.data)
        self.assertIn(b'name=\"task_set\" value=\"no_login\"', response.data)
        self.assertIn(b'name=\"max_steps\"', response.data)
        self.assertIn(b'name=\"task_model\"', response.data)
        self.assertIn(b'name=\"judge_model\"', response.data)
        self.assertIn(b"Gemini 2.5 Flash Lite", response.data)

    def test_home_page_can_render_login_task_set(self):
        app = create_app()
        app.config.update(TESTING=True)
        response = app.test_client().get("/?task_set=login")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"guide_task-log-in.csv", response.data)
        self.assertIn(b'name=\"task_set\" value=\"login\"', response.data)

    def test_run_dashboard_renders_empty_run(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {
            "run_id": "test-run",
            "created_at": "now",
            "status": "completed",
            "task_ids": [],
            "task_model": DEFAULT_LLM_MODEL,
            "judge_model": DEFAULT_LLM_MODEL,
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.list_task_results", return_value=[]), \
             patch("eval_tool.app.is_running", return_value=False):
            response = app.test_client().get("/runs/test-run")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Mean by Step Across Tasks", response.data)
        self.assertIn(b"Task model", response.data)
        self.assertIn(DEFAULT_LLM_MODEL.encode(), response.data)

    def test_eval_server_run_detail_shows_run_models(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {
            "run_id": "test-run-models",
            "created_at": "now",
            "status": "completed",
            "task_ids": ["t1"],
            "task_model": "google/gemini-2.5-pro",
            "judge_model": "openai/gpt-4o",
            "temperature": 0.3,
        }
        result = {
            "task_id": "t1",
            "status": "completed",
            "task": {"task": "Do thing"},
            "judge": {"success": True, "reason": "Done"},
            "steps": [
                {"step": 0, "isInitial": True},
                {
                    "step": 1,
                    "action": "click",
                    "target": {"llmIndex": 1},
                    "element_step_similarity": 0.42,
                    "self_progress_no_gt": -1,
                    "self_progress_no_gt_reason": "regression",
                },
                {"step": 2, "action": "done"},
            ],
        }
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.list_task_results", return_value=[result]), \
             patch("eval_server.app.is_running", return_value=False):
            response = server_app.test_client().get("/runs/test-run-models")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Task model:", response.data)
        self.assertIn(b"google/gemini-2.5-pro", response.data)
        self.assertIn(b"Judge model:", response.data)
        self.assertIn(b"openai/gpt-4o", response.data)
        self.assertIn(b"Temperature:", response.data)
        self.assertIn(b"0.3", response.data)
        self.assertIn(b"Total Steps", response.data)
        self.assertIn(b">2</div>", response.data)
        self.assertIn(b"Rerun Goal Relevance", response.data)
        self.assertIn(b"Rerun Grounding Similarity", response.data)
        self.assertIn(b"Rerun LLM Grounding Labels", response.data)
        self.assertIn(b"Grounded_LLM_Label", response.data)
        self.assertIn(b"self_progress_no_gt", response.data)
        self.assertIn(b"element_step_similarity", response.data)
        self.assertIn(b"Grounding Similarity", response.data)
        self.assertIn(b"Steps Below Threshold", response.data)
        self.assertIn(b"Tasks With Low Similarity", response.data)
        # The "Human Label Boundary Check" panel was removed to streamline the run detail page.
        self.assertNotIn(b"Human Label Boundary Check", response.data)
        self.assertIn(b"oninput=\"updateGroundingThresholdSummary()\"", response.data)
        self.assertIn(b"similarity &lt; 0.80", response.data)
        self.assertIn(b"Step 1: 0.42", response.data)
        self.assertIn(b"-1", response.data)
        self.assertIn(b"regression", response.data)

    def test_eval_server_trajectory_inspector_shows_negative_no_gt_progress(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        trajectory = {
            "sessionId": "neg-no-gt",
            "goal": "Do thing",
            "judge": {"success": False, "reason": "Not done"},
            "steps": [
                {"step": 0, "isInitial": True},
                {
                    "step": 1,
                    "action": "click",
                    "instruction": "Click Back",
                    "target": {"llmIndex": 3, "text": "Back"},
                    "element_step_similarity": 0.42,
                    "self_progress_no_gt": -1,
                    "self_progress_no_gt_reason": "moved away from the goal",
                },
            ],
        }
        with TemporaryDirectory() as tmp:
            saved_dir = Path(tmp) / "saved"
            runs_dir = Path(tmp) / "runs"
            saved_dir.mkdir()
            runs_dir.mkdir()
            (saved_dir / "neg-no-gt.json").write_text(json.dumps(trajectory), encoding="utf-8")
            with patch("eval_server.app.SAVED_DIR", str(saved_dir)), \
                 patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_stars", return_value={}):
                response = server_app.test_client().get("/trajectory/neg-no-gt")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Rerun Goal Relevance", response.data)
        self.assertIn(b"Rerun Grounding Similarity", response.data)
        self.assertIn(b"self_progress_no_gt", response.data)
        self.assertIn(b"Grounding Similarity", response.data)
        self.assertNotIn(b"metric-col-elemsim", response.data)
        self.assertIn(b"0.42", response.data)
        self.assertIn(b"#a16207", response.data)
        self.assertIn(b"badge red", response.data)
        self.assertIn(b">-1</span>", response.data)
        self.assertIn(b"moved away from the goal", response.data)

    def test_eval_server_trajectory_inspector_shows_grounding_similarity_badges(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        long_element_text = "(dialog) select a date range from June 20 to June 24 for the booking calendar modal"
        trajectory = {
            "sessionId": "grounding-similarity-badges",
            "goal": "Do thing",
            "steps": [
                {"step": 0, "isInitial": True},
                {
                    "step": 1,
                    "action": "click",
                    "instruction": "Click Where",
                    "target": {"llmIndex": 3, "text": "Where"},
                    "element_step_similarity": 0.82,
                    "grounded_llm_labels": {"openai/gpt-4o": {"label": "grounded", "reason": "where field"}},
                },
                {
                    "step": 2,
                    "action": "click",
                    "instruction": "Click Search",
                    "target": {"llmIndex": 4, "text": "Search"},
                    "element_step_similarity": 0.79,
                    "completedPlanStep": 4,
                    "plan": [{"n": n, "goal": f"Step {n}", "status": "complete" if n <= 4 else "pending"} for n in range(1, 9)],
                    "progress": 1.0,
                    "grounded_llm_labels": {"openai/gpt-4o": {"label": "not_grounded", "reason": "wrong element"}},
                },
                {
                    "step": 3,
                    "action": "click",
                    "instruction": "Select date range",
                    "target": {"llmIndex": 5, "text": long_element_text},
                    "element_step_similarity": 0.55,
                },
                {
                    "step": 4,
                    "action": "click",
                    "instruction": "Select date range again",
                    "target": {"llmIndex": 5, "text": long_element_text},
                    "element_step_similarity": 0.55,
                    "warningInjected": True,
                    "warningTypes": ["grounding", "loop"],
                    "warningPrompt": "GROUNDING WARNING\nLOOP WARNING",
                    "firstRawResponse": json.dumps({
                        "action": "click",
                        "instruction": "Select date range again",
                        "element": {"index": 5, "text": long_element_text},
                    }),
                    "retryRawResponse": json.dumps({
                        "action": "click",
                        "instruction": "Select another date",
                        "element": {"index": 7, "text": "June 24"},
                    }),
                    "firstGroundingSimilarity": 0.55,
                    "firstLoopScore": 0.4,
                    "warningGroundingThreshold": 0.8,
                    "warningLoopThreshold": 0.3,
                    "firstResolvedElementText": long_element_text,
                    "retryResolvedElementText": "June 24",
                    "retryGroundingSimilarity": 0.86,
                    "retryLoopScore": 0.0,
                },
                {
                    "step": 5,
                    "action": "click",
                    "instruction": "Click missing",
                    "target": {"llmIndex": 6, "text": "Missing"},
                    "element_step_similarity": 0.75,
                    "warningChecked": True,
                    "warningInjected": False,
                    "warningSkipReason": "grounding_similarity_unavailable:embed_error; loop_below_threshold",
                    "firstGroundingSimilarity": None,
                    "firstGroundingSimilarityReason": "embed_error",
                    "firstGroundingSimilarityDetail": "Embedding timeout before retry decision",
                    "firstLoopScore": 0.1,
                    "warningGroundingThreshold": 0.8,
                    "warningLoopThreshold": 0.3,
                },
            ],
        }
        with TemporaryDirectory() as tmp:
            saved_dir = Path(tmp) / "saved"
            runs_dir = Path(tmp) / "runs"
            saved_dir.mkdir()
            runs_dir.mkdir()
            (saved_dir / "grounding-similarity-badges.json").write_text(json.dumps(trajectory), encoding="utf-8")
            with patch("eval_server.app.SAVED_DIR", str(saved_dir)), \
                 patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_stars", return_value={}):
                response = server_app.test_client().get("/trajectory/grounding-similarity-badges")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Grounding Similarity", response.data)
        self.assertIn(b"Original Similarity", response.data)
        self.assertIn(b"Retry Similarity", response.data)
        self.assertIn(b"Plan Progress", response.data)
        self.assertIn(b"Show LLM Progress", response.data)
        self.assertIn(b"Show Subgoal Progress", response.data)
        self.assertIn(b"metric-col-llmprog metric-col-hidden", response.data)
        self.assertIn(b"metric-col-subgoalprog metric-col-hidden", response.data)
        self.assertIn(b"Show Grounded_Human_Label", response.data)
        self.assertIn(b"Grounded_Human_Label", response.data)
        self.assertIn(b"Show Grounded_LLM_Label", response.data)
        self.assertIn(b"Grounded_LLM_Label", response.data)
        self.assertIn(b"LLM Annotated Ground Truth", response.data)
        self.assertIn(b"where field", response.data)
        self.assertIn(b"Not Grounded", response.data)
        self.assertIn(b"Human Label Boundary Check", response.data)
        self.assertIn(b"id=\"task-grounding-boundary-input\"", response.data)
        self.assertIn(b"oninput=\"renderTaskBoundarySummary()\"", response.data)
        self.assertIn(b"Pred Grounded", response.data)
        self.assertIn(b"Youden Index", response.data)
        self.assertIn(b">0.82</span>", response.data)
        self.assertIn(b">0.79</span>", response.data)
        self.assertIn(b"Original pre-retry cosine similarity: 0.55", response.data)
        self.assertIn(b"Retry cosine similarity: 0.86", response.data)
        self.assertIn(b"4/8", response.data)
        self.assertIn(b"No retry", response.data)
        self.assertIn(b"grounding_similarity_unavailable:embed_error; loop_below_threshold", response.data)
        self.assertIn(b"Score unavailable: embed_error", response.data)
        self.assertIn(b"Embedding timeout before retry decision", response.data)
        self.assertIn(b"#a16207", response.data)
        self.assertIn(b"Raw cosine similarity: 0.82", response.data)
        self.assertIn(long_element_text.encode(), response.data)
        self.assertIn(b"Warning Retry Evidence", response.data)
        self.assertIn(b"Step 4.1 warning retry", response.data)
        self.assertIn(b"Original action JSON", response.data)
        self.assertIn(b"Retry agent JSON response", response.data)
        self.assertIn(b"firstResolvedElementText", response.data)
        self.assertIn(b"retryResolvedElementText", response.data)
        self.assertIn(b"max-width: 260px; white-space: normal; overflow-wrap: anywhere; word-break: break-word; line-height: 1.25", response.data)
        self.assertNotIn(b"max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;", response.data)

    def test_grounding_human_label_api_saves_and_clears_default(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        trajectory = {
            "sessionId": "human-grounding-label",
            "goal": "Do thing",
            "steps": [
                {"step": 1, "instruction": "Click Search", "element_step_similarity": 0.9},
            ],
        }
        with TemporaryDirectory() as tmp:
            saved_dir = Path(tmp) / "saved"
            runs_dir = Path(tmp) / "runs"
            saved_dir.mkdir()
            runs_dir.mkdir()
            path = saved_dir / "human-grounding-label.json"
            path.write_text(json.dumps(trajectory), encoding="utf-8")
            with patch("eval_server.app.SAVED_DIR", str(saved_dir)), \
                 patch("eval_server.app.RUNS_DIR", str(runs_dir)):
                client = server_app.test_client()
                response = client.post(
                    "/api/trajectory/human-grounding-label/grounding-human-label",
                    json={"step": 1, "label": "non_grounded", "threshold": 0.8},
                )
                self.assertEqual(response.status_code, 200)
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(data["steps"][0]["grounded_human_label"], "non_grounded")
                self.assertEqual(response.get_json()["metrics"]["fp"], 1)

                response = client.post(
                    "/api/trajectory/human-grounding-label/grounding-human-label",
                    json={"step": 1, "label": "grounded", "threshold": 0.8},
                )
                self.assertEqual(response.status_code, 200)
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertNotIn("grounded_human_label", data["steps"][0])

    def test_grounding_human_label_api_rejects_invalid_and_running_run(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        with TemporaryDirectory() as tmp:
            saved_dir = Path(tmp) / "saved"
            runs_dir = Path(tmp) / "runs"
            task_dir = runs_dir / "run-active" / "tasks"
            saved_dir.mkdir()
            task_dir.mkdir(parents=True)
            (task_dir / "t1.json").write_text(json.dumps({
                "session_id": "active-session",
                "steps": [{"step": 1, "element_step_similarity": 0.4}],
            }), encoding="utf-8")
            with patch("eval_server.app.SAVED_DIR", str(saved_dir)), \
                 patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.is_running", return_value=True):
                client = server_app.test_client()
                response = client.post(
                    "/api/trajectory/active-session/grounding-human-label",
                    json={"step": 1, "label": "non_grounded"},
                )
                self.assertEqual(response.status_code, 400)

            with patch("eval_server.app.SAVED_DIR", str(saved_dir)), \
                 patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.is_running", return_value=False):
                response = server_app.test_client().post(
                    "/api/trajectory/active-session/grounding-human-label",
                    json={"step": 1, "label": "bad"},
                )
                self.assertEqual(response.status_code, 400)

    def test_grounding_metrics_api_returns_youden_index(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {"run_id": "run-youdens", "task_model": "google/gemini-2.5-flash", "status": "completed"}
        task_result = {
            "session_id": "s-youdens",
            # Normal runs no longer default to grounded; grounded steps must be labeled explicitly.
            "steps": [
                {"step": 1, "element_step_similarity": 0.9, "grounded_human_label": "grounded"},
                {"step": 2, "element_step_similarity": 0.7, "grounded_human_label": "grounded"},
                {"step": 3, "element_step_similarity": 0.4, "grounded_human_label": "non_grounded"},
                {"step": 4, "element_step_similarity": 0.2, "grounded_human_label": "non_grounded"},
            ],
        }
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            task_dir = runs_dir / "run-youdens" / "tasks"
            task_dir.mkdir(parents=True)
            (task_dir / "t1.json").write_text(json.dumps(task_result), encoding="utf-8")
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run):
                response = server_app.test_client().post(
                    "/api/grounding_metrics",
                    json={"run_ids": ["run-youdens"], "threshold": 0.8},
                )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertIn("Gemini", data)
        self.assertAlmostEqual(data["Gemini"]["optimal_threshold"], 0.7)
        self.assertAlmostEqual(data["Gemini"]["youden_j"], 1.0)

    def test_grounding_metrics_normal_run_has_no_default_human_ground_truth(self):
        # Normal runs must NOT default unlabeled steps to "grounded"; only the
        # human-annotated-task-set gets a default-grounded (editable) ground truth.
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {"run_id": "run-nolabels", "task_model": "google/gemini-2.5-flash", "status": "completed"}
        task_result = {
            "session_id": "s-nolabels",
            "steps": [
                {"step": 1, "element_step_similarity": 0.9},
                {"step": 2, "element_step_similarity": 0.4},
            ],
        }
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            task_dir = runs_dir / "run-nolabels" / "tasks"
            task_dir.mkdir(parents=True)
            (task_dir / "t1.json").write_text(json.dumps(task_result), encoding="utf-8")
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run):
                response = server_app.test_client().post(
                    "/api/grounding_metrics",
                    json={"run_ids": ["run-nolabels"], "threshold": 0.8},
                )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        # With no explicit human labels, there is no ground truth: no scored pairs.
        gemini = data.get("Gemini", {})
        self.assertEqual(gemini.get("tp", 0) + gemini.get("tn", 0) + gemini.get("fp", 0) + gemini.get("fn", 0), 0)

    def test_grounding_metrics_annotation_set_defaults_unlabeled_to_grounded(self):
        # The human-annotated-task-set keeps the default-grounded ground truth so a
        # reviewer can start from "grounded" and flip individual steps.
        from eval_server.app import app as server_app
        from eval_server.app import HUMAN_ANNOTATION_RUN_ID

        server_app.config.update(TESTING=True)
        run = {
            "run_id": HUMAN_ANNOTATION_RUN_ID,
            "source_task_model": "google/gemini-2.5-flash",
            "status": "completed",
        }
        task_result = {
            "session_id": "s-annot",
            "source_task_model": "google/gemini-2.5-flash",
            "steps": [
                {"step": 1, "element_step_similarity": 0.9},
                {"step": 2, "element_step_similarity": 0.4},
            ],
        }
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            task_dir = runs_dir / HUMAN_ANNOTATION_RUN_ID / "tasks"
            task_dir.mkdir(parents=True)
            (task_dir / "t1.json").write_text(json.dumps(task_result), encoding="utf-8")
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run):
                response = server_app.test_client().post(
                    "/api/grounding_metrics",
                    json={"run_ids": [HUMAN_ANNOTATION_RUN_ID], "threshold": 0.8},
                )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        gemini = data.get("Gemini", {})
        # Both steps default to grounded truth: step1 (0.9>=0.8) is a true positive,
        # step2 (0.4<0.8) is predicted non-grounded against a grounded truth (false negative).
        self.assertEqual(gemini.get("tp", 0) + gemini.get("tn", 0) + gemini.get("fp", 0) + gemini.get("fn", 0), 2)
        self.assertEqual(gemini.get("tp"), 1)
        self.assertEqual(gemini.get("fn"), 1)

    def test_grounding_metrics_api_can_compare_similarity_to_llm_labels(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {"run_id": "run-llm-metrics", "task_model": "openai/gpt-4.1-nano", "status": "completed"}
        task_result = {
            "session_id": "s-llm-metrics",
            "steps": [
                {"step": 1, "element_step_similarity": 0.9, "grounded_llm_labels": {"openai/gpt-4o": {"label": "grounded"}}},
                {"step": 2, "element_step_similarity": 0.7, "grounded_llm_labels": {"openai/gpt-4o": {"label": "grounded"}}},
                {"step": 3, "element_step_similarity": 0.4, "grounded_llm_labels": {"openai/gpt-4o": {"label": "not_grounded"}}},
                {"step": 4, "element_step_similarity": 0.2},
            ],
        }
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            task_dir = runs_dir / "run-llm-metrics" / "tasks"
            task_dir.mkdir(parents=True)
            (task_dir / "t1.json").write_text(json.dumps(task_result), encoding="utf-8")
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run):
                response = server_app.test_client().post(
                    "/api/grounding_metrics",
                    json={
                        "run_ids": ["run-llm-metrics"],
                        "threshold": 0.8,
                        "label_source": "llm",
                        "llm_label_model": "openai/gpt-4o",
                    },
                )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["__meta"]["label_source"], "llm")
        self.assertEqual(data["__meta"]["llm_label_model"], "openai/gpt-4o")
        self.assertIn("Gpt-4.1-nano", data)
        self.assertEqual(data["Gpt-4.1-nano"]["total_scored_steps"], 3)
        self.assertEqual(data["Gpt-4.1-nano"]["tp"], 1)
        self.assertEqual(data["Gpt-4.1-nano"]["fn"], 1)
        self.assertEqual(data["Gpt-4.1-nano"]["tn"], 1)

    def test_grounding_metrics_api_returns_selected_run_task_step_summary(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {"run_id": "run-selected-summary", "task_model": "google/gemini-2.5-flash", "status": "completed"}
        passed_task = {
            "session_id": "passed-task",
            "judge": {"success": True},
            "steps": [
                {"step": 0, "isInitial": True},
                {"step": 1, "action": "click", "instruction": "Click Search", "target": {"text": "Search"}, "element_step_similarity": 0.79},
                {"step": 2, "action": "click", "instruction": "Click Search again", "target": {"text": "Search"}, "element_step_similarity": 0.80},
            ],
        }
        failed_task = {
            "session_id": "failed-task",
            "judge": {"success": False},
            "steps": [
                {"step": 0, "isInitial": True},
                {"step": 1, "action": "click", "instruction": "Click wrong", "target": {"text": "Wrong"}, "element_step_similarity": 0.40},
            ],
        }
        failed_unscored_task = {
            "session_id": "failed-unscored-task",
            "judge": {"success": False},
            "steps": [
                {"step": 0, "isInitial": True},
                {"step": 1, "action": "click", "instruction": "Click missing similarity", "target": {"text": "Missing"}},
            ],
        }
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            task_dir = runs_dir / "run-selected-summary" / "tasks"
            task_dir.mkdir(parents=True)
            (task_dir / "passed.json").write_text(json.dumps(passed_task), encoding="utf-8")
            (task_dir / "failed.json").write_text(json.dumps(failed_task), encoding="utf-8")
            (task_dir / "failed-unscored.json").write_text(json.dumps(failed_unscored_task), encoding="utf-8")
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run):
                all_response = server_app.test_client().post(
                    "/api/grounding_metrics",
                    json={"run_ids": ["run-selected-summary"], "threshold": 0.8, "outcome_filter": "all"},
                )
                failed_response = server_app.test_client().post(
                    "/api/grounding_metrics",
                    json={"run_ids": ["run-selected-summary"], "threshold": 0.8, "outcome_filter": "failed"},
                )

        self.assertEqual(all_response.status_code, 200)
        all_summary = all_response.get_json()["__summary"]["models"]["Gemini"]
        self.assertEqual(all_summary["total_tasks"], 3)
        self.assertEqual(all_summary["passed_tasks"], 1)
        self.assertEqual(all_summary["failed_tasks"], 2)
        self.assertAlmostEqual(all_summary["unsuccessful_task_rate"], 2 / 3)
        self.assertEqual(all_summary["total_steps"], 3)
        self.assertEqual(all_summary["misgrounded_steps"], 2)
        self.assertEqual(all_summary["tasks_with_misgrounding"], 2)
        self.assertEqual(all_summary["loop_steps"], 1)
        self.assertEqual(all_summary["tasks_with_loop"], 1)
        all_group = all_summary["groups"]["all"]
        self.assertEqual(all_group["task_count"], 3)
        self.assertEqual(all_group["total_steps"], 3)
        self.assertAlmostEqual(all_group["misgrounded_step_rate"], 2 / 3)
        self.assertAlmostEqual(all_group["loop_step_rate"], 1 / 3)
        self.assertAlmostEqual(all_group["misgrounded_task_rate_mean"], 0.75)
        self.assertAlmostEqual(all_group["misgrounded_task_rate_std"], 0.25)
        self.assertAlmostEqual(all_group["loop_task_rate_mean"], 0.25)
        self.assertAlmostEqual(all_group["loop_task_rate_std"], 0.25)
        success_group = all_summary["groups"]["success"]
        self.assertEqual(success_group["task_count"], 1)
        self.assertAlmostEqual(success_group["misgrounded_task_rate_mean"], 0.5)
        self.assertAlmostEqual(success_group["misgrounded_task_rate_std"], 0.0)
        self.assertAlmostEqual(success_group["loop_task_rate_mean"], 0.5)
        self.assertAlmostEqual(success_group["loop_task_rate_std"], 0.0)

        self.assertEqual(failed_response.status_code, 200)
        failed_payload = failed_response.get_json()
        self.assertEqual(failed_payload["__summary"]["outcome_filter"], "failed")
        failed_summary = failed_payload["__summary"]["models"]["Gemini"]
        self.assertEqual(failed_summary["total_tasks"], 2)
        self.assertEqual(failed_summary["passed_tasks"], 0)
        self.assertEqual(failed_summary["failed_tasks"], 2)
        self.assertEqual(failed_summary["total_steps"], 1)
        self.assertEqual(failed_summary["misgrounded_steps"], 1)
        failed_group = failed_summary["groups"]["failed"]
        self.assertEqual(failed_group["task_count"], 2)
        self.assertEqual(failed_group["total_steps"], 1)
        self.assertAlmostEqual(failed_group["misgrounded_task_rate_mean"], 1.0)
        self.assertAlmostEqual(failed_group["misgrounded_task_rate_std"], 0.0)
        self.assertAlmostEqual(failed_group["loop_task_rate_mean"], 0.0)
        self.assertAlmostEqual(failed_group["loop_task_rate_std"], 0.0)

    def test_grounding_llm_labels_api_annotates_selected_runs(self):
        from eval_server.app import app as server_app

        class FakeJudge:
            api_key = "key"
            def __init__(self, model=None):
                self.model = model
            def judge_grounding_label(self, task, step, element_text):
                return {
                    "available": True,
                    "label": "not_grounded" if "dress" in element_text.lower() else "grounded",
                    "reason": "ok",
                    "prompt": "prompt",
                    "raw_response": '{"label":"grounded"}',
                }

        server_app.config.update(TESTING=True)
        run = {"run_id": "run-llm-grounding", "task_model": "openai/gpt-4o", "status": "completed"}
        task_result = {
            "session_id": "s-llm-grounding",
            "task": {"task": "Find a destination"},
            "steps": [
                {"step": 1, "action": "click", "instruction": "Click Where", "target": {"llmIndex": 33, "text": "Where to?. Results available."}},
                {"step": 2, "action": "click", "instruction": "Click orange product", "target": {"llmIndex": 102, "text": "ANRABESS Women Athletic Dress"}},
            ],
        }
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            task_dir = runs_dir / "run-llm-grounding" / "tasks"
            task_dir.mkdir(parents=True)
            task_path = task_dir / "t1.json"
            task_path.write_text(json.dumps(task_result), encoding="utf-8")
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run), \
                 patch("eval_server.app.is_running", return_value=False), \
                 patch("eval_server.app.LlmJudge", FakeJudge):
                response = server_app.test_client().post(
                    "/api/grounding-llm-labels/rerun",
                    json={"run_ids": ["run-llm-grounding"], "model": "openai/gpt-4o"},
                )
            data = response.get_json()
            saved = json.loads(task_path.read_text(encoding="utf-8"))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(data["totals"]["steps_scored"], 2)
        self.assertEqual(data["totals"]["not_grounded"], 1)
        self.assertEqual(saved["steps"][0]["grounded_llm_labels"]["openai/gpt-4o"]["label"], "grounded")
        self.assertEqual(saved["steps"][1]["grounded_llm_labels"]["openai/gpt-4o"]["label"], "not_grounded")

    def test_grounding_llm_labels_routes_reject_running_and_missing_key(self):
        from eval_server.app import app as server_app

        class NoKeyJudge:
            api_key = ""
            def __init__(self, model=None):
                self.model = model

        server_app.config.update(TESTING=True)
        run = {"run_id": "run-active-llm", "status": "running", "task_model": "openai/gpt-4o"}
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.is_running", return_value=True):
            response = server_app.test_client().post(
                "/runs/run-active-llm/grounding-llm-labels/rerun",
                data={"model": "openai/gpt-4o"},
            )
        self.assertEqual(response.status_code, 400)

        run = {"run_id": "run-no-key", "status": "completed", "task_model": "openai/gpt-4o"}
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            (runs_dir / "run-no-key" / "tasks").mkdir(parents=True)
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run), \
                 patch("eval_server.app.is_running", return_value=False), \
                 patch("eval_server.app.LlmJudge", NoKeyJudge):
                response = server_app.test_client().post(
                    "/api/grounding-llm-labels/rerun",
                    json={"run_ids": ["run-no-key"], "model": "openai/gpt-4o"},
                )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["runs"][0]["reason"], "OPENROUTER_API_KEY is not configured")

    def test_trajectory_llm_grounding_label_route_writes_single_trajectory(self):
        from eval_server.app import app as server_app

        class FakeJudge:
            api_key = "key"
            def __init__(self, model=None):
                self.model = model
            def judge_grounding_label(self, task, step, element_text):
                return {"available": True, "label": "grounded", "reason": "matches", "prompt": "prompt", "raw_response": "{}"}

        server_app.config.update(TESTING=True)
        trajectory = {
            "sessionId": "single-llm-ground",
            "task": {"task": "Do thing"},
            "steps": [
                {"step": 1, "action": "click", "instruction": "Click Search", "target": {"llmIndex": 1, "text": "Search"}},
            ],
        }
        with TemporaryDirectory() as tmp:
            saved_dir = Path(tmp) / "saved"
            runs_dir = Path(tmp) / "runs"
            saved_dir.mkdir()
            runs_dir.mkdir()
            path = saved_dir / "single-llm-ground.json"
            path.write_text(json.dumps(trajectory), encoding="utf-8")
            with patch("eval_server.app.SAVED_DIR", str(saved_dir)), \
                 patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.LlmJudge", FakeJudge):
                response = server_app.test_client().post(
                    "/trajectory/single-llm-ground/grounding-llm-labels/rerun",
                    data={"model": "openai/gpt-4o"},
                )
            saved = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(response.status_code, 302)
        self.assertIn("llm_grounding_rerun=1", response.headers["Location"])
        self.assertEqual(saved["steps"][0]["grounded_llm_labels"]["openai/gpt-4o"]["label"], "grounded")

    def test_eval_server_run_detail_can_rerun_goal_relevance_and_grounding_similarity(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {"run_id": "rerun-embeds", "status": "completed", "task_ids": ["t1"], "task_model": "task-model"}
        task = {
            "task_id": "t1",
            "task": {"task": "Do thing", "website_url": "https://example.test"},
            "steps": [
                {"step": 0, "isInitial": True},
                {"step": 1, "action": "click", "instruction": "Click submit", "target": {"llmIndex": 1, "text": "Submit"}},
            ],
        }
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp)
            task_dir = runs_dir / "rerun-embeds" / "tasks"
            task_dir.mkdir(parents=True)
            (task_dir / "t1.json").write_text(json.dumps(task), encoding="utf-8")
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value=run), \
                 patch("eval_server.app.is_running", return_value=False), \
                 patch("eval_server.app.rerun_trajectory_goal_relevance", return_value={"updated": True, "steps_scored": 1, "reason": ""}) as rerun_goal, \
                 patch("eval_server.app.rerun_trajectory_grounding_similarity", return_value={"updated": True, "steps_scored": 1, "reason": ""}) as rerun_ground:
                client = server_app.test_client()
                goal_response = client.post("/runs/rerun-embeds/goal-relevance/rerun")
                ground_response = client.post("/runs/rerun-embeds/grounding-similarity/rerun")
        self.assertEqual(goal_response.status_code, 302)
        self.assertIn("goalrel_rerun=1", goal_response.headers["Location"])
        self.assertIn("goalrel_steps=1", goal_response.headers["Location"])
        self.assertEqual(ground_response.status_code, 302)
        self.assertIn("grounding_rerun=1", ground_response.headers["Location"])
        self.assertIn("grounding_steps=1", ground_response.headers["Location"])
        rerun_goal.assert_called_once()
        rerun_ground.assert_called_once()

    def test_eval_server_dashboard_auto_runs_table_shows_models_and_fallback(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        runs = [
            {
                "run_id": "run-new-with-models",
                "created_at": "2026-06-24T10:00:00+00:00",
                "status": "completed",
                "task_ids": [],
                "task_set": "no_login",
                "task_model": "google/gemini-2.5-pro",
                "judge_model": "openai/gpt-4o",
                "region_capture_mode": "aligned",
            },
            {
                "run_id": "run-old-with-models",
                "created_at": "2026-06-20T10:00:00+00:00",
                "status": "completed",
                "task_ids": [],
                "task_set": "no_login",
                "task_model": "google/gemini-2.5-pro",
                "judge_model": "openai/gpt-4o",
                "region_capture_mode": "aligned",
            },
            {
                "run_id": "run-without-models",
                "created_at": "2026-06-22T10:00:00+00:00",
                "status": "completed",
                "task_ids": [],
                "task_set": "no_login",
                "region_capture_mode": "legacy",
            },
        ]
        with patch("eval_server.app.list_auto_runs", return_value=runs), \
             patch("eval_server.app.is_running", return_value=False), \
             patch("eval_server.app.collect_starred_tasks", return_value=[]):
            response = server_app.test_client().get("/?tab=automatic")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Show Judge / Target", response.data)
        self.assertIn(b".metric-col-hidden", response.data)
        self.assertIn(b"metric-col-runmeta metric-col-hidden", response.data)
        self.assertIn(b"Task Model", response.data)
        self.assertIn(b"Judge Model", response.data)
        self.assertIn(b"Best Threshold (Youden)", response.data)
        self.assertIn(b"Youden J", response.data)
        self.assertIn(b"google/gemini-2.5-pro", response.data)
        self.assertIn(b"openai/gpt-4o", response.data)
        self.assertIn(b"Annotate Selected Runs", response.data)
        self.assertIn(b"LLM Label Model", response.data)
        self.assertIn(b"Mode 1b: Metric Alignment (Sim vs LLM Label)", response.data)
        self.assertIn(b"label_source", response.data)
        self.assertIn(b"llm_label_model", response.data)
        self.assertLess(response.data.index(b"run-new-with-models"), response.data.index(b"run-old-with-models"))
        self.assertIn(b"Grounding Similarity", response.data)
        self.assertIn(b"Unknown", response.data)

    def test_eval_server_dashboard_auto_runs_table_can_show_reference_summary(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        runs = [{
            "run_id": "run-ref-summary",
            "created_at": "now",
            "status": "completed",
            "task_ids": ["easy-task", "medium-task"],
            "task_set": "no_login",
        }]
        task_map = {
            "easy-task": {"reference_length": "4", "task": "Easy task"},
            "medium-task": {"reference_length": "8", "task": "Medium task"},
        }
        with patch("eval_server.app.list_auto_runs", return_value=runs), \
             patch("eval_server.app.tasks_by_id", return_value=task_map), \
             patch("eval_server.app.is_running", return_value=False), \
             patch("eval_server.app.collect_starred_tasks", return_value=[]):
            response = server_app.test_client().get("/?tab=automatic")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Show Ref Steps / Difficulty", response.data)
        self.assertIn(b"Reference Steps / Difficulty", response.data)
        self.assertIn(b"metric-col-refmeta metric-col-hidden", response.data)
        self.assertIn(b"4-8 ref steps", response.data)
        self.assertIn(b"Easy 1 / Medium 1", response.data)

    def test_eval_server_dashboard_renders_warning_and_planning_toggles(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        with patch("eval_server.app.list_auto_runs", return_value=[]), \
             patch("eval_server.app.collect_starred_tasks", return_value=[]):
            response = server_app.test_client().get("/?tab=automatic")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'name="inject_grounding_warning"', response.data)
        self.assertIn(b"Inject Grounding Warning", response.data)
        self.assertIn(b'name="inject_looping_warning"', response.data)
        self.assertIn(b"Inject Looping Warning", response.data)
        self.assertIn(b'name="automatic_planning_mode"', response.data)
        self.assertIn(b"Planning Mode", response.data)
        self.assertIn(b'name="temperature"', response.data)
        self.assertIn(b'value="0"', response.data)
        self.assertIn(b'name="grounding_warning_threshold"', response.data)
        self.assertIn(b'value="0.8"', response.data)
        self.assertIn(b'name="loop_warning_threshold"', response.data)
        self.assertIn(b'value="0.3"', response.data)
        self.assertIn(b'name="workers" value="20"', response.data)
        self.assertIn(b'id="grounding-eval-outcome-filter"', response.data)
        self.assertIn(b"Selected Runs Task/Step Summary", response.data)
        self.assertIn(b"setSelectedRunsOutcomeFilter", response.data)
        self.assertIn(b"M_Steps", response.data)
        self.assertIn(b"M_Mean", response.data)
        self.assertIn(b"M_Std", response.data)
        self.assertIn(b"L_steps", response.data)
        self.assertIn(b"L_Mean", response.data)
        self.assertIn(b"L_Std", response.data)
        self.assertIn(b"Fail Rate", response.data)
        self.assertIn(b"Failed Tasks", response.data)
        self.assertIn(b"Total Tasks", response.data)

    def test_grounding_run_groups_defaults_to_three_eighty_task_runs(self):
        from eval_server.app import _grounding_run_groups

        def run(run_id, model, task_count, started):
            return {
                "run_id": run_id,
                "task_model": model,
                "task_ids": [f"{run_id}-task-{idx}" for idx in range(task_count)],
                "started_at": started,
                "status": "completed",
            }

        auto_runs = [
            run("new-small-gemini", "gemini", 6, "2026-06-28T10:00:00+00:00"),
            run("eighty-gemini", "gemini", 80, "2026-06-27T10:00:00+00:00"),
            run("new-small-qwen", "qwen", 4, "2026-06-28T09:00:00+00:00"),
            run("eighty-qwen", "qwen", 80, "2026-06-26T10:00:00+00:00"),
            run("eighty-gpt", "gpt", 80, "2026-06-25T10:00:00+00:00"),
            run("small-claude", "claude", 3, "2026-06-28T11:00:00+00:00"),
        ]

        groups, default_ids = _grounding_run_groups(auto_runs)

        self.assertEqual(default_ids, {"eighty-gemini", "eighty-qwen", "eighty-gpt"})
        self.assertEqual(groups[0]["model"], "claude")

    def test_eval_server_automatic_defaults_to_annotated_dataset(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        with patch("eval_server.app.list_auto_runs", return_value=[]), \
             patch("eval_server.app.collect_starred_tasks", return_value=[]):
            response = server_app.test_client().get("/?tab=automatic")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'<input type="hidden" name="task_set" value="annotated">', response.data)
        self.assertIn(b'<option value="annotated" selected>Annotated Dataset</option>', response.data)
        self.assertIn(b'All Step URLs Differ', response.data)
        self.assertIn(b'id="random-n-input"', response.data)
        self.assertIn(b'value="50"', response.data)
        self.assertIn(b'id="random-seed-input"', response.data)
        self.assertIn(b'value="1"', response.data)
        self.assertIn(b'id="source-run-select"', response.data)
        self.assertIn(b'Select Remaining 60', response.data)
        self.assertIn(b'/api/runs/source-config', response.data)

    def test_eval_server_source_config_api_returns_selected_run_task_ids(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {
            "run_id": "run-existing",
            "created_at": "now",
            "status": "completed",
            "task_ids": ["annotated-1", "annotated-2"],
            "task_set": "annotated",
            "nickname": "step_url_different_oracle_plan",
            "input_mode": "dom",
            "include_oracle_plan": True,
            "force_ground_truth_mode": True,
            "force_ground_truth_retries": 1,
        }
        with patch("eval_server.app.load_run", return_value=run):
            response = server_app.test_client().get("/api/runs/source-config?run_id=run-existing")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["run_id"], "run-existing")
        self.assertEqual(data["task_ids"], ["annotated-1", "annotated-2"])
        self.assertEqual(data["nickname"], "step_url_different_oracle_plan")
        self.assertEqual(data["input_mode"], "dom")
        self.assertTrue(data["include_oracle_plan"])
        self.assertTrue(data["force_ground_truth_mode"])
        self.assertEqual(data["force_ground_truth_retries"], 1)

    def test_eval_server_create_run_persists_warning_and_planning_toggles(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        task = load_tasks("no_login")[0]
        fake_run = {"run_id": "run-warning-options", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_server.app.create_run", return_value=fake_run), \
             patch("eval_server.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_server.app.start_run"):
            response = server_app.test_client().post("/runs", data={
                "task_set": "no_login",
                "task_ids": [task.task_id],
                "inject_grounding_warning": "1",
                "inject_looping_warning": "1",
                "automatic_planning_mode": "1",
                "temperature": "0.7",
                "grounding_warning_threshold": "0.76",
                "loop_warning_threshold": "0.35",
            })
        self.assertEqual(response.status_code, 302)
        self.assertTrue(saved_runs[-1]["inject_grounding_warning"])
        self.assertTrue(saved_runs[-1]["inject_looping_warning"])
        self.assertTrue(saved_runs[-1]["automatic_planning_mode"])
        self.assertEqual(saved_runs[-1]["temperature"], 0.7)
        self.assertEqual(saved_runs[-1]["grounding_warning_threshold"], 0.76)
        self.assertEqual(saved_runs[-1]["loop_warning_threshold"], 0.35)

    def test_eval_server_create_run_persists_force_ground_truth_mode(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        task = load_tasks("annotated")[0]
        fake_run = {"run_id": "run-force-gt", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_server.app.create_run", return_value=fake_run), \
             patch("eval_server.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_server.app.start_run"):
            response = server_app.test_client().post("/runs", data={
                "task_set": "annotated",
                "task_ids": [task.task_id],
                "force_ground_truth_mode": "1",
                "force_ground_truth_retries": "1",
            })
        self.assertEqual(response.status_code, 302)
        self.assertTrue(saved_runs[-1]["force_ground_truth_mode"])
        self.assertEqual(saved_runs[-1]["force_ground_truth_retries"], 1)

    def test_eval_server_start_evaluation_without_source_is_plain_run(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        task = load_tasks("annotated")[0]
        fake_run = {"run_id": "run-plain", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_server.app.load_run", return_value=None), \
             patch("eval_server.app.create_run", return_value=fake_run), \
             patch("eval_server.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_server.app.start_run") as start_run_mock:
            response = server_app.test_client().post("/runs", data={
                "task_set": "annotated",
                "task_ids": [task.task_id],
                "nickname": "plain_run",
            })
        # No source_run_id -> a normal (non-composite) run that redirects to the dashboard.
        self.assertEqual(response.status_code, 302)
        self.assertIn("/?tab=automatic", response.headers["Location"])
        self.assertNotEqual(saved_runs[-1].get("status"), "composite")
        start_run_mock.assert_called_once()

    def test_eval_server_start_evaluation_with_source_creates_composite(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        tasks = load_tasks("annotated")[:2]
        source = {"run_id": "run-existing", "created_at": "old", "status": "completed", "task_ids": [tasks[0].task_id]}
        created = [
            {"run_id": "run-continuation", "created_at": "now", "status": "queued", "task_ids": []},
            {"run_id": "run-composite", "created_at": "now", "status": "queued", "task_ids": []},
        ]
        saved_runs = []
        with patch("eval_server.app.load_run", return_value=source), \
             patch("eval_server.app.create_run", side_effect=created), \
             patch("eval_server.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_server.app.start_run") as start_run_mock:
            # Start Evaluation with a source run selected -> composite (folded into /runs).
            response = server_app.test_client().post("/runs", data={
                "task_set": "annotated",
                "task_ids": [tasks[0].task_id, tasks[1].task_id],
                "source_run_id": "run-existing",
                "nickname": "step_url_different_oracle_plan",
                "include_oracle_plan": "1",
            })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(saved_runs[-1]["status"], "composite")
        self.assertEqual(saved_runs[-1]["input_mode"], "dom")
        self.assertEqual(saved_runs[-1]["composite_sources"], ["run-existing", "run-continuation"])
        self.assertEqual(saved_runs[-1]["task_ids"], [tasks[0].task_id, tasks[1].task_id])
        self.assertEqual(saved_runs[-1]["existing_task_count"], 1)
        self.assertEqual(saved_runs[-1]["continuation_task_count"], 1)
        self.assertTrue(saved_runs[-1]["include_oracle_plan"])
        start_run_mock.assert_called_once()

    def test_eval_server_run_detail_can_show_reference_steps_and_difficulty(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {
            "run_id": "run-refmeta",
            "created_at": "now",
            "status": "completed",
            "task_ids": ["t1"],
            "task_set": "no_login",
        }
        result = {
            "task_id": "t1",
            "status": "completed",
            "task": {"task": "Do short thing", "reference_length": "4"},
            "judge": {"success": True, "reason": "Done"},
            "steps": [],
        }
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.list_task_results", return_value=[result]), \
             patch("eval_server.app.tasks_by_id", return_value={}), \
             patch("eval_server.app.is_running", return_value=False):
            response = server_app.test_client().get("/runs/run-refmeta")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Show Ref Steps / Difficulty", response.data)
        self.assertIn(b"metric-col-refmeta metric-col-hidden", response.data)
        self.assertIn(b"4 ref steps", response.data)
        self.assertIn(b"Easy", response.data)

    def test_eval_server_run_detail_shows_positive_loop_score_panel(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        run = {
            "run_id": "run-loop-positive",
            "created_at": "now",
            "status": "completed",
            "task_ids": ["t1"],
            "task_set": "no_login",
        }
        result = {
            "task_id": "t1",
            "session_id": "loop-session",
            "status": "completed",
            "task": {"name": "Loop Task", "task": "Search twice", "reference_length": "4"},
            "judge": {"success": False, "failureCategory": "LOOP", "reason": "Repeated action"},
            "steps": [
                {"step": 0, "isInitial": True},
                {"step": 1, "action": "click", "instruction": "Click Search", "target": {"llmIndex": 1, "text": "Search"}},
                {"step": 2, "action": "click", "instruction": "Click Search", "target": {"llmIndex": 1, "text": "Search"}},
            ],
        }
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.list_task_results", return_value=[result]), \
             patch("eval_server.app.tasks_by_id", return_value={}), \
             patch("eval_server.app.is_running", return_value=False), \
             patch("eval_server.app.load_stars", return_value={}):
            response = server_app.test_client().get("/runs/run-loop-positive")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Loop Score Greater Than Zero", response.data)
        self.assertIn(b"Steps With L_t_u &gt; 0", response.data)
        self.assertIn(b"Tasks With L_t_u &gt; 0", response.data)
        self.assertIn(b"1 of 2 checked steps with L_t_u &gt; 0", response.data)
        self.assertIn(b"Step 2: 0.10", response.data)

    def test_run_dashboard_renders_zero_step_diagnostics_and_task_charts(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "test-run", "created_at": "now", "status": "completed", "task_ids": ["t1"]}
        result = {
            "task_id": "t1",
            "task": {"task": "Do thing", "website_url": "https://example.test", "level": "Easy"},
            "terminal_reason": "NO STEPS RECORDED",
            "judge": {"success": False, "failureCategory": "FAILED TO EXECUTE ACTION", "reason": "Not done"},
            "steps": [],
            "diagnostics": {
                "zero_step_explanation": "PageGuide was started, but no LLM prompt/debug record or rewind step was observed before the idle timeout.",
                "phase": "executing steps",
                "content_script_ready": True,
                "guide_start_sent": True,
                "debug_prompt_count": 0,
                "final_url": "https://example.test",
            },
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.list_task_results", return_value=[result]), \
             patch("eval_tool.app.is_running", return_value=False):
            response = app.test_client().get("/runs/test-run")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Per Task Charts", response.data)
        self.assertIn(b"No PageGuide steps were recorded.", response.data)
        self.assertIn(b"No recorded action steps.", response.data)

    def test_task_detail_renders_dom_before_and_target(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "test-run", "created_at": "now", "status": "completed"}
        result = {
            "task_id": "t1",
            "task": {"name": "Task", "task": "Do thing", "website_url": "https://example.test"},
            "terminal_reason": "DONE",
            "judge": {"success": True, "reason": "Done", "confidence": 0.9},
            "steps": [{
                "step": 1,
                "instruction": "Click thing",
                "action": "click",
                "domSnapshot": "<html><body><button>Before</button></body></html>",
                "regionDom": "<button data-id=\"x\">Target</button>",
                "domSnapshotAfter": "<html><body>After</body></html>",
            }],
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.load_task_result", return_value=result):
            response = app.test_client().get("/runs/test-run/tasks/t1")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"DOM Before", response.data)
        self.assertIn(b"DOM Target", response.data)
        self.assertIn(b"Target crops are cut from the before-action viewport screenshot", response.data)
        self.assertIn(b"&lt;button data-id=&#34;x&#34;&gt;Target&lt;/button&gt;", response.data)

    def test_filter_options_deduplicates_levels_and_errors(self):
        summary = {"categories": {"FAILED TO EXECUTE ACTION": 2}}
        options = filter_options([
            {"task": {"level": "Easy"}, "judge": {"success": False, "failureCategory": "FAILED TO EXECUTE ACTION"}},
            {"task": {"level": "easy"}, "judge": {"success": False, "failureCategory": "FAILED TO EXECUTE ACTION"}},
        ], summary)
        self.assertEqual(options["levels"], [{"value": "easy", "label": "Easy"}])
        self.assertEqual(options["errors"], [{"value": "failed to execute action", "label": "FAILED TO EXECUTE ACTION"}])

    def test_stop_route_stops_running_run(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "test-run", "created_at": "now", "status": "running", "task_ids": ["t1"]}
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.is_running", return_value=True), \
             patch("eval_tool.app.stop_run") as stop:
            response = app.test_client().post("/runs/test-run/stop")
        self.assertEqual(response.status_code, 302)
        stop.assert_called_once_with("test-run")

    def test_phase3_force_rejudges_and_stores_full_ground_truth(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "test-run", "created_at": "now", "status": "completed", "task_ids": ["t1"]}
        result = {
            "task_id": "t1",
            "task": {"task": "Do thing", "reference_steps": "1. Do thing"},
            "steps": [{
                "step": 1,
                "instruction": "Click thing",
                "action": "click",
                "grounded": 0.8,
                "loop": 0.0,
                "progress": 0.1,
                "progress_ground_truth": 0.0,
                "confidence_versions": {"full": 0.824},
            }],
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.list_task_results", return_value=[result]), \
             patch("eval_tool.app.save_task_result") as save_task_result, \
             patch("eval_tool.app.LlmJudge") as judge_cls:
            judge_cls.return_value.judge_progress_with_ground_truth.return_value = {
                "progress_ground_truth": 0.75,
                "reason": "Close to done",
            }
            response = app.test_client().post("/runs/test-run/phase3/judge", data={"force": "1"})
        self.assertEqual(response.status_code, 302)
        saved = save_task_result.call_args.args[2]
        self.assertEqual(saved["steps"][0]["progress_ground_truth"], 0.75)
        self.assertIn("full_ground_truth", saved["steps"][0]["confidence_versions"])

    def test_phase3_rows_include_full_ground_truth_comparison(self):
        rows = build_phase3_rows([{
            "task_id": "t1",
            "task": {"task": "Do thing", "reference_steps": "1. Do thing"},
            "steps": [{
                "step": 1,
                "instruction": "Click thing",
                "grounded": 0.8,
                "loop": 0.0,
                "progress": 0.0,
                "progress_ground_truth": 0.75,
                "confidence_versions": {"full": 0.8, "full_ground_truth": 0.98},
                "progress_ground_truth_judge": {"reason": "Close to done"},
            }],
        }])
        self.assertEqual(rows[0]["full_self"], 0.8)
        self.assertEqual(rows[0]["full_ground_truth"], 0.98)
        self.assertEqual(rows[0]["ground_truth_reason"], "Close to done")

    def test_running_dashboard_uses_task_ids_for_total_before_results_exist(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {
            "run_id": "test-run",
            "created_at": "now",
            "status": "running",
            "task_ids": ["t1"],
            "task_index": 1,
            "current_step": 0,
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.list_task_results", return_value=[]), \
             patch("eval_tool.app.is_running", return_value=True):
            response = app.test_client().get("/runs/test-run")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Task 1 of 1", response.data)
        self.assertIn(b"0 of 1 tasks finished", response.data)


class EvalRunnerAutoLoginTest(unittest.IsolatedAsyncioTestCase):
    async def test_auto_login_no_credentials_does_not_open_page(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        context = Mock()
        context.pages = []
        context.new_page = AsyncMock()

        with patch("eval_tool.auto_login.accounts_path", return_value=Path("/tmp/missing-accounts.txt")), \
             patch("eval_tool.credentials.password_file_path", return_value=Path("/tmp/missing-password.txt")):
            await runner._auto_login(context)

        context.new_page.assert_not_called()

    async def test_auto_login_uses_password_file_accounts(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        runner.auto_login = True
        page = Mock()
        context = Mock()
        context.pages = [page]
        account = Account("example", "https://example.test/login", "user@example.test", "secret")

        with TemporaryDirectory() as tmp:
            password_file = Path(tmp) / "password.txt"
            password_file.write_text("Example\nEmail: user@example.test\nPassword: secret\n", encoding="utf-8")
            with patch("eval_tool.auto_login.accounts_path", return_value=Path(tmp) / "missing-accounts.txt"), \
                 patch("eval_tool.credentials.password_file_path", return_value=password_file), \
                 patch("eval_tool.auto_login.resolve_accounts", return_value=[account]), \
                 patch("eval_tool.auto_login._sign_in", new_callable=AsyncMock) as sign_in:
                await runner._auto_login(context)

        sign_in.assert_awaited_once_with(page, account)

    async def test_set_ground_truth_steps_sets_when_enabled_and_clears_otherwise(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        extension_page = Mock()
        extension_page.evaluate = AsyncMock()
        task = Mock(reference_steps="1. Open page; 2. Click search")

        runner.ground_truth_mode = True
        await runner._set_ground_truth_steps(extension_page, task)
        self.assertEqual(extension_page.evaluate.await_args.args[1], {"steps": "1. Open page; 2. Click search"})

        runner.ground_truth_mode = False
        await runner._set_ground_truth_steps(extension_page, task)
        self.assertEqual(extension_page.evaluate.await_args.args[1], {"steps": ""})

    async def test_guide_query_includes_oracle_plan_when_enabled(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        task = Mock(task="Find store", reference_steps="Open site\nSearch zip\nSet home store")

        runner.include_oracle_plan = True
        query = runner._guide_query_for_task(task)
        self.assertIn("Find store", query)
        self.assertIn("ORACLE PLAN FROM THE ANNOTATED DATASET", query)
        self.assertIn("1. Open site", query)
        self.assertIn("3. Set home store", query)

        runner.include_oracle_plan = False
        self.assertEqual(runner._guide_query_for_task(task), "Find store")

    async def test_attach_oracle_plan_to_steps_for_inspection(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        steps = [{"step": 1, "action": "click"}, {"step": 2, "action": "type"}]

        runner._attach_oracle_plan_to_steps(steps, "1. Open\n2. Search", "Task\n\nORACLE PLAN...")

        self.assertTrue(steps[0]["oraclePlanIncluded"])
        self.assertEqual(steps[0]["oraclePlan"], "1. Open\n2. Search")
        self.assertIn("ORACLE PLAN", steps[1]["guideQueryWithOraclePlan"])

    async def test_force_ground_truth_plan_starts_at_second_annotated_url(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        runner.force_ground_truth_mode = True
        runner.force_ground_truth_retries = 1
        task = Mock(
            annotated_subgoals=["Visit site", "Open search results", "Open details"],
            annotated_reference_urls=["https://example.com/", "https://example.com/search", "https://example.com/details"],
            annotated_match_functions=["url_included_match", "url_exactly_match", "url_exactly_match"],
        )

        plan = runner._force_ground_truth_plan_for_task(task)

        self.assertEqual([item["step"] for item in plan], [2, 3])
        self.assertEqual(plan[0]["subgoal"], "Open search results")
        self.assertEqual(plan[0]["expectedUrl"], "https://example.com/search")

    async def test_set_force_ground_truth_plan_writes_storage_payload(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        runner.force_ground_truth_mode = True
        runner.force_ground_truth_retries = 2
        task = Mock(
            annotated_subgoals=["Visit site", "Search"],
            annotated_reference_urls=["https://example.com/", "https://example.com/search"],
            annotated_match_functions=["url_included_match", "url_exactly_match"],
        )
        extension_page = Mock()
        extension_page.evaluate = AsyncMock()

        await runner._set_force_ground_truth_plan(extension_page, task)

        payload = extension_page.evaluate.await_args.args[1]
        self.assertTrue(payload["enabled"])
        self.assertEqual(payload["retries"], 2)
        self.assertEqual(payload["plan"][0]["step"], 2)
        self.assertEqual(payload["plan"][0]["expectedUrl"], "https://example.com/search")

    async def test_set_eval_prefs_writes_warning_and_planning_options(self):
        run = {
            "run_id": "run-test",
            "max_steps": 12,
            "task_model": "openai/gpt-4.1-nano",
            "inject_grounding_warning": True,
            "inject_looping_warning": True,
            "automatic_planning_mode": True,
            "region_capture_mode": "aligned",
            "temperature": 0.4,
            "grounding_warning_threshold": 0.76,
            "loop_warning_threshold": 0.35,
        }
        with patch("eval_tool.runner.load_run", return_value=run), \
             patch("eval_tool.runner._env_value", return_value="test-key"):
            runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        extension_page = Mock()
        extension_page.evaluate = AsyncMock()

        await runner._set_eval_prefs(extension_page)

        payload = extension_page.evaluate.await_args.args[1]
        self.assertTrue(payload["groundingWarning"])
        self.assertTrue(payload["loopingWarning"])
        self.assertEqual(payload["planningMode"], "planning")
        self.assertEqual(payload["regionCaptureMode"], "aligned")
        self.assertEqual(payload["temperature"], 0.4)
        self.assertEqual(payload["groundingThreshold"], 0.76)
        self.assertEqual(payload["loopThreshold"], 0.35)
        script = extension_page.evaluate.await_args.args[0]
        self.assertIn("guideEvalGroundingWarningEnabled", script)
        self.assertIn("guideEvalLoopWarningEnabled", script)
        self.assertIn("guideDebugPlanningMode", script)
        self.assertIn("guideEvalTemperature", script)
        self.assertIn("guideEvalGroundingWarningThreshold: groundingThreshold", script)
        self.assertIn("guideEvalLoopWarningThreshold: loopThreshold", script)

    async def test_clear_task_storage_removes_stale_rewind_and_debug_keys(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        extension_page = Mock()
        extension_page.evaluate = AsyncMock()

        await runner._clear_task_storage(extension_page)

        script = extension_page.evaluate.await_args.args[0]
        self.assertIn("RW_CURRENT", script)
        self.assertIn("RW_IDX::", script)
        self.assertIn("RW_REC::", script)
        self.assertIn("debugPrompts", script)

    async def test_load_rewind_steps_without_session_does_not_use_stale_current_session(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        extension_page = Mock()
        extension_page.evaluate = AsyncMock()

        steps = await runner._load_rewind_steps(extension_page, None, "task-1")

        self.assertEqual(steps, {"steps": [], "spec_goal_text": None, "predictedGoalState": None})
        extension_page.evaluate.assert_not_called()

    async def test_load_rewind_steps_prepends_planning_step(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        extension_page = Mock()
        extension_page.evaluate = AsyncMock(return_value={
            "steps": [{"step": 1, "instruction": "Click Search", "action": "click"}],
            "spec_goal_text": None,
            "predictedGoalState": None,
            "planning": {
                "planTitle": "Search task",
                "plan": [
                    {"n": 1, "goal": "Open search", "status": "complete"},
                    {"n": 2, "goal": "Submit query", "status": "pending"},
                ],
                "planningPromptTimestamp": 123,
                "planningSystemPrompt": "planning system",
                "planningPrompt": "planning user prompt",
                "planningRawResponse": "{\"planTitle\":\"Search task\"}",
                "planningMode": "planning",
            },
        })

        loaded = await runner._load_rewind_steps(extension_page, "session-1", "task-1")

        self.assertEqual(loaded["steps"][0]["step"], -1)
        self.assertEqual(loaded["steps"][0]["action"], "plan")
        self.assertTrue(loaded["steps"][0]["isPlanningStep"])
        self.assertIn("Search task", loaded["steps"][0]["instruction"])
        self.assertIn("1. Open search [complete]", loaded["steps"][0]["instruction"])
        self.assertEqual(loaded["steps"][0]["systemPrompt"], "planning system")
        self.assertEqual(loaded["steps"][0]["userPrompt"], "planning user prompt")
        self.assertEqual(loaded["steps"][0]["rawLlmJson"], "{\"planTitle\":\"Search task\"}")
        self.assertEqual(loaded["steps"][1]["step"], 1)

    async def test_navigate_to_task_uses_commit_and_treats_domcontentloaded_as_best_effort(self):
        runner = PlaywrightGuideRunner("run-test", Mock(), Mock())
        page = Mock()
        page.url = "https://example.test"
        page.goto = AsyncMock()
        page.wait_for_load_state = AsyncMock(side_effect=TimeoutError("slow"))
        diagnostics = {}

        await runner._navigate_to_task(page, "https://example.test", diagnostics)

        page.goto.assert_awaited_once_with("https://example.test", wait_until="commit", timeout=20000)
        page.wait_for_load_state.assert_awaited_once_with("domcontentloaded", timeout=15000)
        self.assertFalse(diagnostics["domcontentloaded"])


class EvalRunnerDiagnosticsTest(unittest.TestCase):
    def test_zero_step_explanation_identifies_missing_content_script(self):
        explanation = _zero_step_explanation({
            "tab_found": True,
            "content_script_ready": False,
            "guide_start_sent": False,
            "debug_prompt_count": 0,
        }, "NO STEPS RECORDED")
        self.assertIn("content script", explanation)

    def test_zero_step_explanation_identifies_started_without_prompts(self):
        explanation = _zero_step_explanation({
            "tab_found": True,
            "content_script_ready": True,
            "guide_start_sent": True,
            "debug_prompt_count": 0,
        }, "NO STEPS RECORDED")
        self.assertIn("no LLM prompt", explanation)


class RegionCaptureModeTest(unittest.TestCase):
    def test_normalize_region_capture_mode(self):
        self.assertEqual(normalize_region_capture_mode("legacy"), "legacy")
        self.assertEqual(normalize_region_capture_mode("aligned"), "aligned")
        self.assertEqual(normalize_region_capture_mode("new_target_captured"), "aligned")
        self.assertEqual(normalize_region_capture_mode(None), "legacy")

    def test_region_capture_mode_label(self):
        self.assertEqual(region_capture_mode_label("legacy"), "Legacy target captured")
        self.assertEqual(region_capture_mode_label("aligned"), "New Target Captured")


class OnlineMind2WebTaskSetTest(unittest.TestCase):
    def test_normalize_task_set_round_trips_online_mind2web(self):
        from eval_tool.storage import normalize_task_set
        self.assertEqual(normalize_task_set("online_mind2web"), "online_mind2web")
        self.assertEqual(normalize_task_set("Online-Mind2Web"), "online_mind2web")

    def test_task_set_options_include_online_mind2web(self):
        from eval_tool.storage import task_set_options
        ids = {opt["id"] for opt in task_set_options()}
        self.assertIn("online_mind2web", ids)

    def test_current_data_csv_returns_online_mind2web_path_when_present(self):
        from eval_tool.storage import ONLINE_MIND2WEB_DATA_CSV, current_data_csv
        with patch.object(Path, "exists", return_value=True):
            self.assertEqual(current_data_csv("online_mind2web"), ONLINE_MIND2WEB_DATA_CSV)

    def test_downloader_maps_online_mind2web_row_to_csv_columns(self):
        from scripts.download_online_mind2web import map_row
        row = map_row({
            "task_id": "abc123",
            "website": "https://www.example.com",
            "confirmed_task": "Find the cheapest flight to LA",
            "reference_length": 9,
            "level": "hard",
        })
        self.assertEqual(row["task_id"], "abc123")
        self.assertEqual(row["task"], "Find the cheapest flight to LA")
        # Full URL is used as-is, not synthesized.
        self.assertEqual(row["website_url"], "https://www.example.com")
        self.assertEqual(row["reference_length"], 9)
        # Dataset's own level wins over the step-count inference.
        self.assertEqual(row["level"], "Hard")
        self.assertEqual(row["reference_steps"], "")
        self.assertIn("Find the cheapest flight to LA", row["success_criteria"])

    def test_downloader_falls_back_to_inferred_level_without_dataset_level(self):
        from scripts.download_online_mind2web import map_row
        row = map_row({
            "task_id": "x", "website": "https://e.com",
            "confirmed_task": "Do a short task", "reference_length": 4,
        })
        self.assertEqual(row["level"], "Easy")  # 4 steps -> Easy bucket

    def test_short_site_name_strips_www_and_tld(self):
        self.assertEqual(short_site_name("https://www.rottentomatoes.com/"), "rottentomatoes")
        self.assertEqual(short_site_name("https://www.imdb.com/"), "imdb")
        self.assertEqual(short_site_name("https://us.speedo.com/"), "us.speedo.com")
        self.assertEqual(short_site_name("https://new.mta.info/"), "new.mta.info")

    def test_display_task_name_uses_site_for_online_mind2web(self):
        task = {
            "name": "online_mind2web",
            "website_url": "https://www.rottentomatoes.com/",
        }
        self.assertEqual(display_task_name(task), "rottentomatoes")

    def test_display_task_name_keeps_named_tasks(self):
        task = {"name": "exploretock", "website_url": "https://www.exploretock.com/"}
        self.assertEqual(display_task_name(task), "exploretock")


class JudgeMethodTest(unittest.TestCase):
    def test_normalize_judge_method_defaults_to_webjudge(self):
        from eval_tool.judge import normalize_judge_method
        self.assertEqual(normalize_judge_method(None), "webjudge")
        self.assertEqual(normalize_judge_method("not-a-method"), "webjudge")
        self.assertEqual(normalize_judge_method("final-screenshot"), "final_screenshot")
        self.assertEqual(normalize_judge_method("webjudge"), "webjudge")

    def test_create_run_persists_judge_method_default_webjudge(self):
        app = create_app()
        app.config.update(TESTING=True)
        task = load_tasks("no_login")[0]
        fake_run = {"run_id": "test-jm-run", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_tool.app.create_run", return_value=fake_run), \
             patch("eval_tool.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_tool.app.start_run"):
            response = app.test_client().post("/runs", data={"task_ids": [task.task_id]})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(saved_runs[-1]["judge_method"], "webjudge")

    def test_create_run_honors_final_screenshot_judge_method(self):
        app = create_app()
        app.config.update(TESTING=True)
        task = load_tasks("no_login")[0]
        fake_run = {"run_id": "test-jm-run2", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_tool.app.create_run", return_value=fake_run), \
             patch("eval_tool.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_tool.app.start_run"):
            response = app.test_client().post("/runs", data={
                "task_ids": [task.task_id],
                "judge_method": "final_screenshot",
            })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(saved_runs[-1]["judge_method"], "final_screenshot")


class GroundTruthToggleTest(unittest.TestCase):
    def _post_run(self, data):
        app = create_app()
        app.config.update(TESTING=True)
        fake_run = {"run_id": "test-gt-run", "created_at": "now", "status": "queued", "task_ids": []}
        saved_runs = []
        with patch("eval_tool.app.create_run", return_value=fake_run), \
             patch("eval_tool.app.save_run", side_effect=lambda run: saved_runs.append(run) or run), \
             patch("eval_tool.app.start_run"):
            response = app.test_client().post("/runs", data=data)
        self.assertEqual(response.status_code, 302)
        return saved_runs[-1]

    def test_no_login_run_enables_ground_truth_mode_when_checked(self):
        task = load_tasks("no_login")[0]
        saved = self._post_run({
            "task_set": "no_login",
            "task_ids": [task.task_id],
            "ground_truth_mode": "1",
        })
        self.assertTrue(saved["ground_truth_mode"])

    def test_no_login_run_defaults_ground_truth_mode_off(self):
        task = load_tasks("no_login")[0]
        saved = self._post_run({"task_set": "no_login", "task_ids": [task.task_id]})
        self.assertFalse(saved["ground_truth_mode"])

    def test_non_no_login_set_cannot_enable_ground_truth_mode(self):
        task = load_tasks("mind2web")[0]
        saved = self._post_run({
            "task_set": "mind2web",
            "task_ids": [task.task_id],
            "ground_truth_mode": "1",
        })
        self.assertFalse(saved["ground_truth_mode"])

    def test_annotated_run_can_enable_oracle_plan(self):
        task = load_tasks("annotated")[0]
        saved = self._post_run({
            "task_set": "annotated",
            "task_ids": [task.task_id],
            "include_oracle_plan": "1",
        })
        self.assertTrue(saved["include_oracle_plan"])

    def test_non_annotated_run_cannot_enable_oracle_plan(self):
        task = load_tasks("no_login")[0]
        saved = self._post_run({
            "task_set": "no_login",
            "task_ids": [task.task_id],
            "include_oracle_plan": "1",
        })
        self.assertFalse(saved["include_oracle_plan"])

    def test_annotated_run_can_enable_force_ground_truth_mode(self):
        task = load_tasks("annotated")[0]
        saved = self._post_run({
            "task_set": "annotated",
            "task_ids": [task.task_id],
            "force_ground_truth_mode": "1",
            "force_ground_truth_retries": "2",
        })
        self.assertTrue(saved["force_ground_truth_mode"])
        self.assertEqual(saved["force_ground_truth_retries"], 2)

    def test_force_ground_truth_retry_count_is_clamped(self):
        task = load_tasks("annotated")[0]
        saved = self._post_run({
            "task_set": "annotated",
            "task_ids": [task.task_id],
            "force_ground_truth_mode": "1",
            "force_ground_truth_retries": "8",
        })
        self.assertEqual(saved["force_ground_truth_retries"], 2)

    def test_non_annotated_run_cannot_enable_force_ground_truth_mode(self):
        task = load_tasks("no_login")[0]
        saved = self._post_run({
            "task_set": "no_login",
            "task_ids": [task.task_id],
            "force_ground_truth_mode": "1",
            "force_ground_truth_retries": "2",
        })
        self.assertFalse(saved["force_ground_truth_mode"])


class WebJudgeTest(unittest.TestCase):
    def test_parse_screenshot_score(self):
        from eval_tool.webjudge import parse_screenshot_score
        self.assertEqual(parse_screenshot_score("Score: 4"), 4)
        self.assertEqual(parse_screenshot_score("5"), 5)
        self.assertEqual(parse_screenshot_score("no digit here"), 0)

    def test_parse_status(self):
        from eval_tool.webjudge import parse_status
        self.assertTrue(parse_status("Reasoning...\nStatus: success"))
        self.assertFalse(parse_status("Status: failure"))
        self.assertIsNone(parse_status("no verdict at all"))

    def test_build_action_history_excludes_initial(self):
        from eval_tool.webjudge import build_action_history
        history = build_action_history([
            {"isInitial": True, "action": "state"},
            {"action": "click", "target": {"text": "Search"}},
            {"action": "type", "target": {"text": "LA"}},
        ])
        self.assertNotIn("state", history)
        self.assertIn("1. click -> Search", history)
        self.assertIn("2. type -> LA", history)

    def test_judge_trajectory_returns_normalized_success(self):
        from eval_tool.webjudge import WebJudge, REPO_ROOT
        judge = WebJudge(api_key="test")
        # Screenshots must live inside the repo (in-repo safety check), so write a
        # temp file under eval_tool/ rather than in the system temp dir.
        shot = REPO_ROOT / "eval_tool" / "_wj_test_shot.png"
        shot.write_bytes(b"fakepng")
        try:
            steps = [{"action": "click", "target": {"text": "Buy"}, "screenshot": str(shot.relative_to(REPO_ROOT))}]
            with patch.object(judge.llm, "_call_openai") as call:
                # key points, then screenshot score, then outcome
                call.side_effect = ["1. Item purchased", "5", "Looks done.\nStatus: success"]
                result = judge.judge_trajectory({"task": "Buy an item"}, steps, shot)
        finally:
            shot.unlink(missing_ok=True)
        self.assertTrue(result["success"])
        self.assertIsNone(result["failureCategory"])
        self.assertEqual(result["method"], "webjudge")
        self.assertIn("screenshot_scores", result)

    def test_judge_trajectory_always_includes_final_screenshot(self):
        from eval_tool.webjudge import WebJudge, REPO_ROOT
        judge = WebJudge(api_key="test", max_screenshots=2)
        shot_dir = REPO_ROOT / "eval_tool"
        step1 = shot_dir / "_wj_step_1.png"
        step2 = shot_dir / "_wj_step_2.png"
        final = shot_dir / "_wj_final.png"
        for path in (step1, step2, final):
            path.write_bytes(b"fakepng")
        steps = [
            {"action": "click", "screenshot": str(step1.relative_to(REPO_ROOT))},
            {"action": "click", "screenshot": str(step2.relative_to(REPO_ROOT))},
        ]
        captured = {}
        try:
            def fake_outcome(task, key_points, images, history):
                captured["images"] = images
                return {"success": True, "failureCategory": None, "reason": "ok", "confidence": 1}

            with patch.object(judge, "identify_key_points", return_value="1. Done"), \
                 patch.object(judge, "score_screenshot", return_value=5), \
                 patch("eval_tool.webjudge._encode_image", side_effect=lambda path: str(path.relative_to(REPO_ROOT))), \
                 patch.object(judge, "judge_outcome", side_effect=fake_outcome):
                result = judge.judge_trajectory({"task": "Do thing"}, steps, final)
        finally:
            for path in (step1, step2, final):
                path.unlink(missing_ok=True)
        self.assertTrue(result["success"])
        self.assertIn(str(final.relative_to(REPO_ROOT)), captured["images"])
        self.assertEqual(result["selected_screenshot_count"], 3)

    def test_judge_trajectory_without_api_key_is_non_fatal(self):
        from eval_tool.webjudge import WebJudge
        judge = WebJudge(api_key=None)
        judge.api_key = None
        result = judge.judge_trajectory({"task": "Do thing"}, [], None)
        self.assertFalse(result["success"])
        # Passes through the same normalized shape as the legacy judge.
        self.assertIn("confidence", result)
        self.assertIn("reason", result)
        self.assertIn("failureCategory", result)


SAMPLE_DOM = """
<html><body>
  <h1>Search Results</h1>
  <input type="text" name="q" value="bra top">
  <input type="checkbox" name="agree" checked aria-label="Agree to terms">
  <select name="size"><option>Small</option><option selected>Medium</option></select>
  <input type="radio" name="fit" value="XL" checked aria-label="XL">
  <button aria-selected="true">Purple</button>
  <button aria-pressed="true">High Support</button>
  <button class="size-option active">Large</button>
  <button>Add to cart</button>
  <div role="alert" aria-label="Success message">Order placed</div>
  <script>var x = 'hidden script text';</script>
</body></html>
"""


class SubgoalPageStateTest(unittest.TestCase):
    def _state(self, url="https://shop.test/search?q=1", dom=SAMPLE_DOM):
        from eval_tool.subgoal_progress import PageState
        return PageState(url, dom)

    def test_extracts_visible_text_excluding_scripts(self):
        state = self._state()
        self.assertIn("search results", state.visible_text)
        self.assertIn("order placed", state.visible_text)
        self.assertNotIn("hidden script text", state.visible_text)

    def test_extracts_form_control_state(self):
        state = self._state()
        q = next(c for c in state.controls if c["name"] == "q")
        self.assertEqual(q["value"], "bra top")
        agree = next(c for c in state.controls if c["name"] == "agree")
        self.assertTrue(agree["checked"])
        size = next(c for c in state.controls if c["name"] == "size")
        self.assertIn("Medium", size["selected_text"])

    def test_check_types(self):
        from eval_tool.subgoal_progress import evaluate_check
        state = self._state()
        self.assertTrue(evaluate_check({"type": "url_includes", "value": "search"}, state))
        self.assertTrue(evaluate_check({"type": "text_includes", "value": "order placed"}, state))
        self.assertTrue(evaluate_check({"type": "text_excludes", "value": "error 500"}, state))
        self.assertTrue(evaluate_check({"type": "input_value", "name": "q", "value": "bra top"}, state))
        self.assertTrue(evaluate_check({"type": "checkbox_checked", "label": "agree"}, state))
        self.assertTrue(evaluate_check({"type": "select_value", "value": "medium"}, state))
        self.assertTrue(evaluate_check({"type": "role_label", "role": "button", "name": "add to cart"}, state))
        self.assertTrue(evaluate_check({"type": "role_label", "role": "alert", "name": "success"}, state))
        self.assertTrue(evaluate_check({"type": "selected_value", "value": "medium"}, state))
        self.assertTrue(evaluate_check({"type": "selected_value", "value": "purple"}, state))
        self.assertTrue(evaluate_check({"type": "control_state", "label": "XL", "state": "checked"}, state))
        self.assertTrue(evaluate_check({"type": "control_state", "label": "High Support", "state": "pressed"}, state))
        self.assertTrue(evaluate_check({"type": "control_state", "label": "Large", "state": "active"}, state))
        self.assertTrue(evaluate_check({"type": "text_group_includes", "all_of": ["search-results", "order placed"]}, state))
        # Negatives
        self.assertFalse(evaluate_check({"type": "text_includes", "value": "no such text"}, state))
        self.assertFalse(evaluate_check({"type": "checkbox_checked", "label": "newsletter"}, state))

    def test_subgoal_verified_legacy_checks_requires_all_checks(self):
        from eval_tool.subgoal_progress import subgoal_verified
        state = self._state()
        ok = {"checks": [{"type": "url_includes", "value": "search"}, {"type": "text_includes", "value": "order placed"}]}
        bad = {"checks": [{"type": "url_includes", "value": "search"}, {"type": "text_includes", "value": "missing"}]}
        self.assertTrue(subgoal_verified(ok, state))
        self.assertFalse(subgoal_verified(bad, state))
        self.assertFalse(subgoal_verified({"checks": []}, state))

    def test_subgoal_verified_checks_any_uses_or_semantics(self):
        from eval_tool.subgoal_progress import subgoal_verified
        state = self._state()
        any_ok = {"checks_any": [
            {"type": "text_includes", "value": "missing"},
            {"type": "url_includes", "value": "search"},
        ]}
        any_bad = {"checks_any": [
            {"type": "text_includes", "value": "missing"},
            {"type": "url_includes", "value": "checkout"},
        ]}
        self.assertTrue(subgoal_verified(any_ok, state))
        self.assertFalse(subgoal_verified(any_bad, state))

    def test_xl_visible_text_alone_does_not_satisfy_selected_size_check(self):
        from eval_tool.subgoal_progress import PageState, evaluate_check, subgoal_verified
        state = PageState("https://shop.test/p/1", """
          <html><body>
            <button>XS</button><button>S</button><button>M</button>
            <button>L</button><button>XL</button><button>XXL</button>
          </body></html>
        """)
        self.assertTrue(evaluate_check({"type": "text_includes", "value": "XL"}, state))
        self.assertFalse(subgoal_verified({"checks_any": [
            {"type": "selected_value", "value": "XL"},
            {"type": "control_state", "label": "XL", "state": "selected"},
            {"type": "control_state", "label": "XL", "state": "pressed"},
            {"type": "text_includes", "value": "Size: XL"},
        ]}, state))


class SubgoalScoringTest(unittest.TestCase):
    def _result(self):
        def dom(text):
            return f"<html><body>{text}</body></html>"
        return {
            "subgoal_rubric": {"subgoals": [
                {"order": 1, "goal": "alpha", "checks": [{"type": "text_includes", "value": "alpha"}]},
                {"order": 2, "goal": "beta", "checks": [{"type": "text_includes", "value": "beta"}]},
            ]},
            "steps": [
                {"step": 1, "url": "", "domSnapshotAfter": dom("alpha")},
                {"step": 2, "url": "", "domSnapshotAfter": dom("alpha beta")},
                {"step": 3, "url": "", "domSnapshotAfter": dom("alpha beta extra3")},
                {"step": 4, "url": "", "domSnapshotAfter": dom("alpha beta")},
                {"step": 5, "url": "", "domSnapshotAfter": dom("alpha")},
            ],
        }

    def test_per_step_scores_use_loop_for_zero(self):
        # 1.0 when a new subgoal completes; 0.0 when no new subgoal AND looping (L_t_u > 0.5);
        # 0.5 when no new subgoal but not looping.
        from eval_tool.subgoal_progress import score_subgoal_progress
        def dom(t):
            return f"<html><body>{t}</body></html>"
        result = {
            "subgoal_rubric": {"subgoals": [
                {"order": 1, "goal": "alpha", "checks_any": [{"type": "text_includes", "value": "alpha"}]},
            ]},
            "steps": [
                {"step": 1, "url": "", "action": "click", "instruction": "go", "domSnapshotAfter": dom("alpha")},
                {"step": 2, "url": "", "action": "click", "instruction": "go", "domSnapshotAfter": dom("alpha")},
                {"step": 3, "url": "", "action": "click", "instruction": "go", "domSnapshotAfter": dom("alpha")},
                {"step": 4, "url": "", "action": "click", "instruction": "go", "domSnapshotAfter": dom("alpha")},
                {"step": 5, "url": "", "action": "click", "instruction": "go", "domSnapshotAfter": dom("alpha")},
                {"step": 6, "url": "", "action": "click", "instruction": "go", "domSnapshotAfter": dom("alpha")},
                {"step": 7, "url": "", "action": "click", "instruction": "go", "domSnapshotAfter": dom("alpha")},
                {"step": 8, "url": "", "action": "click", "instruction": "other", "domSnapshotAfter": dom("alpha")},
            ],
        }
        self.assertTrue(score_subgoal_progress(result))
        scores = [s["subgoal_progress"] for s in result["steps"]]
        # step1 completes alpha → 1.0; steps 2..6 no new + repeats < 6 times (L_t_u <= 0.5) → 0.5;
        # step7 repeats 6 times (L_t_u = 0.6 > 0.5) → 0.0; step8 a different action (L_t_u = 0.0) → 0.5
        self.assertEqual(scores, [1.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.0, 0.5])
        self.assertAlmostEqual(result["steps"][6]["subgoal_loop_score"], 0.6)
        self.assertAlmostEqual(result["steps"][7]["subgoal_loop_score"], 0.0)

    def test_independent_subgoals_are_not_implied_by_a_later_one(self):
        # Subgoals are independent: verifying #3 must NOT auto-credit #1 and #2.
        from eval_tool.subgoal_progress import score_subgoal_progress
        result = {
            "subgoal_rubric": {"subgoals": [
                {"order": 1, "goal": "alpha", "checks_any": [{"type": "text_includes", "value": "alpha"}]},
                {"order": 2, "goal": "beta", "checks_any": [{"type": "text_includes", "value": "beta"}]},
                {"order": 3, "goal": "gamma", "checks_any": [{"type": "text_includes", "value": "gamma"}]},
            ]},
            "steps": [
                {"step": 1, "url": "", "domSnapshotAfter": "<html><body>gamma</body></html>"},
            ],
        }
        self.assertTrue(score_subgoal_progress(result))
        step = result["steps"][0]
        self.assertEqual(step["subgoal_verified"], 1)
        self.assertEqual(step["subgoal_direct_verified_indices"], [3])
        self.assertEqual(step["subgoal_verified_indices"], [3])
        self.assertEqual(step["subgoal_implied_indices"], [])

    def test_select_value_matches_option_value_attribute(self):
        # <option value="XL">Extra Large</option> selected → select_value "XL" must pass even
        # though the visible option text is "Extra Large" (the XL bug).
        from eval_tool.subgoal_progress import PageState, evaluate_check
        state = PageState("https://shop.test/p/1", """
          <html><body>
            <select name="size">
              <option value="M">Medium</option>
              <option value="XL" selected>Extra Large</option>
            </select>
          </body></html>
        """)
        self.assertTrue(evaluate_check({"type": "select_value", "value": "XL"}, state))
        self.assertTrue(evaluate_check({"type": "select_value", "value": "Extra Large"}, state))
        self.assertTrue(evaluate_check({"type": "selected_value", "value": "XL"}, state))
        # A non-selected option's value must not match.
        self.assertFalse(evaluate_check({"type": "select_value", "value": "M"}, state))

    def test_input_value_falls_back_when_named_field_not_found(self):
        # A typed search term often lands in a field whose name differs from the rubric's `name`.
        from eval_tool.subgoal_progress import PageState, evaluate_check
        state = PageState("https://jobs.test/search", """
          <html><body>
            <input name="keywords" value="New York" />
          </body></html>
        """)
        # Rubric guessed name "search" (no such field) but the value should still verify.
        self.assertTrue(evaluate_check({"type": "input_value", "name": "search", "value": "New York"}, state))
        # Wrong value still fails even with the fallback.
        self.assertFalse(evaluate_check({"type": "input_value", "name": "search", "value": "Chicago"}, state))

    def test_text_includes_matches_action_label_variants_via_synonyms(self):
        # "add to cart" check should pass on a page that only shows "Add to bag".
        from eval_tool.subgoal_progress import PageState, evaluate_check
        state = PageState("https://shop.test/p/1", "<html><body><button>Add to bag</button></body></html>")
        self.assertTrue(evaluate_check({"type": "text_includes", "value": "add to cart"}, state))
        self.assertTrue(evaluate_check({"type": "role_label", "role": "button", "name": "add to cart"}, state))

    def test_completed_subgoals_persist_across_navigation(self):
        from eval_tool.subgoal_progress import score_subgoal_progress
        result = {
            "subgoal_rubric": {"subgoals": [
                {"order": 1, "goal": "alpha", "checks_any": [{"type": "text_includes", "value": "alpha"}]},
                {"order": 2, "goal": "beta", "checks_any": [{"type": "text_includes", "value": "beta"}]},
            ]},
            "steps": [
                {"step": 1, "url": "", "domSnapshotAfter": "<html><body>alpha beta</body></html>"},
                {"step": 2, "url": "https://shop.test/other", "domSnapshotAfter": "<html><body>other page</body></html>"},
            ],
        }
        self.assertTrue(score_subgoal_progress(result))
        self.assertEqual(result["steps"][0]["subgoal_verified"], 2)
        self.assertEqual(result["steps"][1]["subgoal_verified"], 2)
        self.assertEqual(result["steps"][1]["subgoal_progress"], 0.5)

    def test_selected_value_matches_typed_autocomplete_input(self):
        # "Logistics" typed into a jQuery-UI autocomplete <input> (no selected/aria state) must
        # verify a selected_value check; a checkbox whose value text coincides must NOT.
        from eval_tool.subgoal_progress import PageState, evaluate_check
        state = PageState("https://jobs.test/search", """
          <html><body>
            <input type="text" id="jobTitle" value="Logistics" class="ui-autocomplete-input" />
            <input type="checkbox" id="agree" value="Logistics terms" />
          </body></html>
        """)
        self.assertTrue(evaluate_check({"type": "selected_value", "value": "Logistics"}, state))
        self.assertTrue(evaluate_check({"type": "select_value", "value": "Logistics"}, state))
        self.assertFalse(evaluate_check({"type": "selected_value", "value": "terms"}, state))

    def test_default_selected_value_on_page_load_is_not_credited(self):
        # A native <select> defaulting to "20 miles" on arrival is a page default, not progress.
        from eval_tool.subgoal_progress import score_subgoal_progress
        radius = ('<select id="radius"><option value="">Radius</option>'
                  '<option value="20" selected>20 miles</option></select>')
        result = {
            "subgoal_rubric": {"subgoals": [
                {"order": 1, "goal": "distance 20 miles", "checks_any": [{"type": "selected_value", "value": "20 miles"}]},
            ]},
            "steps": [
                {"step": 1, "url": "https://jobs.test/search?rad=20", "domSnapshotAfter": f"<html><body>{radius}</body></html>"},
                {"step": 2, "url": "https://jobs.test/search?rad=30", "domSnapshotAfter": f"<html><body>{radius}</body></html>"},
            ],
        }
        self.assertTrue(score_subgoal_progress(result))
        self.assertEqual(result["steps"][0]["subgoal_verified"], 0)
        self.assertEqual(result["steps"][0]["subgoal_direct_verified_indices"], [])
        self.assertEqual(result["steps"][1]["subgoal_verified"], 0)

    def test_selection_set_after_page_load_is_credited(self):
        # Same control, but unset on arrival and chosen later → counts (not a default).
        from eval_tool.subgoal_progress import score_subgoal_progress
        empty = ('<select id="radius"><option value="" selected>Radius</option>'
                 '<option value="20">20 miles</option></select>')
        chosen = ('<select id="radius"><option value="">Radius</option>'
                  '<option value="20" selected>20 miles</option></select>')
        result = {
            "subgoal_rubric": {"subgoals": [
                {"order": 1, "goal": "distance 20 miles", "checks_any": [{"type": "selected_value", "value": "20 miles"}]},
            ]},
            "steps": [
                {"step": 1, "url": "https://jobs.test/search", "domSnapshotAfter": f"<html><body>{empty}</body></html>"},
                {"step": 2, "url": "https://jobs.test/search", "domSnapshotAfter": f"<html><body>{chosen}</body></html>"},
            ],
        }
        self.assertTrue(score_subgoal_progress(result))
        self.assertEqual(result["steps"][0]["subgoal_verified"], 0)
        self.assertEqual(result["steps"][1]["subgoal_verified"], 1)
        self.assertEqual(result["steps"][1]["subgoal_progress"], 1.0)

    def test_no_rubric_is_noop(self):
        from eval_tool.subgoal_progress import score_subgoal_progress
        self.assertFalse(score_subgoal_progress({"steps": [{"step": 1}]}))

    def test_predict_subgoal_rubric_parses_json(self):
        from eval_tool.step_confidence import SpecProgressClient
        client = SpecProgressClient(api_key="test")
        payload = {"choices": [{"message": {"content":
            '{"subgoals":[{"order":1,"goal":"g","checks_any":[{"type":"url_includes","value":"x"}]}]}'}}]}
        with patch.object(client, "_post", return_value=payload):
            rubric = client.predict_subgoal_rubric({"task": "do a thing", "website_url": "https://x.test"})
        self.assertEqual(len(rubric["subgoals"]), 1)
        self.assertEqual(rubric["subgoals"][0]["checks_any"][0]["type"], "url_includes")

    def test_predict_subgoal_rubric_keeps_legacy_checks(self):
        from eval_tool.step_confidence import SpecProgressClient
        client = SpecProgressClient(api_key="test")
        payload = {"choices": [{"message": {"content":
            '{"subgoals":[{"order":1,"goal":"g","checks":[{"type":"url_includes","value":"x"}]}]}'}}]}
        with patch.object(client, "_post", return_value=payload):
            rubric = client.predict_subgoal_rubric({"task": "do a thing", "website_url": "https://x.test"})
        self.assertEqual(rubric["subgoals"][0]["checks"][0]["type"], "url_includes")

    def test_backfill_generates_rubric_then_scores(self):
        from eval_tool.step_confidence import SpecProgressClient
        from eval_tool.subgoal_progress import backfill_subgoal_progress
        client = SpecProgressClient(api_key="test")
        payload = {"choices": [{"message": {"content":
            '{"subgoals":[{"order":1,"goal":"alpha","checks_any":[{"type":"text_includes","value":"alpha"}]}]}'}}]}
        result = {"task": {"task": "find alpha"}, "steps": [
            {"step": 1, "url": "", "domSnapshotAfter": "<html><body>nope</body></html>"},
            {"step": 2, "url": "", "domSnapshotAfter": "<html><body>alpha here</body></html>"},
        ]}
        with patch.object(client, "_post", return_value=payload):
            self.assertTrue(backfill_subgoal_progress(result, client))
        self.assertEqual(len(result["subgoal_rubric"]["subgoals"]), 1)
        self.assertEqual(result["steps"][0]["subgoal_progress"], 0.5)  # 0 verified, same as prev(0), new state
        self.assertEqual(result["steps"][1]["subgoal_progress"], 1.0)  # verified increased


class NewModelOptionsTest(unittest.TestCase):
    def test_new_model_ids_are_selectable(self):
        from eval_tool.judge import MODEL_OPTIONS, normalize_model
        ids = {opt["id"] for opt in MODEL_OPTIONS}
        for mid in ("google/gemini-2.5-flash", "qwen/qwen3.6-flash", "qwen/qwen3.7-plus", "openai/gpt-4.1-nano"):
            self.assertIn(mid, ids)
            # Valid ids pass the allow-list unchanged (no fallback to default).
            self.assertEqual(normalize_model(mid), mid)


class GoalRelevanceBackfillTest(unittest.TestCase):
    def test_backfill_g_progress_sets_goal_and_cosine_scores(self):
        from eval_tool.step_confidence import SpecProgressClient
        client = SpecProgressClient(api_key="test")
        result = {
            "task": {"task": "buy a shirt", "website_url": "https://shop.test"},
            "steps": [
                {"step": 1, "action": "click", "target": {"llmIndex": 3}, "instruction": "open product"},
                {"step": 2, "action": "click", "target": {"llmIndex": 5}, "instruction": "add to cart"},
            ],
        }
        # goal embedding == step-2 embedding (cosine 1.0); step-1 orthogonal (cosine 0.0).
        with patch.object(client, "predict_goal", return_value="cart shows the shirt"), \
             patch.object(client, "embed", return_value=[[1.0, 0.0], [0.0, 1.0], [1.0, 0.0]]):
            self.assertTrue(backfill_g_progress(result, client))
        self.assertEqual(result["spec_goal_text"], "cart shows the shirt")
        self.assertAlmostEqual(result["steps"][0]["g_goal_relevance_score"], 0.0)
        self.assertAlmostEqual(result["steps"][1]["g_goal_relevance_score"], 1.0)

    def test_backfill_g_progress_noop_without_client(self):
        from eval_tool.step_confidence import SpecProgressClient
        client = SpecProgressClient(api_key="test")
        client.api_key = None  # force unavailable regardless of env/.env
        self.assertFalse(client.available)
        self.assertFalse(backfill_g_progress({"task": {}, "steps": []}, client))


class ProgressSelfReportJudgeTest(unittest.TestCase):
    def _step(self):
        return {"step": 1, "action": "click", "instruction": "search New York", "target": {"text": "Search"}}

    def test_gt_variant_unavailable_without_reference_steps(self):
        judge = LlmJudge(api_key="test")
        out = judge.judge_progress_self_report({"task": "g"}, self._step(), use_ground_truth=True)
        self.assertFalse(out["available"])
        self.assertIsNone(out["score"])

    def test_scores_snap_to_discrete_minus_one_zero_one(self):
        judge = LlmJudge(api_key="test")
        task_gt = {"task": "g", "reference_steps": "1. search\n2. filter"}
        cases = {2.0: 1, 0.6: 1, 0.2: 1, 0.0: 0, -0.01: -1, -0.4: -1, -0.8: -1, -3.0: -1}
        for raw, expected in cases.items():
            with patch.object(judge, "_call_openai", return_value=f'{{"score": {raw}, "reason": "r"}}'):
                out = judge.judge_progress_self_report(task_gt, self._step(), use_ground_truth=True)
            self.assertTrue(out["available"])
            self.assertEqual(out["score"], expected, f"{raw} should snap to {expected}")

    def test_no_gt_variant_works_without_reference(self):
        judge = LlmJudge(api_key="test")
        with patch.object(judge, "_call_openai", return_value='{"score": 0, "reason": "no change"}'):
            out = judge.judge_progress_self_report({"task": "g"}, self._step(), use_ground_truth=False)
        self.assertTrue(out["available"])
        self.assertEqual(out["score"], 0)
        self.assertEqual(out["reason"], "no change")
        self.assertIn("No reference is provided", out["prompt"])
        self.assertEqual(out["raw_response"], '{"score": 0, "reason": "no change"}')

    def test_no_gt_prompt_includes_previous_observed_steps(self):
        judge = LlmJudge(api_key="test")
        previous = {"step": 1, "action": "click", "instruction": "Click Search", "target": {"text": "Search"}}
        current = {"step": 2, "action": "click", "instruction": "Click Search again", "target": {"text": "Search"}}
        with patch.object(judge, "_call_openai", return_value='{"score": -1, "reason": "repeat"}'):
            out = judge.judge_progress_self_report({"task": "g"}, current, [previous, current], use_ground_truth=False)
        self.assertEqual(out["score"], -1)
        self.assertIn("Previously observed steps:", out["prompt"])
        self.assertIn("Click Search", out["prompt"])

    def test_rerun_self_report_stores_prompt_and_raw_response(self):
        from eval_server.app import rerun_trajectory_progress_self_report

        trajectory = {
            "task": {"task": "g"},
            "steps": [
                {"step": 1, "action": "click", "instruction": "Click Search", "target": {"text": "Search"}},
            ],
        }
        with patch("eval_server.app.LlmJudge") as judge_cls:
            judge = judge_cls.return_value
            judge.api_key = "test"
            judge.judge_progress_self_report.return_value = {
                "score": -1,
                "reason": "regression",
                "prompt": "PROMPT TEXT",
                "raw_response": '{"score": -1, "reason": "regression"}',
            }
            summary = rerun_trajectory_progress_self_report(trajectory, which="nogt", model="m")
        self.assertTrue(summary["updated"])
        self.assertEqual(trajectory["steps"][0]["self_progress_no_gt"], -1)
        self.assertEqual(trajectory["steps"][0]["self_progress_no_gt_prompt"], "PROMPT TEXT")
        self.assertIn('"score": -1', trajectory["steps"][0]["self_progress_no_gt_raw_response"])
        self.assertEqual(summary["details"][0]["score"], -1)

    def test_rerun_gt_self_report_stores_prompt_and_raw_response(self):
        from eval_server.app import rerun_trajectory_progress_self_report

        trajectory = {
            "task": {"task": "g", "reference_steps": "1. Search"},
            "steps": [
                {"step": 1, "action": "click", "instruction": "Click Search", "target": {"text": "Search"}},
            ],
        }
        with patch("eval_server.app.LlmJudge") as judge_cls:
            judge = judge_cls.return_value
            judge.api_key = "test"
            judge.judge_progress_self_report.return_value = {
                "score": 1,
                "reason": "matches reference",
                "prompt": "GT PROMPT TEXT",
                "raw_response": '{"score": 1, "reason": "matches reference"}',
            }
            summary = rerun_trajectory_progress_self_report(trajectory, which="gt", model="m")
        self.assertTrue(summary["updated"])
        self.assertEqual(trajectory["steps"][0]["self_progress_gt"], 1)
        self.assertEqual(trajectory["steps"][0]["self_progress_gt_prompt"], "GT PROMPT TEXT")
        self.assertIn('"score": 1', trajectory["steps"][0]["self_progress_gt_raw_response"])
        self.assertEqual(summary["details"][0]["variant"], "GT")
        self.assertEqual(summary["details"][0]["prompt"], "GT PROMPT TEXT")


class LoadDomSnapshotTest(unittest.TestCase):
    """DOM snapshots are externalized to files by the runner to keep task JSON small;
    load_dom_snapshot resolves inline (older runs) or file-referenced (newer runs) DOM."""

    def test_prefers_inline_after_then_before(self):
        from eval_tool.storage import load_dom_snapshot
        step = {"domSnapshot": "<before>", "domSnapshotAfter": "<after>"}
        self.assertEqual(load_dom_snapshot(step, prefer_after=True), "<after>")
        self.assertEqual(load_dom_snapshot(step, prefer_after=False), "<before>")

    def test_falls_back_to_before_when_after_missing(self):
        from eval_tool.storage import load_dom_snapshot
        self.assertEqual(load_dom_snapshot({"domSnapshot": "<before>"}, prefer_after=True), "<before>")

    def test_reads_externalized_file_by_relative_path(self):
        from eval_tool import storage
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            rel = "runs/r1/screenshots/t1/step-2-domSnapshotAfter.html"
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("<html>after</html>", encoding="utf-8")
            with patch.object(storage, "REPO_ROOT", root):
                step = {"domSnapshotAfterPath": rel}
                self.assertEqual(storage.load_dom_snapshot(step, prefer_after=True), "<html>after</html>")

    def test_inline_wins_over_path(self):
        from eval_tool.storage import load_dom_snapshot
        step = {"domSnapshotAfter": "<inline>", "domSnapshotAfterPath": "does/not/exist.html"}
        self.assertEqual(load_dom_snapshot(step, prefer_after=True), "<inline>")

    def test_missing_returns_empty_string(self):
        from eval_tool.storage import load_dom_snapshot
        self.assertEqual(load_dom_snapshot({"url": "x"}, prefer_after=True), "")

    def test_unreadable_path_returns_empty_string(self):
        from eval_tool.storage import load_dom_snapshot
        self.assertEqual(load_dom_snapshot({"domSnapshotPath": "no/such/file.html"}), "")

    def test_composite_run_resolves_results_from_sources_in_order(self):
        from eval_tool import storage

        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp) / "runs"
            with patch.object(storage, "RUNS_DIR", runs_dir):
                storage.save_run({"run_id": "run-a", "created_at": "1", "status": "completed", "task_ids": ["t1"]})
                storage.save_task_result("run-a", "t1", {"task_id": "t1", "status": "completed"})
                storage.save_run({"run_id": "run-b", "created_at": "2", "status": "completed", "task_ids": ["t1", "t2"]})
                storage.save_task_result("run-b", "t1", {"task_id": "t1", "status": "completed", "marker": "later"})
                storage.save_task_result("run-b", "t2", {"task_id": "t2", "status": "completed"})
                storage.save_run({
                    "run_id": "run-composite",
                    "created_at": "3",
                    "status": "composite",
                    "task_ids": ["t1", "t2", "t3"],
                    "composite_task_ids": ["t1", "t2", "t3"],
                    "composite_sources": ["run-a", "run-b"],
                })

                results = storage.list_task_results_resolved("run-composite")
                self.assertEqual([r["task_id"] for r in results], ["t1", "t2"])
                self.assertEqual(results[0]["resolved_run_id"], "run-a")
                self.assertNotIn("marker", results[0])
                self.assertEqual(storage.load_task_result_resolved("run-composite", "t2")["resolved_run_id"], "run-b")

    def test_normalize_input_mode(self):
        self.assertEqual(normalize_input_mode("dom"), "dom")
        self.assertEqual(normalize_input_mode("DOM+Screenshot"), "dom_screenshot")
        self.assertEqual(normalize_input_mode("vision"), "dom_screenshot")

    def test_subgoal_page_state_resolves_externalized_dom(self):
        from eval_tool import subgoal_progress
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            rel = "runs/r1/screenshots/t1/step-1-domSnapshotAfter.html"
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("<html><body>state marker</body></html>", encoding="utf-8")
            with patch("eval_tool.storage.REPO_ROOT", root):
                state = subgoal_progress._step_page_state({"url": "http://x", "domSnapshotAfterPath": rel})
        self.assertEqual(state.url, "http://x")
        self.assertIn("state marker", state.visible_text)


class AnnotatedUrlFixerTest(unittest.TestCase):
    def _sample(self):
        return [
            {"index": 0, "task": "T0", "key_nodes": [
                {"content": {"url": "https://example.com/"}},
            ], "subgoals": ["visit"]},
            {"index": 1, "task": "Compare AeroAPI plans", "key_nodes": [
                {"content": {"url": "https://www.flightaware.com/"}},
                {"content": {"url": "https://www.flightaware.com/commercial/aeroapi/"}},
                {"content": {"url": "https://www.flightaware.com/commercial/aeroapi/#compare-plans-section"}},
            ], "subgoals": ["a", "b", "c"]},
            {"index": 2, "task": "blank url task", "key_nodes": [
                {"content": {"url": None}},
                {"content": {}},
            ], "subgoals": []},
        ]

    def test_iter_reference_urls_yields_index_step_url(self):
        from eval_tool.annotated_urls import iter_reference_urls
        rows = list(iter_reference_urls(self._sample()))
        self.assertEqual(rows[0], (0, 1, "https://example.com/"))
        self.assertEqual(rows[3], (1, 3, "https://www.flightaware.com/commercial/aeroapi/#compare-plans-section"))
        self.assertEqual(rows[-1], (2, 2, None))

    def test_check_url_flags_blank_without_network(self):
        from eval_tool.annotated_urls import check_url
        self.assertEqual(check_url("")[0], False)
        self.assertEqual(check_url(None)[0], False)
        self.assertEqual(check_url("   ")[2], "blank url")

    def test_scan_structural_flags_only_blank_urls(self):
        from eval_tool.annotated_urls import scan
        flagged = scan(self._sample(), live=False)
        keys = {(f["index"], f["step"]) for f in flagged}
        self.assertEqual(keys, {(2, 1), (2, 2)})
        self.assertTrue(all(f["detail"] == "blank url" for f in flagged))

    def test_update_url_sets_reference_and_reports_missing(self):
        from eval_tool.annotated_urls import update_url
        records = self._sample()
        self.assertTrue(update_url(records, 1, 3, "https://www.flightaware.com/commercial/aeroapi/#compare-tiers"))
        self.assertEqual(
            records[1]["key_nodes"][2]["content"]["url"],
            "https://www.flightaware.com/commercial/aeroapi/#compare-tiers",
        )
        # Fills a missing content dict rather than crashing.
        self.assertTrue(update_url(records, 2, 2, "https://new.example/"))
        self.assertEqual(records[2]["key_nodes"][1]["content"]["url"], "https://new.example/")
        self.assertFalse(update_url(records, 99, 1, "https://x/"))
        self.assertFalse(update_url(records, 0, 5, "https://x/"))

    def test_save_dataset_writes_backup_once(self):
        from eval_tool.annotated_urls import load_dataset, save_dataset, update_url
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AnnotatedDataset.json"
            path.write_text(json.dumps(self._sample()), encoding="utf-8")
            records = load_dataset(path)
            update_url(records, 1, 3, "https://updated/")
            save_dataset(records, path)
            backup = path.with_name(path.name + ".bak")
            self.assertTrue(backup.exists())
            self.assertEqual(json.loads(path.read_text())[1]["key_nodes"][2]["content"]["url"], "https://updated/")
            # A second save keeps the original backup (does not overwrite it).
            original_backup = backup.read_text()
            update_url(records, 1, 3, "https://updated-again/")
            save_dataset(records, path)
            self.assertEqual(backup.read_text(), original_backup)

    def test_dashboard_app_lists_blank_urls_and_saves_updates(self):
        from scripts.annotated_url_fixer import build_app
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AnnotatedDataset.json"
            path.write_text(json.dumps(self._sample()), encoding="utf-8")
            app = build_app(path, live=False)
            client = app.test_client()
            page = client.get("/")
            self.assertEqual(page.status_code, 200)
            self.assertIn(b"row-2-1", page.data)
            self.assertIn(b"saveManual", page.data)
            resp = client.post("/update", json={"index": 1, "step": 3, "url": "https://www.flightaware.com/commercial/aeroapi/#compare-tiers"})
            self.assertEqual(resp.status_code, 200)
            self.assertTrue(resp.get_json()["ok"])
            saved = json.loads(path.read_text())
            self.assertEqual(saved[1]["key_nodes"][2]["content"]["url"], "https://www.flightaware.com/commercial/aeroapi/#compare-tiers")
            missing = client.post("/update", json={"index": 99, "step": 1, "url": "https://x/"})
            self.assertEqual(missing.status_code, 404)

    def test_anchor_present_matches_id_and_name_targets(self):
        from eval_tool.annotated_urls import anchor_present
        html = '<section id="compare-tiers"></section><a name="foo"></a><div id=bar></div>'
        self.assertTrue(anchor_present(html, "compare-tiers"))
        self.assertTrue(anchor_present(html, "foo"))
        self.assertTrue(anchor_present(html, "bar"))
        self.assertFalse(anchor_present(html, "compare-plans-section"))
        # No fragment to verify -> always considered present.
        self.assertTrue(anchor_present(html, ""))
        # Must be an exact target, not a substring of another id.
        self.assertFalse(anchor_present('<div id="compare-tiers-extra"></div>', "compare-tiers"))

    def test_extract_anchors_and_suggestion_ranking(self):
        from eval_tool.annotated_urls import extract_anchors, suggest_anchors
        html = ('<div id="compare-tiers"></div><section id="comparison-section"></section>'
                '<a name="toggle-answer-section"></a><div id=hero></div>')
        anchors = extract_anchors(html)
        self.assertIn("compare-tiers", anchors)
        self.assertIn("comparison-section", anchors)
        self.assertIn("hero", anchors)
        # Distinctive token "compare" should beat the generic "section" overlap.
        ranked = suggest_anchors("compare-plans-section", anchors)
        self.assertEqual(ranked[0], "compare-tiers")
        # Unrelated anchors are not suggested.
        self.assertNotIn("hero", ranked)

    def test_scan_attaches_fix_suggestions_for_missing_anchor(self):
        import eval_tool.annotated_urls as au

        class _Resp:
            def __init__(self, body): self._body = body
            def getcode(self): return 200
            def read(self, n=-1): return self._body
            def __enter__(self): return self
            def __exit__(self, *a): return False

        records = [{"index": 7, "task": "Compare plans", "subgoals": ["a"], "key_nodes": [
            {"content": {"url": "https://x/aeroapi/#compare-plans-section"}},
        ]}]
        page = b'<div id="compare-tiers"></div><div id="comparison-section"></div>'
        with patch.object(au, "urlopen", return_value=_Resp(page)):
            flagged = au.scan(records, live=True, timeout=5, verify_anchor=True)
        self.assertEqual(len(flagged), 1)
        row = flagged[0]
        self.assertIn("not found on page", row["detail"])
        self.assertEqual(row["suggested_url"], "https://x/aeroapi/#compare-tiers")
        self.assertTrue(row["suggestions"])

    def test_check_url_flags_missing_section_anchor(self):
        from unittest.mock import MagicMock
        import eval_tool.annotated_urls as au

        class _Resp:
            def __init__(self, body):
                self._body = body
            def getcode(self):
                return 200
            def read(self, n=-1):
                return self._body
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False

        page = b'<html><body><section id="compare-tiers">Tiers</section></body></html>'
        with patch.object(au, "urlopen", return_value=_Resp(page)):
            # Fragment present on the page -> OK.
            ok, status, detail = au.check_url("https://x/aeroapi/#compare-tiers", verify_anchor=True)
            self.assertTrue(ok)
            self.assertEqual(status, 200)
            # Outdated fragment missing from the page -> flagged despite HTTP 200.
            ok2, status2, detail2 = au.check_url("https://x/aeroapi/#compare-plans-section", verify_anchor=True)
            self.assertFalse(ok2)
            self.assertIn("compare-plans-section", detail2)
            # Without verify_anchor the same URL is treated as reachable.
            ok3, _, _ = au.check_url("https://x/aeroapi/#compare-plans-section", verify_anchor=False)
            self.assertTrue(ok3)

    def test_check_url_treats_read_timeout_as_inconclusive_not_dead(self):
        import socket
        import eval_tool.annotated_urls as au

        with patch.object(au, "urlopen", side_effect=socket.timeout("The read operation timed out")):
            ok, status, detail = au.check_url("https://slow.example/page", timeout=1)

        self.assertTrue(ok)
        self.assertIsNone(status)
        self.assertIn("inconclusive", detail)

    def test_browse_rows_expose_steps_and_blank_counts(self):
        from eval_tool.annotated_urls import browse_rows, blank_url_count
        rows = browse_rows(self._sample())
        self.assertEqual(len(rows), 3)
        flight = next(r for r in rows if r["index"] == 1)
        self.assertEqual(len(flight["steps"]), 3)
        self.assertEqual(flight["steps"][2]["step"], 3)
        self.assertEqual(flight["steps"][2]["subgoal"], "c")
        self.assertFalse(flight["steps"][2]["blank"])
        blank_task = next(r for r in rows if r["index"] == 2)
        self.assertEqual(blank_task["blank_count"], 2)
        self.assertEqual(blank_url_count(self._sample()), 2)

    def test_eval_server_annotated_urls_page_and_update(self):
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AnnotatedDataset.json"
            path.write_text(json.dumps(self._sample()), encoding="utf-8")
            with patch("eval_server.app.ANNOTATED_DATASET_PATH", path), \
                 patch("eval_tool.annotated_urls.DATASET_PATH", path):
                client = server_app.test_client()
                page = client.get("/annotated-urls")
                self.assertEqual(page.status_code, 200)
                self.assertIn(b"Reference URL Fixer", page.data)
                self.assertIn(b"step-1-3", page.data)
                self.assertIn(b"Compare AeroAPI plans", page.data)
                resp = client.post("/api/annotated-urls/update",
                                   json={"index": 1, "step": 3, "url": "https://www.flightaware.com/commercial/aeroapi/#compare-tiers"})
                self.assertEqual(resp.status_code, 200)
                self.assertTrue(resp.get_json()["ok"])
                saved = json.loads(path.read_text())
                self.assertEqual(saved[1]["key_nodes"][2]["content"]["url"],
                                 "https://www.flightaware.com/commercial/aeroapi/#compare-tiers")
                missing = client.post("/api/annotated-urls/update", json={"index": 99, "step": 1, "url": "https://x/"})
                self.assertEqual(missing.status_code, 404)

    def test_eval_server_annotated_urls_check_one_resolves_step_and_suggests(self):
        import eval_server.app as server_module
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)

        class _Resp:
            def __init__(self, body): self._body = body
            def getcode(self): return 200
            def read(self, n=-1): return self._body
            def __enter__(self): return self
            def __exit__(self, *a): return False

        page = b'<div id="compare-tiers"></div>'
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "AnnotatedDataset.json"
            path.write_text(json.dumps(self._sample()), encoding="utf-8")
            with patch("eval_tool.annotated_urls.DATASET_PATH", path), \
                 patch("eval_tool.annotated_urls.urlopen", return_value=_Resp(page)):
                client = server_app.test_client()
                # Resolves the URL from (index, step) and deep-checks its anchor.
                resp = client.post("/api/annotated-urls/check-one", json={"index": 1, "step": 3})
                self.assertEqual(resp.status_code, 200)
                data = resp.get_json()
                self.assertFalse(data["ok"])
                self.assertIn("compare-plans-section", data["detail"])
                self.assertEqual(data["suggested_url"], "https://www.flightaware.com/commercial/aeroapi/#compare-tiers")


class ResolveTrajectoryPathTest(unittest.TestCase):
    def test_session_id_prefix_match_mismatch_and_miss(self):
        import eval_server.app as server_module
        with TemporaryDirectory() as tmp:
            match = Path(tmp) / "m.json"
            match.write_text('{"task_id": "t", "session_id": "s1", "steps": []}', encoding="utf-8")
            self.assertIs(server_module._session_id_in_file_prefix(match, "s1"), True)
            self.assertIs(server_module._session_id_in_file_prefix(match, "other"), False)
            # Session id past the prefix window -> None (caller falls back to a full parse).
            self.assertIsNone(server_module._session_id_in_file_prefix(match, "s1", chunk=8))

    def test_resolve_trajectory_uses_run_id_and_prefix_without_full_parse(self):
        import eval_server.app as server_module
        with TemporaryDirectory() as tmp:
            runs = Path(tmp) / "runs"
            (runs / "run-x" / "tasks").mkdir(parents=True)
            (runs / "run-y" / "tasks").mkdir(parents=True)
            # Prefix has the session id, but the JSON is intentionally truncated/invalid:
            # a match must be found via the prefix read, never a full json.load.
            (runs / "run-x" / "tasks" / "t1.json").write_text(
                '{\n  "task_id": "t1",\n  "session_id": "sess-x",\n  "steps": [ {broken', encoding="utf-8")
            (runs / "run-y" / "tasks" / "t2.json").write_text(
                '{"task_id": "t2", "session_id": "sess-y", "steps": []}', encoding="utf-8")
            with patch.object(server_module, "RUNS_DIR", str(runs)), \
                 patch.object(server_module, "SAVED_DIR", str(Path(tmp) / "saved")):
                # Fast path: the known run id resolves directly.
                path, run_id = server_module._resolve_trajectory_path("sess-x", run_id="run-x")
                self.assertEqual(run_id, "run-x")
                self.assertTrue(path.endswith("run-x/tasks/t1.json"))
                # A wrong run id does not return another run's file from that dir...
                path2, run_id2 = server_module._resolve_trajectory_path("sess-x", run_id="run-y")
                # ...but the global fallback still finds it in run-x.
                self.assertEqual(run_id2, "run-x")
                self.assertTrue(path2.endswith("run-x/tasks/t1.json"))
                # No run id given -> scans all runs via prefix read.
                path3, run_id3 = server_module._resolve_trajectory_path("sess-y")
                self.assertEqual(run_id3, "run-y")

    def test_resolve_trajectory_full_parse_fallback_when_prefix_misses(self):
        import eval_server.app as server_module
        with TemporaryDirectory() as tmp:
            runs = Path(tmp) / "runs"
            (runs / "run-z" / "tasks").mkdir(parents=True)
            # Valid JSON, but the session id sits past the 256 KB prefix window, so the prefix
            # read returns None and the resolver must fall back to a full parse.
            filler = "x" * 300000
            (runs / "run-z" / "tasks" / "big.json").write_text(
                json.dumps({"filler": filler, "session_id": "deep"}), encoding="utf-8")
            with patch.object(server_module, "RUNS_DIR", str(runs)), \
                 patch.object(server_module, "SAVED_DIR", str(Path(tmp) / "saved")):
                path, run_id = server_module._resolve_trajectory_path("deep", run_id="run-z")
                self.assertEqual(run_id, "run-z")
                self.assertTrue(path.endswith("run-z/tasks/big.json"))


class RunVariationAnalysisTest(unittest.TestCase):
    def test_variation_flags_and_combo_label(self):
        import eval_server.app as server_module

        baseline = server_module.run_variation_flags({})
        self.assertEqual(baseline, {
            "grounding_injected": False,
            "loop_injected": False,
            "force_ground_truth": False,
            "force_ground_truth_retries": 0,
            "planning": False,
            "oracle_plan": False,
        })
        self.assertEqual(
            server_module.run_variation_combo_label(baseline),
            server_module.VARIATION_BASELINE_LABEL,
        )

        run = {
            "inject_grounding_warning": True,
            "inject_looping_warning": True,
            "force_ground_truth_mode": True,
            "force_ground_truth_retries": 2,
            "automatic_planning_mode": True,
            "include_oracle_plan": True,
        }
        flags = server_module.run_variation_flags(run)
        self.assertEqual(
            server_module.run_variation_combo_label(flags),
            "Grounding Injected + Loop Injected + Force Ground Truth (2 retries) "
            "+ Planning + Oracle Plan",
        )

        # Planning on its own is its own variation combo.
        planning_only = server_module.run_variation_flags({"automatic_planning_mode": True})
        self.assertEqual(
            server_module.run_variation_combo_label(planning_only), "Planning")

    def test_force_ground_truth_retries_fine_grain_combos(self):
        import eval_server.app as server_module

        # Retry count is only tracked when force-GT mode is on, and it fine-grains the combo:
        # 0 retries and 1 retry are DIFFERENT variations (0/1 -> retry vs retries wording).
        f0 = server_module.run_variation_flags(
            {"force_ground_truth_mode": True, "force_ground_truth_retries": 0})
        f1 = server_module.run_variation_flags(
            {"force_ground_truth_mode": True, "force_ground_truth_retries": 1})
        self.assertEqual(f0["force_ground_truth_retries"], 0)
        self.assertEqual(f1["force_ground_truth_retries"], 1)
        self.assertEqual(
            server_module.run_variation_combo_label(f0), "Force Ground Truth (0 retries)")
        self.assertEqual(
            server_module.run_variation_combo_label(f1), "Force Ground Truth (1 retry)")
        # Retries are ignored when force-GT is off.
        off = server_module.run_variation_flags({"force_ground_truth_retries": 3})
        self.assertEqual(off["force_ground_truth_retries"], 0)

    def test_default_excluded_run_dropped_until_reselected(self):
        import eval_server.app as server_module
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        excluded = next(iter(server_module.VARIATION_DEFAULT_EXCLUDED_RUN_IDS))
        runs = [
            {"run_id": "run-keep", "task_set": "annotated",
             "task_model": "google/gemini-2.5-flash-lite", "inject_looping_warning": True},
            {"run_id": excluded, "task_set": "annotated",
             "task_model": "google/gemini-2.5-flash-lite", "inject_looping_warning": True},
        ]
        summary = {"run_id": "x", "total_tasks": 10, "passed_tasks": 5, "failed_tasks": 5,
                   "fail_rate": 0.5, "groups": {k: {
                       "misgrounded_steps": 0, "loop_steps": 0, "total_steps": 0,
                       "misgrounded_task_rate_mean": 0.0, "misgrounded_task_rate_std": 0.0,
                       "loop_task_rate_mean": 0.0, "loop_task_rate_std": 0.0,
                       "tasks_with_mid_misgrounding": 0, "tasks_with_mid_loop": 0,
                   } for k in ("all", "success", "failed")},
                   "difficulty": {lvl: {"total": 0, "passed": 0, "failed": 0}
                                  for lvl in ("easy", "medium", "hard")}}

        with patch.object(server_module, "list_auto_runs", return_value=runs), \
             patch.object(server_module, "run_variation_task_step_summary", return_value=summary):
            # Default load: the excluded run is a listed (unchecked) candidate but is NOT in the
            # summary, so the Loop Injected combo aggregates only run-keep (1 run / 10 tasks).
            default_body = server_app.test_client().get("/run-variation-analysis").data.decode()
            # Explicitly re-selecting it brings it back (2 runs / 20 tasks).
            reselected_body = server_app.test_client().get(
                f"/run-variation-analysis?selection=1&run_ids=run-keep&run_ids={excluded}").data.decode()

        self.assertIn(excluded, default_body)     # still a candidate checkbox
        self.assertIn("Loop Injected", default_body)  # combo present (from run-keep)
        # The excluded run's checkbox is rendered UNCHECKED by default...
        self.assertRegex(
            default_body, rf'value="{excluded}"(?![^>]*checked)')
        # ...and CHECKED once re-selected.
        self.assertRegex(
            reselected_body, rf'value="{excluded}"[^>]*checked')

        def loop_runs_count(body):
            # The "Loop Injected" comparison row: label cell then the numeric Runs cell.
            m = re.search(r'Loop Injected</span>\s*</td>\s*<td[^>]*>(\d+)</td>', body)
            return int(m.group(1)) if m else None

        self.assertEqual(loop_runs_count(default_body), 1)     # only run-keep by default
        self.assertEqual(loop_runs_count(reselected_body), 2)  # both after reselect

    def _write_task(self, tasks_dir, name, success, steps):
        (tasks_dir / f"{name}.json").write_text(json.dumps({
            "task_id": name,
            "task": {"task": name},
            "judge": {"success": success},
            "steps": steps,
        }), encoding="utf-8")

    def test_run_variation_task_step_summary_counts(self):
        import eval_server.app as server_module

        # Loop scores are recomputed by backfill_computed_loop (L_t_u = prior matching
        # action count / 10), so the fixture uses six identical click-on-"foo" actions.
        # Non-initial indices 0..5; interior = 1..4. L_t_u hits >=0.3 at index 3 (0.3) and 4
        # (0.4). Index 3 is also misgrounded (0.5 < 0.8) -> both mid flags fire on this task.
        def click_foo(sim):
            return {"action": "click", "target": {"text": "foo"},
                    "element_step_similarity": sim}
        failing_steps = [{"isInitial": True}] + [
            click_foo(0.9), click_foo(0.9), click_foo(0.9),
            click_foo(0.5), click_foo(0.9), click_foo(0.9),
        ]
        # Distinct targets -> no loops; both grounded -> no misgrounding.
        passing_steps = [
            {"isInitial": True},
            {"action": "click", "target": {"text": "alpha"}, "element_step_similarity": 0.9},
            {"action": "type", "target": {"text": "beta"}, "element_step_similarity": 0.95},
        ]
        with TemporaryDirectory() as tmp:
            tasks_dir = Path(tmp) / "run-v" / "tasks"
            tasks_dir.mkdir(parents=True)
            self._write_task(tasks_dir, "t-fail", False, failing_steps)
            self._write_task(tasks_dir, "t-pass", True, passing_steps)
            with patch.object(server_module, "RUNS_DIR", str(tmp)):
                summary = server_module.run_variation_task_step_summary("run-v", threshold=0.8)

        self.assertEqual(summary["total_tasks"], 2)
        self.assertEqual(summary["passed_tasks"], 1)
        self.assertEqual(summary["failed_tasks"], 1)
        self.assertAlmostEqual(summary["fail_rate"], 0.5)
        # Scored (non-initial) steps: 6 (fail) + 2 (pass) = 8.
        self.assertEqual(summary["groups"]["all"]["total_steps"], 8)
        # One misgrounded step (the 0.5 similarity). Looping steps (L_t_u > 0) are the
        # failing task's 2nd..6th identical actions = 5.
        self.assertEqual(summary["groups"]["all"]["misgrounded_steps"], 1)
        self.assertEqual(summary["groups"]["all"]["loop_steps"], 5)
        # Mid (interior) flags land on the failed task only.
        self.assertEqual(summary["groups"]["failed"]["tasks_with_mid_misgrounding"], 1)
        self.assertEqual(summary["groups"]["failed"]["tasks_with_mid_loop"], 1)
        self.assertEqual(summary["groups"]["success"]["tasks_with_mid_misgrounding"], 0)

    def test_run_variation_summary_difficulty_breakdown(self):
        import eval_server.app as server_module
        from eval_tool.tasks import tasks_by_id
        from eval_tool.mind2web_levels import effective_task_difficulty

        task_map = tasks_by_id("annotated")
        # Real annotated tasks: annotated-0/2 are easy (≤5 subgoals),
        # annotated-6/7 are medium (6–12 subgoals). Passed/failed mix per level.
        picks = {"annotated-0": True, "annotated-2": False,
                 "annotated-6": True, "annotated-7": False}
        steps = [{"isInitial": True},
                 {"action": "click", "target": {"text": "a"}, "element_step_similarity": 0.9}]
        with TemporaryDirectory() as tmp:
            tasks_dir = Path(tmp) / "run-d" / "tasks"
            tasks_dir.mkdir(parents=True)
            for tid, ok in picks.items():
                self._write_task(tasks_dir, tid, ok, steps)
            with patch.object(server_module, "RUNS_DIR", str(tmp)):
                summary = server_module.run_variation_task_step_summary("run-d", threshold=0.8)

        # Expected difficulty tally derived from the same helper the code uses.
        expected = {lvl: {"passed": 0, "failed": 0, "total": 0}
                    for lvl in ("easy", "medium", "hard")}
        for tid, ok in picks.items():
            lvl = effective_task_difficulty(task_map[tid])
            expected[lvl]["total"] += 1
            expected[lvl]["passed" if ok else "failed"] += 1
        self.assertEqual(summary["difficulty"], expected)
        # Per-level passed reconciles with the run's overall passed count.
        d = summary["difficulty"]
        self.assertEqual(d["easy"]["passed"] + d["medium"]["passed"] + d["hard"]["passed"],
                         summary["passed_tasks"])

    def test_run_variation_analysis_route_filters_and_diffs(self):
        import eval_server.app as server_module
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        runs = [
            {"run_id": "run-base", "task_set": "annotated",
             "task_model": "google/gemini-2.5-flash-lite"},
            {"run_id": "run-loop", "task_set": "annotated",
             "task_model": "google/gemini-2.5-flash-lite", "inject_looping_warning": True},
            # Wrong model -> filtered out by the default gemini-2.5-flash-lite filter.
            {"run_id": "run-other", "task_set": "annotated", "task_model": "openai/gpt-4o"},
        ]

        def fake_summary(run_id, threshold=0.8):
            passed = {"run-base": 30, "run-loop": 20}.get(run_id, 0)
            failed = {"run-base": 10, "run-loop": 20}.get(run_id, 0)
            groups = {k: {
                "misgrounded_steps": 0, "loop_steps": 0, "total_steps": 0,
                "misgrounded_task_rate_mean": 0.0, "misgrounded_task_rate_std": 0.0,
                "loop_task_rate_mean": 0.0, "loop_task_rate_std": 0.0,
                "tasks_with_mid_misgrounding": 0, "tasks_with_mid_loop": 0,
            } for k in ("all", "success", "failed")}
            difficulty = {lvl: {"total": 0, "passed": 0, "failed": 0}
                          for lvl in ("easy", "medium", "hard")}
            return {"run_id": run_id, "total_tasks": passed + failed,
                    "passed_tasks": passed, "failed_tasks": failed,
                    "fail_rate": failed / (passed + failed), "groups": groups,
                    "difficulty": difficulty}

        with patch.object(server_module, "list_auto_runs", return_value=runs), \
             patch.object(server_module, "run_variation_task_step_summary", side_effect=fake_summary):
            response = server_app.test_client().get("/run-variation-analysis")

        self.assertEqual(response.status_code, 200)
        body = response.data
        self.assertIn(b"run-base", body)
        self.assertIn(b"run-loop", body)
        # Other-model run is excluded by the default model filter.
        self.assertNotIn(b"run-other", body)
        # Loop-injected combo vs baseline: -10 passed, +10 failed.
        self.assertIn(b"-10", body)
        self.assertIn(b"+10", body)
        # Both variation combos are present by default (no manual selection).
        self.assertIn(b"Loop Injected", body)

    def test_run_variation_analysis_manual_run_selection(self):
        import eval_server.app as server_module
        from eval_server.app import app as server_app

        server_app.config.update(TESTING=True)
        runs = [
            {"run_id": "run-base", "task_set": "annotated",
             "task_model": "google/gemini-2.5-flash-lite"},
            {"run_id": "run-loop", "task_set": "annotated",
             "task_model": "google/gemini-2.5-flash-lite", "inject_looping_warning": True},
        ]
        summary = {"run_id": "x", "total_tasks": 10, "passed_tasks": 5, "failed_tasks": 5,
                   "fail_rate": 0.5, "groups": {k: {
                       "misgrounded_steps": 0, "loop_steps": 0, "total_steps": 0,
                       "misgrounded_task_rate_mean": 0.0, "misgrounded_task_rate_std": 0.0,
                       "loop_task_rate_mean": 0.0, "loop_task_rate_std": 0.0,
                       "tasks_with_mid_misgrounding": 0, "tasks_with_mid_loop": 0,
                   } for k in ("all", "success", "failed")},
                   "difficulty": {lvl: {"total": 0, "passed": 0, "failed": 0}
                                  for lvl in ("easy", "medium", "hard")}}

        with patch.object(server_module, "list_auto_runs", return_value=runs), \
             patch.object(server_module, "run_variation_task_step_summary", return_value=summary):
            # Manually include ONLY run-base (selection applied). run-loop is deselected, so its
            # Loop-injected combo must not appear in the comparison, though it still shows in the
            # inclusion checklist as an unchecked candidate.
            response = server_app.test_client().get(
                "/run-variation-analysis?selection=1&run_ids=run-base")

        self.assertEqual(response.status_code, 200)
        body = response.data
        self.assertIn(b"run-loop", body)          # still listed as a candidate checkbox
        self.assertNotIn(b"Loop Injected", body)  # but excluded from the comparison table


class RunTaskExplorerTest(unittest.TestCase):
    def test_step_uncertainty_formula(self):
        import eval_server.app as server_module
        # U_t = clip(1 - grounding * (1 - 0.5 * loop), 0, 1)
        self.assertIsNone(server_module._step_uncertainty(None, 0.0))
        self.assertAlmostEqual(server_module._step_uncertainty(0.8, 0.0), 0.2)
        self.assertAlmostEqual(server_module._step_uncertainty(1.0, 1.0), 0.5)
        # Reference example: G=0.84, Loop=0.2 -> 1 - 0.84*(1 - 0.5*0.2) = 0.244.
        self.assertAlmostEqual(server_module._step_uncertainty(0.84, 0.2), 0.244)
        # Perfect grounding, no loop -> zero uncertainty; clipped to [0, 1].
        self.assertAlmostEqual(server_module._step_uncertainty(1.0, 0.0), 0.0)

    def test_artifact_url(self):
        import eval_server.app as server_module
        self.assertIsNone(server_module._artifact_url(""))
        self.assertEqual(
            server_module._artifact_url("eval_tool/runs/r/screenshots/t/step-1.jpg"),
            "/artifacts/eval_tool/runs/r/screenshots/t/step-1.jpg")

    def _write_task(self, tasks_dir, name, task_obj, success, steps):
        (tasks_dir / f"{name}.json").write_text(json.dumps({
            "task_id": name, "task": task_obj, "judge": {"success": success}, "steps": steps,
        }), encoding="utf-8")

    def test_run_task_list_sorted_with_outcomes(self):
        import eval_server.app as server_module
        with TemporaryDirectory() as tmp:
            tasks_dir = Path(tmp) / "run-x" / "tasks"
            tasks_dir.mkdir(parents=True)
            self._write_task(tasks_dir, "annotated-10", {"task": "Ten"}, False, [])
            self._write_task(tasks_dir, "annotated-2", {"task": "Two"}, True, [])
            with patch.object(server_module, "RUNS_DIR", str(tmp)):
                tasks = server_module.run_task_list("run-x")
        # Sorted numerically (2 before 10), with names and outcomes.
        self.assertEqual([t["task_id"] for t in tasks], ["annotated-2", "annotated-10"])
        self.assertEqual(tasks[0]["name"], "Two")
        self.assertEqual(tasks[0]["outcome"], "success")
        self.assertEqual(tasks[1]["outcome"], "failed")

    def test_cached_file_summary_namespace_isolation(self):
        import eval_server.app as server_module
        calls = {"a": 0, "b": 0}
        with TemporaryDirectory() as tmp:
            fp = Path(tmp) / "f.json"
            fp.write_text("{}", encoding="utf-8")
            cache = {}

            def build_a(path):
                calls["a"] += 1
                return {"kind": "a"}

            def build_b(path):
                calls["b"] += 1
                return {"kind": "b"}

            # Same file, two namespaces -> two independent entries, each built once.
            self.assertEqual(server_module._cached_file_summary(cache, str(fp), build_a, namespace="A")["kind"], "a")
            self.assertEqual(server_module._cached_file_summary(cache, str(fp), build_b, namespace="B")["kind"], "b")
            # Cache hits: builders not called again, summaries stay distinct (no key collision).
            self.assertEqual(server_module._cached_file_summary(cache, str(fp), build_a, namespace="A")["kind"], "a")
            self.assertEqual(server_module._cached_file_summary(cache, str(fp), build_b, namespace="B")["kind"], "b")
            self.assertEqual(calls, {"a": 1, "b": 1})
            abspath = os.path.abspath(str(fp))
            self.assertIn(f"{abspath}::A", cache)
            self.assertIn(f"{abspath}::B", cache)
            self.assertNotIn(abspath, cache)  # bare key stays free for default (dashboard) callers

    def test_run_task_list_cache_reuses_summary(self):
        import eval_server.app as server_module
        with TemporaryDirectory() as tmp:
            tasks_dir = Path(tmp) / "run-x" / "tasks"
            tasks_dir.mkdir(parents=True)
            self._write_task(tasks_dir, "annotated-1", {"task": "One"}, True, [])
            cache = {}
            calls = {"n": 0}
            real_builder = server_module._explorer_task_summary

            def counting_builder(path):
                calls["n"] += 1
                return real_builder(path)

            with patch.object(server_module, "RUNS_DIR", str(tmp)), \
                 patch.object(server_module, "_explorer_task_summary", counting_builder):
                first = server_module.run_task_list("run-x", cache)
                second = server_module.run_task_list("run-x", cache)
        self.assertEqual(first, second)
        self.assertEqual(first[0]["task_id"], "annotated-1")
        # The large task file is parsed once; the second load is a pure cache hit.
        self.assertEqual(calls["n"], 1)
        self.assertTrue(any(k.endswith("::explorer_task") for k in cache))

    def test_run_task_detail_payload(self):
        import eval_server.app as server_module
        task_obj = {
            "task": "Do the thing", "website_url": "https://ex.com",
            "reference_steps": "Visit site.\nSearch zip.",
            "annotated_subgoals": ["Visit", "Search"],
            "annotated_reference_urls": ["https://ex.com/", "https://ex.com/x"],
        }
        steps = [
            {"isInitial": True, "url": "https://ex.com"},
            {"action": "type", "instruction": "zip", "url": "https://ex.com",
             "element_step_similarity": 0.8, "computed_loop_updated": 0.0,
             "screenshotBefore": "eval_tool/runs/run-x/screenshots/t/step-1-b.jpg",
             "targetRect": {"left": 10, "top": 20, "width": 30, "height": 40}},
        ]
        with TemporaryDirectory() as tmp:
            tasks_dir = Path(tmp) / "run-x" / "tasks"
            tasks_dir.mkdir(parents=True)
            self._write_task(tasks_dir, "annotated-0", task_obj, False, steps)
            with patch.object(server_module, "RUNS_DIR", str(tmp)):
                payload = server_module.run_task_detail_payload("run-x", "annotated-0")

        self.assertEqual(payload["outcome"], "failed")
        self.assertEqual(payload["website_url"], "https://ex.com")
        self.assertEqual(len(payload["steps"]), 1)  # initial step dropped
        step = payload["steps"][0]
        self.assertAlmostEqual(step["grounding"], 0.8)
        self.assertAlmostEqual(step["uncertainty"], 0.2)
        self.assertEqual(step["screenshot_before"],
                         "/artifacts/eval_tool/runs/run-x/screenshots/t/step-1-b.jpg")
        self.assertEqual(step["target_rect"], {"left": 10, "top": 20, "width": 30, "height": 40})
        self.assertEqual(payload["oracle"]["reference_steps"], ["Visit site.", "Search zip."])
        self.assertEqual(payload["oracle"]["subgoals"], ["Visit", "Search"])
        self.assertEqual(len(payload["oracle"]["reference_urls"]), 2)
        # URL-subgoal verification is attached (2 reference URLs -> 2 nodes).
        self.assertEqual(payload["subgoals_url"]["total"], 2)

    def test_explorer_route_lists_tasks_per_run(self):
        import eval_server.app as server_module
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        runs = [{"run_id": "run-a", "task_set": "annotated",
                 "task_model": "google/gemini-2.5-flash-lite"}]
        tasks = [
            {"task_id": "annotated-0", "name": "Alpha task", "outcome": "success"},
            {"task_id": "annotated-1", "name": "Beta task", "outcome": "failed"},
        ]
        with patch.object(server_module, "list_auto_runs", return_value=runs), \
             patch.object(server_module, "run_task_list", return_value=tasks):
            body = server_app.test_client().get("/run-task-explorer").data
        self.assertIn(b"run-a", body)
        self.assertIn(b"Alpha task", body)
        self.assertIn(b"Beta task", body)
        self.assertIn(b'count-pass">1 ', body)  # passed count pill shows 1 pass
        self.assertIn(b'count-fail">1 ', body)  # failed count pill shows 1 fail

    def test_normalize_match_url(self):
        import eval_server.app as m
        # Lowercase host, strip trailing slash, keep query, drop default port.
        self.assertEqual(m._normalize_match_url("https://WWW.Example.com/Path/"),
                         "https://www.example.com/Path")
        self.assertEqual(m._normalize_match_url("https://example.com:443/a?x=1"),
                         "https://example.com/a?x=1")
        self.assertEqual(m._normalize_match_url(""), "")

    def test_subgoal_url_completion(self):
        import eval_server.app as server_module
        task = {
            "annotated_subgoals": ["Visit GameStop", "Set store 2630"],
            "annotated_reference_urls": [
                "https://www.gamestop.com/",
                "https://www.gamestop.com/search/?store=2630",
            ],
            "annotated_match_functions": ["url_included_match", "url_exactly_match"],
            "annotated_key_nodes": [
                {"content": {"url": "https://www.gamestop.com/", "reference_answer": "gamestop."},
                 "match_function_name": "url_included_match"},
                {"content": {"url": "https://www.gamestop.com/search/?store=2630", "reference_answer": "2630"},
                 "match_function_name": "url_exactly_match"},
            ],
        }
        # Agent visited the homepage but never the exact store URL: node1 matched, node2 not.
        steps = [{"url": "https://www.gamestop.com/"},
                 {"url": "https://www.gamestop.com/search/?q=ps5"}]
        r = server_module.subgoal_url_completion(task, steps)
        self.assertEqual(r["total"], 2)
        self.assertEqual(r["completed"], 1)
        self.assertTrue(r["nodes"][0]["matched"])   # included: "gamestop." in homepage URL
        self.assertFalse(r["nodes"][1]["matched"])  # exact store URL not visited
        self.assertAlmostEqual(r["rate"], 0.5)
        self.assertEqual(r["nodes"][0]["label"], "Visit GameStop")

        # Reaching the exact store URL (different host case + trailing slash) completes node2.
        steps2 = steps + [{"url": "https://WWW.gamestop.com/search/?store=2630"}]
        r2 = server_module.subgoal_url_completion(task, steps2)
        self.assertEqual(r2["completed"], 2)
        self.assertAlmostEqual(r2["rate"], 1.0)

        # No oracle nodes -> zero total, rate None (not an error).
        empty = server_module.subgoal_url_completion({}, steps)
        self.assertEqual(empty["total"], 0)
        self.assertIsNone(empty["rate"])

    def test_build_run_outcome_matrix(self):
        import eval_server.app as server_module
        run_sections = [
            {"run_id": "run-a", "combo_label": "Baseline", "tasks": [
                {"task_id": "annotated-0", "name": "T0", "outcome": "success"},
                {"task_id": "annotated-1", "name": "T1", "outcome": "failed"},
                {"task_id": "annotated-2", "name": "T2", "outcome": "failed"},
                {"task_id": "annotated-3", "name": "T3", "outcome": "pending"},
            ]},
            {"run_id": "run-b", "combo_label": "Loop", "tasks": [
                {"task_id": "annotated-0", "name": "T0", "outcome": "success"},  # agree pass
                {"task_id": "annotated-1", "name": "T1", "outcome": "success"},  # mixed (fail->pass)
                {"task_id": "annotated-2", "name": "T2", "outcome": "failed"},   # agree fail
                {"task_id": "annotated-3", "name": "T3", "outcome": "pending"},  # other (no scored)
            ]},
        ]
        m = server_module.build_run_outcome_matrix(run_sections)
        self.assertEqual(m["run_ids"], ["run-a", "run-b"])
        # Rows sorted numerically by task number.
        self.assertEqual([r["task_id"] for r in m["rows"]],
                         ["annotated-0", "annotated-1", "annotated-2", "annotated-3"])
        by_id = {r["task_id"]: r for r in m["rows"]}
        self.assertEqual(by_id["annotated-0"]["cls"], "agree_pass")
        self.assertEqual(by_id["annotated-1"]["cls"], "mixed")
        self.assertEqual(by_id["annotated-2"]["cls"], "agree_fail")
        self.assertEqual(by_id["annotated-3"]["cls"], "other")
        self.assertEqual(m["counts"], {"agree_pass": 1, "agree_fail": 1, "mixed": 1, "other": 1})
        # Comparable = tasks scored in >=2 runs (annotated-3 excluded); 2 of 3 agree.
        self.assertEqual(m["comparable"], 3)
        self.assertAlmostEqual(m["agreement_rate"], 2 / 3)
        # Cells align to run order.
        self.assertEqual(by_id["annotated-1"]["cells"], ["failed", "success"])

    def test_task_detail_api_json_and_errors(self):
        import eval_server.app as server_module
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        payload = {"run_id": "run-a", "task_id": "annotated-0", "name": "X",
                   "outcome": "success", "steps": [], "oracle": {}}
        with patch.object(server_module, "run_task_detail_payload", return_value=payload):
            ok = server_app.test_client().get(
                "/api/run-task-detail?run_id=run-a&task_id=annotated-0")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.get_json()["name"], "X")
        # Missing params -> 400.
        self.assertEqual(server_app.test_client().get("/api/run-task-detail").status_code, 400)
        # Not found -> 404.
        with patch.object(server_module, "run_task_detail_payload", return_value=None):
            missing = server_app.test_client().get(
                "/api/run-task-detail?run_id=run-a&task_id=nope")
        self.assertEqual(missing.status_code, 404)


class RunStaleTaskDetectionTest(unittest.TestCase):
    def test_stored_task_text_handles_dict_string_and_none(self):
        from eval_server.app import _stored_task_text
        self.assertEqual(_stored_task_text({"task": {"task": "  do X "}}), "do X")
        self.assertEqual(_stored_task_text({"task": {"name": "do Y"}}), "do Y")
        self.assertEqual(_stored_task_text({"task": "do Z"}), "do Z")
        self.assertEqual(_stored_task_text({"task": None}), "")
        self.assertEqual(_stored_task_text(None), "")

    def test_flags_only_genuinely_new_task_ignoring_reindex_shift(self):
        # Dataset swap inserted "flightaware" at index 61, shifting carmax 61->62.
        # The run still holds carmax under the old id 61 (stale) and nfl under 62.
        # Only annotated-61 (flightaware) has no result anywhere and must be flagged;
        # annotated-62 (carmax) already has a result under annotated-61 -> NOT flagged.
        import eval_server.app as sapp
        dataset = {
            "annotated-61": SimpleNamespace(task="flightaware"),
            "annotated-62": SimpleNamespace(task="carmax"),
            "annotated-63": SimpleNamespace(task="nfl"),
        }
        stored = {
            "annotated-61": {"task_id": "annotated-61", "task": {"name": "carmax"}},
            "annotated-62": {"task_id": "annotated-62", "task": {"name": "nfl"}},
            "annotated-63": {"task_id": "annotated-63", "task": {"name": "amtrak"}},
        }
        run = {"run_id": "run-x", "task_set": "annotated",
               "task_ids": ["annotated-61", "annotated-62", "annotated-63"]}
        with patch("eval_server.app.tasks_by_id", return_value=dataset), \
             patch("eval_server.app.load_task_result", side_effect=lambda rid, tid: stored.get(tid)):
            out = sapp._run_stale_or_missing_tasks(run)
        self.assertEqual([(o["task_id"], o["reason"]) for o in out], [("annotated-61", "stale")])
        self.assertEqual(out[0]["current_name"], "flightaware")

    def test_flags_missing_result_file(self):
        import eval_server.app as sapp
        dataset = {"annotated-61": SimpleNamespace(task="flightaware"),
                   "annotated-62": SimpleNamespace(task="carmax")}
        stored = {"annotated-62": {"task_id": "annotated-62", "task": {"name": "carmax"}}}
        run = {"run_id": "run-x", "task_set": "annotated",
               "task_ids": ["annotated-61", "annotated-62"]}
        with patch("eval_server.app.tasks_by_id", return_value=dataset), \
             patch("eval_server.app.load_task_result", side_effect=lambda rid, tid: stored.get(tid)):
            out = sapp._run_stale_or_missing_tasks(run)
        self.assertEqual([(o["task_id"], o["reason"]) for o in out], [("annotated-61", "missing")])

    def test_composite_run_reports_nothing(self):
        import eval_server.app as sapp
        run = {"run_id": "c", "composite_sources": ["a", "b"], "task_ids": ["annotated-61"]}
        self.assertEqual(sapp._run_stale_or_missing_tasks(run), [])

    def test_run_missing_task_route_rejects_unknown_task(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        run = {"run_id": "run-x", "task_set": "annotated", "task_ids": ["annotated-61"]}
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.tasks_by_id", return_value={}):
            resp = server_app.test_client().post("/runs/run-x/run-task", data={"task_id": "annotated-61"})
        self.assertEqual(resp.status_code, 400)

    def test_run_missing_task_route_starts_single_task(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        run = {"run_id": "run-x", "task_set": "annotated", "task_ids": ["annotated-61"]}
        task = SimpleNamespace(task_id="annotated-61", task="flightaware")
        started = []
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.tasks_by_id", return_value={"annotated-61": task}), \
             patch("eval_server.app.single_task_running", return_value=False), \
             patch("eval_server.app.start_single_task", side_effect=lambda r, t: started.append((r["run_id"], t.task_id))):
            resp = server_app.test_client().post("/runs/run-x/run-task", data={"task_id": "annotated-61"})
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(started, [("run-x", "annotated-61")])


class RunPauseResumeTest(unittest.TestCase):
    def test_pause_run_marks_paused_and_flags(self):
        import eval_tool.runner as R
        try:
            with patch.object(R, "_patch_run", side_effect=lambda rid, **k: {"run_id": rid, **k}):
                out = R.pause_run("rr")
            self.assertEqual(out["status"], "paused")
            self.assertIn("rr", R.PAUSED_RUNS)
            with patch.object(R, "_patch_run", side_effect=lambda rid, **k: {"run_id": rid, **k}):
                stopped = R.stop_run("rr")
            self.assertEqual(stopped["status"], "stopped")
            self.assertNotIn("rr", R.PAUSED_RUNS)
        finally:
            R.PAUSED_RUNS.discard("rr")

    def test_pause_route_pauses_running_run(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        called = []
        with patch("eval_server.app.load_run", return_value={"run_id": "r", "status": "running"}), \
             patch("eval_server.app.is_running", return_value=True), \
             patch("eval_server.app.pause_run", side_effect=lambda rid: called.append(rid)):
            resp = server_app.test_client().post("/runs/r/pause")
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(called, ["r"])

    def test_pause_route_noop_when_not_running(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        called = []
        with patch("eval_server.app.load_run", return_value={"run_id": "r", "status": "completed"}), \
             patch("eval_server.app.is_running", return_value=False), \
             patch("eval_server.app.pause_run", side_effect=lambda rid: called.append(rid)):
            resp = server_app.test_client().post("/runs/r/pause")
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(called, [])

    def test_resume_route_starts_only_remaining_tasks(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        run = {"run_id": "r", "status": "stopped", "task_set": "annotated",
               "task_ids": ["annotated-1", "annotated-2", "annotated-3"]}
        task_map = {tid: SimpleNamespace(task_id=tid) for tid in run["task_ids"]}
        started = []
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.is_running", return_value=False), \
             patch("eval_server.app.tasks_by_id", return_value=task_map), \
             patch("eval_server.app._task_result_files", return_value=["/x/annotated-1.json"]), \
             patch("eval_server.app.start_run", side_effect=lambda r, tasks: started.append([t.task_id for t in tasks])):
            resp = server_app.test_client().post("/runs/r/resume")
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(started, [["annotated-2", "annotated-3"]])

    def test_resume_route_skips_composite_run(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        run = {"run_id": "c", "status": "stopped", "composite_sources": ["a", "b"],
               "task_ids": ["annotated-1"]}
        started = []
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app.is_running", return_value=False), \
             patch("eval_server.app.start_run", side_effect=lambda r, tasks: started.append(tasks)):
            resp = server_app.test_client().post("/runs/c/resume")
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(started, [])


class PromptImageLinkTest(unittest.TestCase):
    def test_externalizes_and_links_llm_images_to_steps(self):
        import base64 as _b64
        import eval_tool.runner as R
        payload = _b64.b64encode(b"fake-jpeg-bytes").decode()
        steps = [{"step": 0, "isInitial": True}, {"step": 1}, {"step": 2}]
        debug_prompts = [
            {"metadata": {"mode": "guide", "step": 1}, "imageBase64": payload},
            {"metadata": {"mode": "guide_warning_retry", "step": 1}, "imageBase64": payload},
            {"metadata": {"mode": "guide", "step": 2}, "imageBase64": None},
        ]
        runner = R.PlaywrightGuideRunner.__new__(R.PlaywrightGuideRunner)
        runner.run_id = "run-x"
        with TemporaryDirectory() as tmp:
            with patch.object(R, "screenshot_dir", lambda rid, tid: Path(tmp) / tid), \
                 patch.object(R, "_rel", lambda p: "REL/" + os.path.basename(str(p))):
                out = runner._externalize_and_link_prompt_images("t1", steps, debug_prompts)
        # step 1 gets both the main call image and the warning-retry image
        self.assertEqual(steps[1]["promptImage"], "REL/debug-0-1-guide.jpg")
        self.assertEqual(steps[1]["warningPromptImage"], "REL/debug-1-1-guide_warning_retry.jpg")
        # inline base64 is dropped and replaced by a path to keep the JSON small
        self.assertIsNone(out[0]["imageBase64"])
        self.assertEqual(out[0]["imageBase64Path"], "REL/debug-0-1-guide.jpg")
        # step 2 had no image -> untouched
        self.assertNotIn("promptImage", steps[2])

    def test_no_debug_prompts_is_noop(self):
        import eval_tool.runner as R
        runner = R.PlaywrightGuideRunner.__new__(R.PlaywrightGuideRunner)
        runner.run_id = "run-x"
        self.assertEqual(runner._externalize_and_link_prompt_images("t1", [{"step": 1}], []), [])
        self.assertIsNone(runner._externalize_and_link_prompt_images("t1", [], None))

    def test_record_prompt_image_wins_no_duplicate_file(self):
        # When the step already carries a promptImage from the reliable rewind record, the
        # redundant debug-prompt base64 is dropped without writing a second file or overriding.
        import base64 as _b64
        import eval_tool.runner as R
        payload = _b64.b64encode(b"fake-jpeg-bytes").decode()
        steps = [{"step": 1, "promptImage": "REL/step-1-promptImage.jpg"}]
        debug_prompts = [{"metadata": {"mode": "guide", "step": 1}, "imageBase64": payload}]
        runner = R.PlaywrightGuideRunner.__new__(R.PlaywrightGuideRunner)
        runner.run_id = "run-x"
        saved = []
        with patch.object(R, "_rel", lambda p: "REL/" + os.path.basename(str(p))), \
             patch.object(runner, "_save_debug_image", side_effect=lambda *a: saved.append(a) or "REL/dup.jpg"):
            out = runner._externalize_and_link_prompt_images("t1", steps, debug_prompts)
        self.assertEqual(saved, [])  # no duplicate file written
        self.assertEqual(steps[0]["promptImage"], "REL/step-1-promptImage.jpg")  # record image kept
        self.assertIsNone(out[0]["imageBase64"])  # inline base64 dropped to shrink JSON


class RunNoTrajectoryTest(unittest.TestCase):
    def test_result_has_trajectory(self):
        import eval_server.app as sapp
        self.assertTrue(sapp._result_has_trajectory(
            {"session_id": "s", "steps": [{"isInitial": True}, {"action": "click"}]}))
        self.assertFalse(sapp._result_has_trajectory(
            {"session_id": "", "steps": [{"action": "click"}]}))          # no session
        self.assertFalse(sapp._result_has_trajectory(
            {"session_id": "s", "steps": [{"isInitial": True}]}))          # only initial step
        self.assertFalse(sapp._result_has_trajectory({"session_id": "s", "steps": []}))
        self.assertFalse(sapp._result_has_trajectory(None))

    def test_flags_no_trajectory_tasks_with_reason(self):
        import eval_server.app as sapp
        run = {"run_id": "run-A"}
        results = [
            {"task_id": "t1", "session_id": "s1", "steps": [{"isInitial": True}, {"action": "click"}]},
            {"task_id": "t2", "session_id": "", "steps": [], "terminal_reason": "NO STEPS RECORDED"},
            {"task_id": "t3", "session_id": "s3", "steps": [{"isInitial": True}]},
        ]
        out = sapp._run_no_trajectory_tasks(run, results)
        self.assertEqual([o["task_id"] for o in out], ["t2", "t3"])
        self.assertEqual(out[0]["reason"], "no session")
        self.assertEqual(out[1]["reason"], "no steps recorded")
        self.assertEqual(out[0]["run_id"], "run-A")  # physical run = the run itself

    def test_no_trajectory_targets_resolved_source_run_for_composite(self):
        import eval_server.app as sapp
        run = {"run_id": "comp"}
        results = [{"task_id": "t2", "session_id": "", "steps": [], "resolved_run_id": "src-1"}]
        out = sapp._run_no_trajectory_tasks(run, results)
        self.assertEqual(out[0]["run_id"], "src-1")

    def test_rerun_all_route_batches_no_trajectory_tasks(self):
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)
        run = {"run_id": "run-A", "task_set": "annotated"}
        results = [
            {"task_id": "t1", "session_id": "s", "steps": [{"isInitial": True}, {"action": "x"}]},
            {"task_id": "t2", "session_id": "", "steps": []},
            {"task_id": "t3", "session_id": "s3", "steps": [{"isInitial": True}]},
        ]
        task_map = {"t2": SimpleNamespace(task_id="t2"), "t3": SimpleNamespace(task_id="t3")}
        batched = []
        with patch("eval_server.app.load_run", return_value=run), \
             patch("eval_server.app._run_results", return_value=results), \
             patch("eval_server.app.tasks_by_id", return_value=task_map), \
             patch("eval_server.app.single_task_running", return_value=False), \
             patch("eval_server.app.start_single_task_batch",
                   side_effect=lambda r, tasks: batched.append((r["run_id"], sorted(t.task_id for t in tasks)))):
            resp = server_app.test_client().post("/runs/run-A/rerun-no-trajectory")
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(batched, [("run-A", ["t2", "t3"])])


class RunOptionsWorkersTest(unittest.TestCase):
    def _workers_for(self, form):
        import eval_server.app as sapp
        from eval_server.app import app as server_app
        with server_app.test_request_context('/runs', method='POST', data=form):
            return sapp._run_options_from_form('annotated')['workers']

    def test_workers_clamped_to_50(self):
        self.assertEqual(self._workers_for({'workers': '99'}), 50)

    def test_workers_within_range_preserved(self):
        self.assertEqual(self._workers_for({'workers': '30'}), 30)

    def test_workers_floor_of_one(self):
        self.assertEqual(self._workers_for({'workers': '0'}), 1)

    def test_workers_defaults_to_10_when_absent(self):
        # Lowered from 20 to reduce provider throttling (empty LLM responses) under concurrency.
        self.assertEqual(self._workers_for({}), 10)


class ClassifyFailureReasonTest(unittest.TestCase):
    """Re-attribution of opaque terminal reasons to bot_block / llm_empty_response."""

    def test_meaningful_reasons_pass_through(self):
        for reason in ("done", "max_steps", "force_ground_truth_verifier_failed", "FAILED TO EXECUTE ACTION"):
            self.assertEqual(classify_failure_reason(reason, final_url="https://x.com"), reason)

    def test_cloudflare_token_in_url_is_bot_block(self):
        self.assertEqual(
            classify_failure_reason("NO STEPS RECORDED", final_url="https://www.discogs.com/?__cf_chl_f_tk=abc"),
            "bot_block",
        )

    def test_http_403_and_429_are_bot_block(self):
        self.assertEqual(classify_failure_reason("idle_timeout", nav_http_status=403), "bot_block")
        self.assertEqual(classify_failure_reason("idle_timeout", nav_http_status=429), "bot_block")

    def test_challenge_phrase_in_prompt_is_bot_block(self):
        prompts = [{"userPrompt": "PAGE INDEX ... Please verify you are a human before continuing."}]
        self.assertEqual(
            classify_failure_reason("idle_timeout", final_url="https://tvguide.com/", debug_prompts=prompts),
            "bot_block",
        )

    def test_normal_captcha_widget_is_not_bot_block(self):
        # A page that merely embeds a recaptcha widget in its normal flow must NOT be flagged.
        prompts = [{"userPrompt": "[12] (button) Sign in  [13] recaptcha checkbox", "responseContent": "{...}"}]
        steps = [{"isInitial": False, "action": "click", "url": "https://site.com/login"}]
        self.assertEqual(
            classify_failure_reason("idle_timeout", steps=steps, debug_prompts=prompts),
            "idle_timeout",
        )

    def test_empty_response_no_step_is_llm_empty_response(self):
        prompts = [{"responseError": "Empty response from OpenRouter", "responseContent": ""}]
        self.assertEqual(classify_failure_reason("NO STEPS RECORDED", debug_prompts=prompts), "llm_empty_response")

    def test_empty_content_no_error_no_step_is_llm_empty_response(self):
        prompts = [{"responseContent": "   "}]
        self.assertEqual(classify_failure_reason("NO STEPS RECORDED", debug_prompts=prompts), "llm_empty_response")

    def test_empty_response_but_steps_committed_stays_opaque(self):
        # A valid step was committed → the empty last prompt isn't why the task ended; don't relabel.
        prompts = [{"responseError": "Empty response from OpenRouter"}]
        steps = [{"isInitial": False, "action": "click", "url": "https://site.com/"}]
        self.assertEqual(classify_failure_reason("idle_timeout", steps=steps, debug_prompts=prompts), "idle_timeout")


class FollowingRateLimitAndCancelTest(unittest.TestCase):
    def _make_run_with_tasks(self, runs_dir, run_id, task_ids):
        tasks_dir = Path(runs_dir) / run_id / "tasks"
        tasks_dir.mkdir(parents=True)
        for tid in task_ids:
            (tasks_dir / f"{tid}.json").write_text(
                json.dumps({"task_id": tid, "task": {"task": tid}}), encoding="utf-8"
            )

    def test_work_items_limit_keeps_first_n_by_task_number(self):
        import eval_server.app as sapp
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp) / "runs"
            runs_dir.mkdir()
            # Deliberately out of order to prove stable task-number ordering.
            self._make_run_with_tasks(
                runs_dir, "run-x",
                ["annotated-10", "annotated-2", "annotated-0", "annotated-1"],
            )
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)):
                one = sapp._following_work_items("run-x", limit=1)
                two = sapp._following_work_items("run-x", limit=2)
                allitems = sapp._following_work_items("run-x")
        self.assertEqual([t[2] for t in one], ["annotated-0"])
        self.assertEqual([t[2] for t in two], ["annotated-0", "annotated-1"])
        self.assertEqual(len(allitems), 4)

    def test_work_items_limit_zero_or_none_returns_all(self):
        import eval_server.app as sapp
        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp) / "runs"
            runs_dir.mkdir()
            self._make_run_with_tasks(runs_dir, "run-y", ["annotated-0", "annotated-1"])
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)):
                self.assertEqual(len(sapp._following_work_items("run-y", limit=0)), 2)
                self.assertEqual(len(sapp._following_work_items("run-y", limit=None)), 2)

    def test_run_endpoint_fast_fails_when_key_missing(self):
        import eval_server.app as sapp
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)

        class _NoKeyJudge:
            def __init__(self, *a, **k):
                self.api_key = ""

        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp) / "runs"
            runs_dir.mkdir()
            self._make_run_with_tasks(runs_dir, "run-z", ["annotated-0"])
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value={"run_id": "run-z", "status": "completed"}), \
                 patch("eval_server.app.is_running", return_value=False), \
                 patch("eval_server.app.LlmJudge", _NoKeyJudge):
                resp = server_app.test_client().post(
                    "/api/llm-following-rates/run",
                    json={"run_id": "run-z", "model": "openai/gpt-4o", "limit": 1},
                )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("OPENROUTER_API_KEY", resp.get_json().get("error", ""))

    def test_cancel_endpoint_sets_stop_events(self):
        import eval_server.app as sapp
        from eval_server.app import app as server_app
        import threading as _threading
        server_app.config.update(TESTING=True)
        ev = _threading.Event()
        sapp._following_rate_stops["job-abc"] = ev
        try:
            resp = server_app.test_client().post(
                "/api/llm-following-rates/cancel", json={"job_id": "job-abc"}
            )
            self.assertEqual(resp.status_code, 200)
            self.assertIn("job-abc", resp.get_json().get("cancelled", []))
            self.assertTrue(ev.is_set())
        finally:
            sapp._following_rate_stops.pop("job-abc", None)

    def test_job_set_stores_job_id_and_does_not_collide(self):
        # Regression: _following_job_set(job_id, job_id=job_id, ...) used to raise
        # "multiple values for argument 'job_id'", so scoring never started.
        import eval_server.app as sapp
        jid = "job-store-test"
        try:
            result = sapp._following_job_set(jid, run_id="run-q", status="queued")
            self.assertEqual(result["job_id"], jid)
            self.assertEqual(result["run_id"], "run-q")
        finally:
            with sapp._following_rate_jobs_lock:
                sapp._following_rate_jobs.pop(jid, None)

    def test_run_endpoint_starts_job_when_key_present(self):
        # Regression: the run endpoint must actually create a queued job (no TypeError).
        import eval_server.app as sapp
        from eval_server.app import app as server_app
        server_app.config.update(TESTING=True)

        class _KeyJudge:
            def __init__(self, *a, **k):
                self.api_key = "sk-test"

        started = {}

        def _fake_thread_target(job_id, run_id, model, limit=None, temperature=None):
            started.update(job_id=job_id, run_id=run_id, limit=limit, temperature=temperature)

        with TemporaryDirectory() as tmp:
            runs_dir = Path(tmp) / "runs"
            runs_dir.mkdir()
            self._make_run_with_tasks(runs_dir, "run-k", ["annotated-0", "annotated-1"])
            with patch("eval_server.app.RUNS_DIR", str(runs_dir)), \
                 patch("eval_server.app.load_run", return_value={"run_id": "run-k", "status": "completed"}), \
                 patch("eval_server.app.is_running", return_value=False), \
                 patch("eval_server.app.LlmJudge", _KeyJudge), \
                 patch("eval_server.app._run_following_rate_job", _fake_thread_target):
                resp = server_app.test_client().post(
                    "/api/llm-following-rates/run",
                    json={"run_id": "run-k", "model": "openai/gpt-4o", "limit": 1},
                )
                body = resp.get_json()
                # Give the daemon thread a moment to invoke the (stubbed) target.
                import time
                for _ in range(50):
                    if started:
                        break
                    time.sleep(0.01)
                jid = body.get("job_id")
                if jid:
                    with sapp._following_rate_jobs_lock:
                        sapp._following_rate_jobs.pop(jid, None)
                    sapp._following_rate_stops.pop(jid, None)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(body.get("status"), "queued")
        self.assertEqual(body.get("total"), 1)  # limit=1 honored
        self.assertEqual(started.get("limit"), 1)

    def test_cancel_endpoint_without_job_id_cancels_all(self):
        import eval_server.app as sapp
        from eval_server.app import app as server_app
        import threading as _threading
        server_app.config.update(TESTING=True)
        ev1, ev2 = _threading.Event(), _threading.Event()
        sapp._following_rate_stops["job-1"] = ev1
        sapp._following_rate_stops["job-2"] = ev2
        try:
            resp = server_app.test_client().post("/api/llm-following-rates/cancel", json={})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.get_json().get("count"), 2)
            self.assertTrue(ev1.is_set() and ev2.is_set())
        finally:
            sapp._following_rate_stops.pop("job-1", None)
            sapp._following_rate_stops.pop("job-2", None)


if __name__ == "__main__":
    unittest.main()
