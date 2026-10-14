# Report, evidence, and coverage

Read this reference when turning a deployment comparison into executable browser cases or writing the final report.

## Comparison and release note

Use the active package/version inventory for both deployments as the primary comparison. A date-based Git history is supporting context only: deployed packages can differ from what a date-filtered log suggests. Link each release-note item to the package change and the browser cases that demonstrate its user-visible effect. If a change has no browser entry point, describe it as such and keep any CLI/API verification clearly labeled as supplemental; do not claim a browser-tested feature.

## Coverage matrix

Create one row per scenario before execution, with these fields:

| Field | Meaning |
| --- | --- |
| ID / change | Stable case ID and release-note item or regression area |
| Setup | Fixture and account label; identify whether setup used UI or a helper |
| Browser action | Page and user-visible action to perform |
| Expected result | Observable UI state or message |
| Status | `pass`, `fail`, `blocked`, or `skipped` |
| Evidence | Relative paths to screenshots/artifacts and any supplemental logs |
| Notes | Actual result, limitation, and cleanup state |

For each changed UI path, cover the principal success path and a relevant boundary or regression path. Add cross-role visibility where the change affects permissions or results. Do not inflate coverage with helper calls: HTTP/API/CLI are fixture preparation or supplemental checks only. If a browser interface exists, the decisive action and result must be observed in the browser.

## Evidence grades

- **A — direct browser evidence:** captured browser state showing the relevant action and resulting UI. Include a screenshot or browser artifact path for each pass/fail where practical.
- **B — browser observation with supplemental trace:** the UI result is captured, with a supporting network/log/CLI artifact where it clarifies the result.
- **C — indirect evidence:** helper/API/CLI output without the relevant browser action. This can support fixture or non-UI behavior but cannot establish a browser scenario as passed.

State the grade per case. A screenshot of setup alone is not evidence of the tested result. Keep credentials, cookies, session tokens, and other secrets out of all evidence.

## Hydro-specific execution notes

- Keep the local label segment from `testuser.txt` separate from credentials. Use the label only to locate/select the test account; never print or save passwords or session data.
- Treat existing exams as read-only. Run exam mutations in an isolated temporary domain and document the cleanup.
- For classroom assessments, enroll in both the parent course and the assessment. After the assessment opens, enter the problem list so `startAt` is created before testing timed behavior.
- An OI submission may return the contest ID (`tid`) without a record ID (`rid`). For the result record, use the teacher's submission-record list to find the corresponding `rid`; do not infer that `tid` is the record ID.
- Hidden scores before an assessment ends are expected behavior. Do not mark results as missing until the assessment has ended and the intended results view is available.
- Wait for judge work to finish before deleting fixtures. Hydro storage commonly retains data for seven days: distinguish data that remains active from data scheduled for `autoDelete`, and report the observed cleanup state.
- Create temporary login/profile material under a temporary directory and remove it in a `finally` cleanup path, including on failed or interrupted scenarios where control returns to the runner.
- Account locales can differ. Prefer role/field/data attributes to translated button captions; scope forms to the actual feature because pages also contain a hidden login form. Observe a link's new tab when it uses `target="_blank"`.
- Objective problems need their supported answer placeholders and the objective answer controls. A plain `code` form with no selected language is not a valid fixture for that UI flow. Use real problem types and valid testdata for judge scenarios.
- A team mode that has already been enabled is intentionally locked against disabling. Distinguish an immutable control from a failed save.

## Report layout

Save the complete runtime report and evidence beneath `doc/test/.local/<run>/`, grouped by run or deployment pair:

1. **Pair and scope:** deployment identifiers, test date, target environment, package comparison source, and covered changes.
2. **Release note:** user-visible changes, each linked to its package and case IDs; call out non-UI items separately.
3. **Execution summary:** counts for pass/fail/blocked/skipped and any environment limits.
4. **Case matrix:** all fields from the table above, including expected and observed results.
5. **Evidence index:** relative artifact paths and grades, with a brief description of each.
6. **Cleanup:** judge completion, temporary domain/data removal, and active versus `autoDelete` storage state.

For Git handoff, retain a concise report under `doc/test/releases/` or `doc/test/fixes/`: deployment versions/date, coverage counts, failures, limitations, reproduction/fix links and cleanup conclusions. Keep plans and reusable scripts. Promote only a few explanatory images to `doc/test/assets/`; runtime JSON, full matrices, bulk screenshots and logs stay local or in agreed shared artifact storage. A concise handoff report must not link to local-only artifacts as dependencies.

Never imply deployment, publication, or an upgrade occurred because tests were run. Follow the root `AGENTS.md` only if a separately authorized release operation is requested.
