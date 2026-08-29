import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).with_name("browser-agent.py")
SPEC = importlib.util.spec_from_file_location("branchpoint_browser_agent", MODULE_PATH)
assert SPEC and SPEC.loader
agent = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = agent
SPEC.loader.exec_module(agent)


class BrowserAgentPureTests(unittest.TestCase):
    def model_config(self, directory):
        root = Path(directory)
        return agent.Config(
            request_path=root / "request.json",
            result_path=root / "result.json",
            app_url="http://127.0.0.1:3000",
            checkpoint_path=root / "checkpoint.json",
            node_timeout_ms=10_000,
            playwright_timeout_ms=1_000,
            model_timeout_seconds=2,
            openrouter_key="test-openrouter-key",
            openrouter_model="test/model",
        )

    def test_lexical_resolver_uses_semantic_hint_after_a_rename(self):
        candidates = [
            {"ref": "a", "role": "button", "name": "Use a starter", "text": ""},
            {"ref": "b", "role": "button", "name": "Blank workspace", "text": ""},
        ]

        selected, confidence, _reason = agent._lexical_resolve(
            candidates,
            "Pick the prepared template",
            "Starter template",
            False,
        )

        self.assertEqual(selected["ref"], "a")
        self.assertGreater(confidence, 0.5)

    def test_lexical_judge_accepts_equivalent_completion_language(self):
        ok, _reason = agent._lexical_judge(
            {
                "title": "All set",
                "visibleText": "Your team workspace is ready",
                "url": "http://127.0.0.1:3000/done",
            },
            "The workspace setup completed successfully",
        )

        self.assertTrue(ok)

    def test_demo_regression_heading_is_detected_as_an_error_screen(self):
        reason = agent._screen_error_reason(
            {
                "title": "Nimbus",
                "alerts": [],
                "visibleText": "Something went off route. Please try again.",
            }
        )

        self.assertIn("something went off route", reason.lower())

    def test_openrouter_request_requires_structured_provider_and_retries_429(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(
                    {
                        "choices": [{"message": {"content": '{"ok":true,"reason":"done"}'}}],
                        "usage": {"cost": 0.0123},
                    }
                ).encode("utf-8")

        with tempfile.TemporaryDirectory() as directory:
            state = agent.RunState(10_000)
            throttled = agent.urllib.error.HTTPError(
                agent.OPENROUTER_URL,
                429,
                "rate limited",
                {"Retry-After": "0"},
                None,
            )
            with patch.object(
                agent.urllib.request,
                "urlopen",
                side_effect=[throttled, Response()],
            ) as urlopen:
                with patch.object(agent.time, "sleep") as sleep:
                    result = agent._openrouter_json(
                        self.model_config(directory),
                        state,
                        system_prompt="system",
                        user_payload={"screen": "data"},
                        schema_name="judge",
                        schema={"type": "object"},
                    )

            request = urlopen.call_args_list[-1].args[0]
            body = json.loads(request.data.decode("utf-8"))
            self.assertEqual(result, {"ok": True, "reason": "done"})
            self.assertEqual(body["provider"], {"require_parameters": True})
            self.assertEqual(body["max_tokens"], 800)
            self.assertEqual(body["reasoning"], {"effort": "minimal", "exclude": True})
            self.assertNotIn("max_completion_tokens", body)
            self.assertEqual(state.cost_usd, 0.0123)
            self.assertEqual(state.model_calls, 1)
            self.assertEqual(urlopen.call_count, 2)
            sleep.assert_called_once()

    def test_configured_model_failure_is_not_hidden_by_lexical_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            observation = {
                "url": "http://127.0.0.1:3000",
                "candidates": [
                    {"ref": "a", "role": "button", "name": "Team plan", "text": ""}
                ],
            }
            with patch.object(
                agent,
                "_openrouter_json",
                side_effect=agent.ModelCallError("HTTP 401"),
            ):
                with self.assertRaises(agent.ModelCallError):
                    agent._resolve_candidate(
                        self.model_config(directory),
                        agent.RunState(10_000),
                        observation,
                        intent="Choose team",
                        expected_outcome=None,
                        hint=None,
                        allow_progress=False,
                    )

    def test_resolver_rejects_boolean_confidence_from_model(self):
        with tempfile.TemporaryDirectory() as directory:
            observation = {
                "url": "http://127.0.0.1:3000",
                "candidates": [
                    {"ref": "a", "role": "button", "name": "Team plan", "text": ""}
                ],
            }
            with patch.object(
                agent,
                "_openrouter_json",
                return_value={"ref": "a", "confidence": True, "reason": "match"},
            ):
                with self.assertRaises(agent.ModelCallError):
                    agent._resolve_candidate(
                        self.model_config(directory),
                        agent.RunState(10_000),
                        observation,
                        intent="Choose team",
                        expected_outcome=None,
                        hint=None,
                        allow_progress=False,
                    )

    def test_partial_openrouter_configuration_is_an_infrastructure_error(self):
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "result.json"
            environment = {
                "BRANCHPOINT_RESULT_PATH": str(result_path),
                "BRANCHPOINT_REQUEST_PATH": str(Path(directory) / "request.json"),
                "BRANCHPOINT_APP_URL": "http://127.0.0.1:3000",
                "OPENROUTER_API_KEY": "configured-without-a-model",
            }

            with patch.dict(os.environ, environment, clear=True):
                exit_code = agent.main()

            receipt = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual(exit_code, 70)
            self.assertEqual(receipt["errorCode"], "configuration")

    def test_checkpoint_includes_indexed_db_for_forked_auth_state(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.model_config(directory)
            context = Mock()
            context.storage_state.return_value = {"cookies": [], "origins": []}
            page = Mock()
            page.is_closed.return_value = False
            page.url = "http://127.0.0.1:3000/onboarding/team"
            page.evaluate.return_value = {
                "origin": "http://127.0.0.1:3000",
                "values": {},
            }

            receipt = agent._save_checkpoint(config, context, page)

            context.storage_state.assert_called_once_with(indexed_db=True)
            self.assertEqual(receipt["path"], str(config.checkpoint_path))

    def test_malformed_request_writes_an_infrastructure_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / "result.json"
            request_path = Path(directory) / "missing-request.json"
            environment = {
                "BRANCHPOINT_RESULT_PATH": str(result_path),
                "BRANCHPOINT_REQUEST_PATH": str(request_path),
                "BRANCHPOINT_APP_URL": "http://127.0.0.1:3000",
            }

            with patch.dict(os.environ, environment, clear=True):
                exit_code = agent.main()

            receipt = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual(exit_code, 70)
            self.assertEqual(receipt["status"], "infra-error")
            self.assertEqual(receipt["errorCode"], "request")

    def test_checkpoint_failure_cannot_commit_a_pass(self):
        state = agent.RunState(10_000)
        page = Mock()
        page.is_closed.return_value = False
        with patch.object(agent, "_take_screenshot", return_value="/tmp/evidence.png"):
            with patch.object(agent, "_save_checkpoint", side_effect=OSError("disk full")):
                with self.assertRaises(agent.CheckpointError):
                    agent._finalize_product_result(
                        object(),
                        state,
                        object(),
                        page,
                        "goal",
                        {"status": "pass"},
                    )

    def test_late_pass_is_committed_as_a_product_timeout_with_artifacts(self):
        state = agent.RunState(1, started_monotonic=time.monotonic() - 1)
        page = Mock()
        page.is_closed.return_value = False
        receipt = {"path": "/tmp/checkpoint.json", "url": "http://127.0.0.1:3000/done"}
        with patch.object(agent, "_take_screenshot", return_value="/tmp/evidence.png"):
            with patch.object(agent, "_save_checkpoint", return_value=receipt):
                result = agent._finalize_product_result(
                    object(),
                    state,
                    object(),
                    page,
                    "goal",
                    {"status": "pass"},
                )

        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["failReason"], "timeout")
        self.assertEqual(result["screenshotId"], "/tmp/evidence.png")
        self.assertEqual(result["checkpoint"], receipt)


if __name__ == "__main__":
    unittest.main()
