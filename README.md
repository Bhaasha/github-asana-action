
# Github-Asana action

This action integrates asana with github.

### Prerequisites

- Asana account with the permission on the particular project you want to integrate with.
- Must provide the task url in the PR description.

## Inputs

### `asana-pat`

**Required** Your public access token for asana, you can generate one [here](https://app.asana.com/0/developer-console).

### `action`

**Required** The action to be performed assert-link|add-comment|remove-comment|move-section|complete-task|update-fields

### `trigger-phrase`

**Optional** Prefix before the task i.e ASANA TASK: https://app.asana.com/1/2/3/.

### `text`

**Required for `add-comment`** If any comment is provided, the action will add a comment to the specified asana task with the text.

### `comment-id`

**Required for `remove-comment`, Optional for `add-comment`** When provided in add-comment, gives a unique identifier that can later be used to delete the comment

### `is-pinned`

**Optional for `add-comment`** Mark a comment as pinned in asana

### `targets`

**Required for `move-section`** JSON array of objects having project and section where to move current task. Move task only if it exists in target project. e.g 
```yaml
targets: '[{"project": "Backlog", "section": "Development Done"}, {"project": "Current Sprint", "section": "In Review"}]'
```
if you don't want to move task omit `targets`.

### `link-required`

**Required for `assert-link`** When set to true the action fails when the pull
request body has no asana link, failing the job it runs in

### `is-complete`

**Required for `complete-task`** If the task is complete or not

## Example usage

```yaml
name: Move a task to a different section

on:
  pull_request:
    types: [closed]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: Bhaasha/github-asana-action@v1
        if: github.event.pull_request.merged
        with:
          asana-pat: ${{ secrets.ASANA_PAT }}
          action: 'move-section'
          targets: '[{"project": "Engineering scrum", "section": "Done"}]'
```

```yaml
name: Add a comment

on:
  pull_request:
    types: [opened, edited, labeled, unlabeled]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: Bhaasha/github-asana-action@v1
        with:
          asana-pat: ${{ secrets.ASANA_PAT }}
          action: 'add-comment'
          comment-id: "#pr:${{ github.event.pull_request.number }}"
          text: 'View Pull Request: ${{ github.event.pull_request.html_url }}'
          is-pinned: true
```

```yaml
name: Remove a comment

on:
  pull_request:
    types: [closed]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: Bhaasha/github-asana-action@v1
        if: github.event.pull_request.merged
        with:
          asana-pat: ${{ secrets.ASANA_PAT }}
          action: 'remove-comment'
          comment-id: "#pr:${{ github.event.pull_request.number }}"
```

```yaml
name: Validate asana link presence

on:
  pull_request:
    # revalidate on label changes
    types: [opened, edited, labeled, unlabeled]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: Bhaasha/github-asana-action@v1
        with:
          asana-pat: ${{ secrets.ASANA_PAT }}
          action: assert-link
          # if the branch is labeled a hotfix, skip this check
          link-required: ${{ !contains(github.event.pull_request.labels.*.name, 'hotfix') }}
```

```yaml
name: Mark a task complete

on:
  pull_request:
    types: [closed]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: Bhaasha/github-asana-action@v1
        if: github.event.pull_request.merged
        with:
          asana-pat: ${{ secrets.ASANA_PAT }}
          action: 'complete-task'
          is-complete: true
```
## Development

Requires Node 24 and pnpm (see `packageManager` in `package.json`).

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # node --test
pnpm package     # bundle src/index.ts into dist/index.js
```

`dist/index.js` is committed and is what the runner executes, so re-run
`pnpm package` and commit the result whenever anything under `src/` changes.

`dist/index.js.LEGAL.txt` is committed alongside it. `--legal-comments=external`
lifts the bundled dependencies' copyright notices out of the bundle into that
file, so shipping `index.js` without it would redistribute MIT-licensed code
with its notices stripped.

No sourcemap is emitted: the runner never reads one, and a ~4 MB map would land
in every release diff and every consumer's checkout. Build with `--sourcemap`
locally if you need to debug a stack trace.

### Tests

`pnpm test` runs against an in-process mock of the Asana API (`src/test/asana-mock.ts`),
so it needs no credentials and no network.

To run the same suite against real Asana, copy `.env.example` to `.env` and fill
in all three variables. Setting only some of them fails fast rather than quietly
falling back to the stub. The project the tests point at must be named
"Asana bot test environment" and contain sections named "New" and "Done", a
number custom field named "Custom Number", and an enum custom field named
"Custom Enum" with an "OK" option. The suite creates a task there and deletes it
on the way out.

### Releasing

A GitHub Action is consumed straight out of its repository — there is no
registry to push to. What makes it usable is a **git ref consumers can pin to**,
plus a committed `dist/` for the runner to execute. Publishing to the GitHub
Marketplace is optional and only affects discoverability.

Consumers pin to the major tag, which tracks the newest stable release:

```yaml
- uses: Bhaasha/github-asana-action@v1
```

To cut a release:

```bash
# 1. bump the version in package.json, then
pnpm package
git commit -am 'release v1.0.1'
git tag v1.0.1
git push origin master v1.0.1
```

Pushing the `v1.0.1` tag triggers `.github/workflows/release.yml`, which
refuses to publish unless the tag matches `package.json`, typecheck and tests
pass, and the committed `dist/` matches a fresh `pnpm package`. It then creates
the GitHub release and repoints `v1` at the new commit.

Prerelease tags (`v1.1.0-rc.1`) are published as prereleases and deliberately do
not move the major tag.
