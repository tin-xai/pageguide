import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, Mock, patch

from eval_tool.app import build_phase3_rows, create_app, default_tasks, filter_options
from eval_tool.credentials import Account
from eval_tool.ece import aggregate_task, compute_ece, ece_payload, is_bot_detection_failure
from eval_tool.judge import DEFAULT_LLM_MODEL, LlmJudge, configured_judge_model, normalize_grounding_label, normalize_judge_response
from eval_tool.runner import PlaywrightGuideRunner, _zero_step_explanation, configured_task_model, normalize_max_steps, normalize_region_capture_mode, region_capture_mode_label
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


class EvalToolTest(unittest.TestCase):
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

    def test_compute_confidence_matches_extension_formula(self):
        parts = {"grounded": 0.8, "loop": 0.1, "progress": 0.5}
        self.assertAlmostEqual(compute_confidence(parts, "reduced"), 0.736)
        self.assertAlmostEqual(compute_confidence(parts, "full"), 0.8464)
        self.assertAlmostEqual(compute_confidence(parts, "noloop"), 0.92)

    def test_compute_confidence_three_point_progress_scale(self):
        base = {"grounded": 0.8, "loop": 0.1}  # reduced base = 0.736
        # 1.0 = clear progress -> full boost; 0.5 = neutral; 0.0 = regression floor.
        self.assertAlmostEqual(compute_confidence({**base, "progress": 1.0}, "full"), 0.9568)
        self.assertAlmostEqual(compute_confidence({**base, "progress": 0.5}, "full"), 0.8464)
        self.assertAlmostEqual(compute_confidence({**base, "progress": 0.0}, "full"), 0.736)
        # Legacy -1..1 traces: a negative value clamps up to the 0.0 floor (no penalty).
        self.assertAlmostEqual(compute_confidence({**base, "progress": -1.0}, "full"), 0.736)

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
        self.assertAlmostEqual(summary["max_loop_updated"], 0.5)

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
                {"step": 1, "grounded": 0.8, "loop": 0.0, "progress": 0.0},
                {"step": 2, "grounded": 0.5, "loop": 0.5, "progress": -0.5},
            ]),
        }
        payload = chart_payload([result])
        self.assertEqual(payload["aggregate"][0]["step"], 1)
        self.assertAlmostEqual(payload["aggregate"][0]["full"], 0.8)
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
        self.assertIn(b"Human Label Boundary Check", response.data)
        self.assertIn(b"Pred Grounded", response.data)
        self.assertIn(b"precision", response.data)
        self.assertIn(b"Youden Index", response.data)
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
                },
                {"step": 5, "action": "click", "instruction": "Click missing", "target": {"llmIndex": 6, "text": "Missing"}},
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
        self.assertIn(b"#a16207", response.data)
        self.assertIn(b"Raw cosine similarity: 0.82", response.data)
        self.assertIn(long_element_text.encode(), response.data)
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
            "steps": [
                {"step": 1, "element_step_similarity": 0.9},
                {"step": 2, "element_step_similarity": 0.7},
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


if __name__ == "__main__":
    unittest.main()
