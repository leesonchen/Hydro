# Hydro Course and Problem Adjustment Validation Report

Date: 2026-06-09

## Scope

- Repository: `/home/leeson/Hydro`
- Branch: `course-v2.1`
- Target container: `hydro2`
- Target URL: `http://localhost:8082`
- Primary domain: `cpptrain`
- Accounts:
  - Admin: `xingchen`
  - Regular user: `amily`

## Code Commits

- `60b05b94 feat: adjust course and problem management`
- `315ecc56 fix: avoid course dag editor early sync error`
- `dfdf337c fix: keep default lesson window auto sync`
- `9ddd8ecf fix: avoid shadowing template global in problem list`

## Build and Publish

Commands executed:

```bash
yarn build
yarn build:ui
./build-and-publish-dev.sh --packages hydrooj,ui-default
```

Final published versions:

- `hydrooj@5.0.1-dev.3`
- `@hydrooj/ui-default@4.58.1-dev.5`

Build notes:

- TypeScript build passed.
- UI build passed.
- Sentry source-map upload warnings appeared because no Sentry auth token was configured; they did not block the build.

## Docker Update

Command executed in `hydro2`:

```bash
/tmp/install-dev-from-private-npm.sh update --packages hydrooj,ui-default
```

Final installed release:

- Release path: `/root/.hydro/dev-releases/20260609044912`
- Rollback command: `/tmp/install-dev-from-private-npm.sh rollback 20260609044911`
- Installed versions:
  - `hydrooj@5.0.1-dev.3`
  - `@hydrooj/ui-default@4.58.1-dev.5`

Service status:

- `pm2 status` showed `hydrooj`, `mongodb`, `caddy`, and `hydro-sandbox` online.
- Login page responded normally with `Hydro v5.0.1-dev.3`.

## Browser Validation

### Course Create and Template Form

Account: `xingchen`

URL: `http://localhost:8082/d/cpptrain/course/create?isTemplate=true`

Observed:

- Template category field is visible.
- Lesson duration defaults to `3`.
- Course begin time was `2026-06-10 00:00`.
- Lesson begin time was `2026-06-10 00:00`.
- Lesson end time was `2026-06-10 03:00`.
- Chapter move buttons are visible.
- Static assets resolved to `theme-4.58.1-dev.5.css` and `hydro-4.58.1-dev.5.js`.
- Browser console: no errors.

Lesson window behavior:

- After changing begin time to `2026-06-11 09:00` and duration to `4`, lesson window updated to `2026-06-11 09:00` - `2026-06-11 13:00`.
- After manually setting lesson window to `2026-06-11 10:00` - `2026-06-11 12:00`, later begin/duration changes did not overwrite the manual values.

### Course Template Categories

Account: `xingchen`

URL: `http://localhost:8082/d/cpptrain/course`

Observed:

- Existing template sidebar shows `全部 92` and `未分类 92`.
- A temporary template with category `Codex验证分类` was created.
- Template sidebar then showed `全部 93`, `未分类 92`, and `Codex验证分类 1`.
- Temporary template was removed after validation.

### Chapter Move

Account: `xingchen`

URL: `http://localhost:8082/d/cpptrain/course/create?isTemplate=true`

Observed:

- Loaded two temporary client-side chapters:
  - `1. A`
  - `2. B`, depending on chapter `1`
- Clicked move down on chapter `A`.
- Display order became:
  - `1. B`
  - `2. A`
- JSON was rewritten to:
  - `B` has `_id: 1` and `requireNids: [2]`
  - `A` has `_id: 2` and no requirements

### Contest Create Defaults

Account: `xingchen`

URL: `http://localhost:8082/d/cpptrain/contest/create`

Observed unchecked by default:

- `rated`
- `autoHide`
- `allowViewCode`
- `allowPrint`
- `keepScoreboardHidden`

### Problem Delete Reference Guard

Account: `xingchen`

Temporary data:

- Created two temporary `cpptrain` source problems.
- Created two temporary `system` reference problems pointing to those source problems.

Observed:

- Single-problem delete request returned `403`.
- Batch delete request returned `403`.
- Error page contained the referenced-by-other-domain/admin-contact message.
- Temporary source and reference problems were removed after validation.

### System Global Search

Account: `xingchen`

URL: `http://localhost:8082/d/system/p?q=A&global=true&scope=all&sort=recent`

Observed:

- `全局搜索` option is visible.
- Global checkbox is checked.
- Search scope is `all`.
- Sort is `recent`.
- Pagination href preserved `global=true`: `?page=2&q=A&sort=recent&scope=all&global=true`.
- Static assets resolved to `theme-4.58.1-dev.5.css`, `resource/4.58.1-dev.5/lang-zh.js`, and `hydro-4.58.1-dev.5.js`.
- Browser console: no errors.

### Regular User Permission Check

Account: `amily`

Observed:

- `http://localhost:8082/d/cpptrain/course` opened and displayed `amily`'s course list.
- `http://localhost:8082/d/system/p?q=A&global=true&scope=all` returned a permission error for `View problems`.
- No global-search checkbox was present for the regular user.
- The only browser console error in this check was the expected `403 Forbidden` resource result.

## Cleanup

- Removed the temporary course template used for category validation.
- Removed temporary problem and reference documents used for delete-guard validation.
- No `.playwright-mcp/` directory was left in the repository checkout.
- Untracked files `.devin/` and `testuser.md` were not modified or committed.

## Not Covered by Browser Mutation

- Class time batch adjustment and template-copy lesson-window persistence were not executed against existing production-like class data to avoid changing many real `cpptrain` courses. The backend paths were covered by TypeScript build and code review; targeted browser mutation can be done with a disposable class fixture if required.
