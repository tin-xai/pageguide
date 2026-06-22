import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, Mock, patch

from eval_tool.app import build_phase3_rows, create_app, default_tasks, filter_options, missing_step_summary
from eval_tool.credentials import Account
from eval_tool.ece import aggregate_task, compute_ece, ece_payload, is_bot_detection_failure
from eval_tool.judge import DEFAULT_LLM_MODEL, LlmJudge, configured_judge_model, normalize_judge_response
from eval_tool.runner import PlaywrightGuideRunner, _zero_step_explanation, configured_task_model, normalize_max_steps
from eval_tool.scoring import (
    ALL_FORMULAS,
    chart_payload,
    compute_confidence,
    effective_success,
    enrich_step_scores,
    score_step,
)
from eval_tool.step_confidence import (
    backfill_computed_loop,
    compute_loop_score,
    compute_loop_score_updated,
    compute_spec_confidence,
    element_key,
    g_grounding,
)
from eval_tool.tasks import load_tasks


class EvalToolTest(unittest.TestCase):
    def test_compute_confidence_matches_extension_formula(self):
        parts = {"grounded": 0.8, "loop": 0.1, "progress": 0.5}
        self.assertAlmostEqual(compute_confidence(parts, "reduced"), 0.736)
        self.assertAlmostEqual(compute_confidence(parts, "full"), 0.8464)
        self.assertAlmostEqual(compute_confidence(parts, "noloop"), 0.92)

    def test_g_grounding_is_rule_based(self):
        self.assertEqual(g_grounding({"action": "click", "target": {"llmIndex": 7, "text": "Go"}}), 1.0)
        self.assertEqual(g_grounding({"action": "click", "target": {"text": "Go"}}), 0.7)
        self.assertEqual(g_grounding({"action": "click", "target": {}}), 0.0)
        self.assertIsNone(g_grounding({"action": "scroll_down", "target": {"llmIndex": 7}}))
        self.assertIsNone(g_grounding({"action": "done"}))
        self.assertIsNone(g_grounding({"isInitial": True, "target": {"llmIndex": 1}}))

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
        step = {"action": "click", "target": {"text": "Buy"}, "loop": 0.0}  # text grounding 0.7
        self.assertAlmostEqual(compute_spec_confidence(step, "spec_full"), 0.7)
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
        self.assertEqual(compute_loop_score(actions[1], actions[:1]), 0.0)      # 0/1
        self.assertAlmostEqual(compute_loop_score(actions[2], actions[:2]), 0.5)    # 1/2
        self.assertAlmostEqual(compute_loop_score(actions[3], actions[:3]), 2 / 3)  # 2/3

    def test_updated_loop_requires_same_action_type_and_text(self):
        actions = [
            {"action": "click", "target": {"text": "Search"}},
            {"action": "type", "target": {"text": "Search"}},
            {"action": "click", "target": {"text": "Search"}},
        ]
        self.assertEqual(compute_loop_score_updated(actions[1], actions[:1]), 0.0)
        self.assertAlmostEqual(compute_loop_score_updated(actions[2], actions[:2]), 0.5)

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
        self.assertEqual(steps[1]["computed_loop"], 0.0)        # 0/0 -> 0
        self.assertEqual(steps[2]["computed_loop"], 0.0)        # 0/1
        self.assertAlmostEqual(steps[3]["computed_loop"], 0.5)  # 1/2
        self.assertAlmostEqual(steps[4]["computed_loop"], 2 / 3)  # 2/3
        self.assertEqual(steps[1]["action_key_updated"], "click: search")
        self.assertAlmostEqual(steps[3]["computed_loop_updated"], 0.5)
        self.assertAlmostEqual(steps[4]["computed_loop_updated"], 2 / 3)

    def test_backfill_updated_loop_does_not_match_click_and_type_same_text(self):
        steps = [
            {"step": 0, "isInitial": True},
            {"step": 1, "action": "click", "target": {"text": "Search"}},
            {"step": 2, "action": "type", "target": {"text": "Search"}},
            {"step": 3, "action": "click", "target": {"text": "Search"}},
        ]
        backfill_computed_loop({"steps": steps})
        self.assertEqual(steps[2]["computed_loop_updated"], 0.0)
        self.assertAlmostEqual(steps[3]["computed_loop_updated"], 0.5)

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

    def test_compute_ece_zero_when_calibrated_and_nonzero_on_gap(self):
        calibrated = compute_ece([1.0, 1.0, 0.0], [1.0, 1.0, 0.0], n_bins=5)
        self.assertAlmostEqual(calibrated["ece"], 0.0)
        gap = compute_ece([0.9, 0.9], [1.0, 0.0], n_bins=5)
        self.assertAlmostEqual(gap["ece"], 0.4)  # |0.5 - 0.9|
        self.assertEqual(len(gap["bins"]), 5)

    def test_aggregate_task_modes(self):
        steps = [
            {"step": 1, "action": "click", "target": {"llmIndex": 1}, "loop": 0.0, "g_goal_relevance_score": 1.0},  # 1.0
            {"step": 2, "action": "click", "target": {"text": "x"}, "loop": 0.0, "g_goal_relevance_score": 0.0},     # 0.35
            {"step": 0, "isInitial": True},
            {"step": 3, "action": "scroll_down"},  # excluded (no grounding)
        ]
        self.assertAlmostEqual(aggregate_task(steps, "spec_full", "last"), 0.35)
        self.assertAlmostEqual(aggregate_task(steps, "spec_full", "min"), 0.35)
        self.assertAlmostEqual(aggregate_task(steps, "spec_full", "mean"), 0.675)

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

    def test_missing_step_summary_counts_gaps_and_step_two(self):
        results = [
            {"task_id": "gap", "steps": [{"step": 1}, {"step": 3}, {"step": 4}]},
            {"task_id": "clean", "steps": [{"step": 1}, {"step": 2}, {"step": 3}]},
            {"task_id": "zero", "steps": []},
        ]
        summary = missing_step_summary(results)
        self.assertEqual(summary["missing_any_step_tasks"], 1)
        self.assertEqual(summary["missing_step_2_tasks"], 1)
        self.assertEqual(summary["by_task"]["gap"]["missing"], [2])
        self.assertFalse(summary["by_task"]["clean"]["missing_step_2"])
        self.assertFalse(summary["by_task"]["zero"]["missing_step_2"])

    def test_run_dashboard_renders_missing_step_stats_and_badges(self):
        app = create_app()
        app.config.update(TESTING=True)
        run = {"run_id": "test-run", "created_at": "now", "status": "completed", "task_ids": ["t1"]}
        result = {
            "task_id": "t1",
            "task": {"task": "Do thing", "website_url": "https://example.test", "level": "Easy"},
            "terminal_reason": "MAX_STEPS",
            "judge": {"success": False, "failureCategory": "FAILED", "reason": "Not done", "confidence": 0.4},
            "steps": [{"step": 1, "confidence_versions": {}}, {"step": 3, "confidence_versions": {}}],
        }
        with patch("eval_tool.app.load_run", return_value=run), \
             patch("eval_tool.app.list_task_results", return_value=[result]), \
             patch("eval_tool.app.is_running", return_value=False):
            response = app.test_client().get("/runs/test-run")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Missing Any Step", response.data)
        self.assertIn(b"Missing Step 2", response.data)
        self.assertIn(b"Missing steps: 2", response.data)

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

        self.assertEqual(steps, [])
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


if __name__ == "__main__":
    unittest.main()
