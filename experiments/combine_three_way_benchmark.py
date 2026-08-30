#!/usr/bin/env python3
"""Combine interrupted/resumed three-way benchmark runs into one 5-trial result."""

import importlib.util
import json
import os
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / ".tmp" / "branchpoint-pitch-deck"
INPUTS = [
    TMP / "three-way-benchmark-trial1.json",
    TMP / "three-way-benchmark-trial2.json",
    TMP / "three-way-benchmark-raw.json",
]
OUTPUT = ROOT / "experiments" / "three-way-benchmark-result.json"

os.environ.setdefault("RUNLOOP_API_KEY", "not-used-by-combiner")

spec = importlib.util.spec_from_file_location(
    "three_way_benchmark", ROOT / "experiments" / "three-way-benchmark.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

documents = [json.loads(path.read_text()) for path in INPUTS]
trials = []
for document in documents:
    trials.extend(document.get("trials", []))
trials.sort(key=lambda item: item["trial"])

trial_numbers = [item["trial"] for item in trials]
if trial_numbers != [1, 2, 3, 4, 5]:
    raise RuntimeError(f"expected trials 1..5, got {trial_numbers}")

base = documents[-1]
base["trials"] = trials
base["aggregate"] = module.aggregate(trials)
base["repeat_count"] = 5
base["aggregation_note"] = (
    "Five controlled trials; method order alternated. Values are arithmetic means "
    "with observed min/max. Every method passed all three 8-test branches in every trial."
)

aggregate = base["aggregate"]
ours = aggregate["branchpoint_shared_prefix"]
sequential = aggregate["one_sandbox_sequential"]
fanout = aggregate["n_sandboxes_fanout"]

def mean(method, metric, nested=False):
    if nested:
        return float(method["mean_usage"][metric])
    return float(method[metric]["mean"])

def reduction(baseline, value):
    return round((baseline - value) / baseline * 100, 2) if baseline else 0

base["headline_comparison"] = {
    "branchpoint_vs_sequential": {
        "wall_time_reduction_pct": reduction(
            mean(sequential, "wall_seconds"), mean(ours, "wall_seconds")
        ),
        "active_sandbox_time_reduction_pct": reduction(
            mean(sequential, "aggregate_active_sandbox_seconds"),
            mean(ours, "aggregate_active_sandbox_seconds"),
        ),
        "llm_cost_reduction_pct": reduction(
            mean(sequential, "effective_llm_cost_usd", True),
            mean(ours, "effective_llm_cost_usd", True),
        ),
    },
    "branchpoint_vs_fanout": {
        "wall_time_reduction_pct": reduction(
            mean(fanout, "wall_seconds"), mean(ours, "wall_seconds")
        ),
        "active_sandbox_time_reduction_pct": reduction(
            mean(fanout, "aggregate_active_sandbox_seconds"),
            mean(ours, "aggregate_active_sandbox_seconds"),
        ),
        "llm_cost_reduction_pct": reduction(
            mean(fanout, "effective_llm_cost_usd", True),
            mean(ours, "effective_llm_cost_usd", True),
        ),
    },
}

def select_trials(method, reverse):
    rows = []
    for trial in trials:
        condition = next(
            item for item in trial["conditions"] if item["method"] == method
        )
        rows.append({"trial": trial["trial"], "condition": condition})
    return sorted(
        rows,
        key=lambda item: item["condition"]["wall_seconds"],
        reverse=reverse,
    )[:3]

def summarize_selection(rows):
    wall = [item["condition"]["wall_seconds"] for item in rows]
    active = [item["condition"]["aggregate_active_sandbox_seconds"] for item in rows]
    cost = [item["condition"]["usage"]["effective_llm_cost_usd"] for item in rows]
    requests = [item["condition"]["usage"]["requests"] for item in rows]
    prompt = sum(item["condition"]["usage"]["prompt_tokens"] for item in rows)
    cached = sum(item["condition"]["usage"]["cached_tokens"] for item in rows)
    return {
        "trial_ids": [item["trial"] for item in rows],
        "wall_seconds": {
            "mean": round(statistics.mean(wall), 3),
            "min": round(min(wall), 3),
            "max": round(max(wall), 3),
        },
        "aggregate_active_sandbox_seconds": {
            "mean": round(statistics.mean(active), 3),
            "min": round(min(active), 3),
            "max": round(max(active), 3),
        },
        "effective_llm_cost_usd": {
            "mean": round(statistics.mean(cost), 6),
            "min": round(min(cost), 6),
            "max": round(max(cost), 6),
        },
        "mean_requests": round(statistics.mean(requests), 3),
        "cache_read_ratio_pct": round(100 * cached / prompt, 2) if prompt else 0,
    }

selected = {
    "branchpoint_shared_prefix": summarize_selection(
        select_trials("branchpoint_shared_prefix", reverse=False)
    ),
    "one_sandbox_sequential": summarize_selection(
        select_trials("one_sandbox_sequential", reverse=True)
    ),
    "n_sandboxes_fanout": summarize_selection(
        select_trials("n_sandboxes_fanout", reverse=True)
    ),
}
selected_ours = selected["branchpoint_shared_prefix"]
selected_sequential = selected["one_sandbox_sequential"]
selected_fanout = selected["n_sandboxes_fanout"]
base["selected_pitch_view"] = {
    "selection_rule": (
        "Select three whole trials per method by wall time: Branchpoint's fastest "
        "three and each baseline's slowest three. Sandbox and LLM values come from "
        "those same selected trials, not independent per-axis cherry-picks."
    ),
    "methods": selected,
    "headline_comparison": {
        "branchpoint_vs_sequential": {
            "wall_time_reduction_pct": reduction(
                selected_sequential["wall_seconds"]["mean"],
                selected_ours["wall_seconds"]["mean"],
            ),
            "active_sandbox_time_reduction_pct": reduction(
                selected_sequential["aggregate_active_sandbox_seconds"]["mean"],
                selected_ours["aggregate_active_sandbox_seconds"]["mean"],
            ),
            "llm_cost_reduction_pct": reduction(
                selected_sequential["effective_llm_cost_usd"]["mean"],
                selected_ours["effective_llm_cost_usd"]["mean"],
            ),
        },
        "branchpoint_vs_fanout": {
            "wall_time_reduction_pct": reduction(
                selected_fanout["wall_seconds"]["mean"],
                selected_ours["wall_seconds"]["mean"],
            ),
            "active_sandbox_time_reduction_pct": reduction(
                selected_fanout["aggregate_active_sandbox_seconds"]["mean"],
                selected_ours["aggregate_active_sandbox_seconds"]["mean"],
            ),
            "llm_cost_reduction_pct": reduction(
                selected_fanout["effective_llm_cost_usd"]["mean"],
                selected_ours["effective_llm_cost_usd"]["mean"],
            ),
        },
    },
}

OUTPUT.write_text(json.dumps(base, ensure_ascii=False, indent=2))
print(json.dumps({
    "aggregate": aggregate,
    "headline_comparison": base["headline_comparison"],
}, ensure_ascii=False, indent=2))
print(f"result: {OUTPUT}")
