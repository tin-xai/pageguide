import unittest

from eval_server.app import _assign_run_display_names


class GeneratedRunNicknameTest(unittest.TestCase):
    def test_annotated_flash_lite_names_and_numbers_duplicates_oldest_first(self):
        runs = [
            {
                "run_id": "run-later",
                "task_set": "annotated",
                "task_model": "google/gemini-2.5-flash-lite",
                "input_mode": "dom",
                "inject_looping_warning": True,
                "created_at": "2026-01-02T00:00:00Z",
            },
            {
                "run_id": "run-earlier",
                "task_set": "annotated",
                "task_model": "google/gemini-2.5-flash-lite",
                "input_mode": "dom",
                "inject_looping_warning": True,
                "created_at": "2026-01-01T00:00:00Z",
            },
            {
                "run_id": "run-baseline",
                "task_set": "annotated",
                "task_model": "google/gemini-2.5-flash-lite",
                "input_mode": "dom_screenshot",
                "created_at": "2026-01-03T00:00:00Z",
            },
        ]

        _assign_run_display_names(runs)

        self.assertEqual(
            runs[1]["display_name"],
            "Annotated Dataset · Gemini 2.5 Flash Lite · Loop Injected · DOM · 1",
        )
        self.assertEqual(
            runs[0]["display_name"],
            "Annotated Dataset · Gemini 2.5 Flash Lite · Loop Injected · DOM · 2",
        )
        self.assertEqual(
            runs[2]["display_name"],
            "Annotated Dataset · Gemini 2.5 Flash Lite · No condition · DOM + Screenshot",
        )

    def test_manual_nickname_overrides_generated_name(self):
        runs = [{
            "run_id": "run-custom",
            "nickname": "My comparison run",
            "task_set": "annotated",
            "task_model": "gemini-2.5-flash-lite",
        }]

        _assign_run_display_names(runs)

        self.assertEqual(runs[0]["display_name"], "My comparison run")

    def test_other_models_keep_existing_display_behavior(self):
        runs = [{
            "run_id": "run-other",
            "nickname": "Other model",
            "task_set": "annotated",
            "task_model": "gemini-2.5-flash",
        }]

        _assign_run_display_names(runs)

        self.assertEqual(runs[0]["display_name"], "Other model (run-other)")


if __name__ == "__main__":
    unittest.main()
