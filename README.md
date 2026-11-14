# cron-job.org folder sync

GitHub Action that keeps a folder of [cron-job.org](https://cron-job.org) in sync with a list of cron jobs, through
its [REST API](https://docs.cron-job.org/rest-api.html): it creates the folder and its jobs on the first run, updates
them on the next ones, and deletes them when they are no longer needed.

It is made for environments that come and go, such as the preview of each pull request: give every preview its own
folder, apply its jobs when it is deployed, and delete the folder when the pull request is closed.

- **Declarative**: the jobs are identified by their title within the folder, so running the action again updates them
  instead of creating duplicates, and (with `prune`) deletes the jobs of the folder that are no longer listed.
- **Short job lists**: jobs in YAML, with the settings they share (base URL, schedule, method, headers) given once.
- **Crontab schedules**: `*/5 8-22 * * 1-5` instead of the lists of minutes, hours and days of the API.
- **See what happens**: each job's schedule in plain English and its next runs, in the log and in the step summary;
  `dry-run` shows the changes without making them.
- **Within the limits of the API**: the requests respect the rate limits of each method (e.g. 5 job creations per
  minute), the ones rejected by a rate limit are retried, and each run reports how many requests it sent.

## Usage

Create an API key in the [cron-job.org Console](https://console.cron-job.org) (Settings → API) and store it in a
secret, e.g. `CRON_JOB_ORG_API_KEY`.

```yaml
- name: Create the cron jobs of the preview
  uses: LukeSavefrogs/cron-job-org-action@v1
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    folder: (Preview) PR-${{ github.event.pull_request.number }}
    base-url: https://pr-${{ github.event.pull_request.number }}.example.com
    timezone: Europe/Rome
    # Shared by every job that does not set its own
    schedule: "*/5 8-22 * * 1-5"
    method: POST
    headers: |
      X-Cron-Token: ${{ steps.token.outputs.token }}
    jobs: |
      - title: Scheduler
        url: /cron/schedule
      - title: Queue
        url: /cron/queue
      - title: Nightly report
        url: /cron/report
        schedule: "0 2 * * *"
```

and, when the pull request is closed:

```yaml
- name: Delete the cron jobs of the preview
  uses: LukeSavefrogs/cron-job-org-action@v1
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    command: delete
    folder: (Preview) PR-${{ github.event.pull_request.number }}
```

To clean up the folders of every pull request that is no longer open, delete them with a wildcard, excluding the open
ones:

```yaml
- name: Find the open pull requests
  id: open
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    {
      echo "folders<<EOF"
      gh pr list --repo "$GITHUB_REPOSITORY" --state open --limit 1000 --json number --jq '.[] | "(Preview) PR-\(.number)"'
      echo "EOF"
    } >> "$GITHUB_OUTPUT"

- name: Delete the cron jobs of the closed pull requests
  uses: LukeSavefrogs/cron-job-org-action@v1
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    command: delete
    folder: (Preview) PR-*
    exclude: ${{ steps.open.outputs.folders }}
```

### Inputs

| Input | Description | Default |
| --- | --- | --- |
| `api-key` | API key of cron-job.org. **Required.** | |
| `command` | `apply`, `delete` or `list` (see below). | `apply` |
| `folder` | Title of the folder (`apply`), or titles of the folders, one per line, where `*` matches any characters (`delete`). At most 128 characters. | |
| `jobs` | `apply`: YAML (or JSON) list of the jobs of the folder (see [Jobs](#jobs)). | |
| `base-url` | `apply`: URL prepended to the relative `url` of the jobs. | |
| `schedule` | `apply`: crontab expression of the jobs that do not set their own. | |
| `method` | `apply`: HTTP method of the jobs that do not set their own. | `GET` |
| `headers` | `apply`: request headers of every job, one `Name: value` per line (see [Secrets](#secrets)). | |
| `timezone` | `apply`: time zone of the schedules of the jobs that do not set their own. | `UTC` |
| `prune` | `apply`: delete the jobs of the folder that are not listed in `jobs`. | `true` |
| `exclude` | `delete`: titles of the folders to keep, one per line, where `*` matches any characters. | |
| `dry-run` | `apply` and `delete`: only read, and report what would change. | `false` |
| `api-url` | Endpoint of the API, e.g. of a self-hosted cron-job.org. | `https://api.cron-job.org` |

### Commands

- **`apply`** creates the folder if it does not exist, then creates or updates each job of `jobs`, matching them by
  title with the jobs of the folder. With `prune` (the default), the other jobs of the folder are deleted: the folder
  belongs to the action. An empty list (`[]`) deletes every job of the folder, but keeps the folder.
- **`delete`** deletes the folders and every job they contain (the API alone would move the jobs to the root folder).
  The folders that do not exist are skipped, so it can run more than once.
- **`list`** sets the `folders` output to every folder of the account.

The inputs and the jobs are validated before any request, so a mistake changes nothing.

### Outputs

| Output | Description |
| --- | --- |
| `folder-id` | `apply`: identifier of the folder (empty when it would be created, with `dry-run`). |
| `job-ids` | `apply`: JSON object mapping the title of each job to its identifier, e.g. `{"Scheduler": 12345}`. |
| `created`, `updated`, `deleted` | `apply`: JSON arrays of the titles of the jobs created, updated, and deleted by `prune`. |
| `folders` | `delete`: the deleted folders; `list`: every folder of the account. JSON array of `{"folderId": 9876, "title": "..."}`. |

With `dry-run`, the outputs describe what would change.

### Log and step summary

Each job created or updated is logged with its schedule and its next runs, and the step summary (on the page of the
workflow run) shows them in a table:

| Job | Change | Schedule | Next runs |
| --- | --- | --- | --- |
| Scheduler (#12345) | Created | Every 5 minutes, between 08:00 and 22:59, Monday through Friday (Europe/Rome) | Mon 16 Nov 08:00<br>Mon 16 Nov 08:05<br>Mon 16 Nov 08:10 |

The next runs are computed by the action: they are not shown for a schedule restricting both the days of month and
the days of week, since how cron-job.org combines them is not documented.

## Jobs

`jobs` is a YAML list (JSON works too, since it is YAML). Each job has these fields:

| Field | Description | Default |
| --- | --- | --- |
| `title` | Title of the job, unique within the folder: it identifies the job between runs. **Required.** | |
| `url` | URL called by the job (HTTP or HTTPS), or a path relative to `base-url`. **Required.** | |
| `schedule` | When the job runs: a crontab expression (see below), or a schedule object of the API, such as `{minutes: [0, 30], hours: [-1]}` (the missing fields allow every value). **Required**, unless given by the `schedule` input. | the `schedule` input |
| `timezone` | Time zone of the schedule (e.g. `Europe/Rome`). | the `timezone` input |
| `expiresAt` | Date after which the job no longer runs, as a number in the `YYYYMMDDhhmmss` format, in the time zone of the job; `0` for never. | `0` |
| `enabled` | Whether the job runs. | `true` |
| `method` | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `TRACE` or `CONNECT`. | the `method` input, or `GET` |
| `headers` | Request headers, as a map of texts; added to the ones of the `headers` input, replacing those with the same name. | the `headers` input |
| `body` | Request body, as a text. | empty |
| `timeout` | Timeout of the request, in seconds (`-1`: the default one of cron-job.org). | `-1` |
| `saveResponses` | Whether cron-job.org saves the headers and the body of the responses. | `false` |
| `redirectSuccess` | Whether the 3xx responses (redirects) count as successes. | `false` |
| `auth` | HTTP basic authentication: `{user: ..., password: ...}`. | none |
| `notification` | [Notification settings](https://docs.cron-job.org/rest-api.html#jobnotificationsettings) of the API, e.g. `{onFailure: true, onFailureCount: 3}`. | unchanged |

Every field is sent on each run, so removing one (e.g. a header) also removes it on cron-job.org; except
`notification`, which keeps the settings of the job when it is not given (e.g. set in the console). Likewise, a job
paused in the console is enabled again by the next run, unless it sets `enabled: false`.

Renaming a job deletes it and creates a new one (its title is what identifies it), losing its history.

### YAML pitfalls

- **Quote the crontab expressions**: YAML reads a value starting with `*` as an alias (`schedule: */5 * * * *` is an
  error, `schedule: "*/5 * * * *"` is not). The action says so when it happens.
- **Quote the values containing ` #` or `: `**: YAML reads ` #` as the start of a comment (`body: a #b` is `a`).
- The errors give the line and column of the mistake in the `jobs` input, but never its text, which may hold secrets.

### Secrets

Prefer the `headers` input for secrets (e.g. tokens): each line is `Name: value`, and the value is the rest of the
line, used as is, so no character of the secret can break the YAML of the jobs. Keep the secrets in GitHub secrets (or
mask them with `::add-mask::`): the action never logs the headers, the bodies or the URLs of the jobs.

### Schedules

The crontab expressions have 5 fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12 or `JAN`-`DEC`)
and day of week (0-7 or `SUN`-`SAT`, 0 and 7 being Sunday). Each field accepts `*` (or `?`), values, ranges (`1-5`),
steps (`*/5`, `8-22/2`, `10/15`) and lists of them (`0,30`). The macros `@hourly`, `@daily`, `@weekly`, `@monthly`
and `@yearly` (or `@annually`) are accepted too. They are parsed by [cron-parser](https://github.com/harrisiirak/cron-parser).

Since cron-job.org has no such settings, the seconds and years fields are not supported, and neither are `L` (last),
`W` (nearest weekday), `#` (nth day of week) and `H` (hash).

For example, `*/5 8-22 * * 1-5` runs every 5 minutes from 8:00 to 22:55, Monday to Friday.

## Limits of the API

- By default, an API key can send **100 requests a day** (5,000 for the sustaining members of cron-job.org). A run of
  `apply` sends 2 requests (the lists of the folders and of the jobs), plus one for each job created, updated or
  deleted, plus one when it creates the folder; a run of `delete`, 2 requests plus one for each job and folder deleted.
  Each run logs how many requests it sent, and shows it in the step summary.
- The rate limits of each method (e.g. 1 job creation per second and 5 per minute) are respected by waiting between the
  requests. The requests rejected by a rate limit (HTTP 429) are retried up to 4 times, honoring `Retry-After`; so are
  the other requests after a temporary error (HTTP 5xx), except the creations, which may have succeeded.
- API keys can be restricted to some IP addresses in the console, but the IP addresses of the runners hosted by GitHub
  change: keep the key in a secret, and use a key dedicated to the action.

## Development

```bash
npm ci
npm test
```

The tests run the action against an in-memory fake of the API (`test/fake-api.js`).

GitHub runs the action without installing its dependencies, so they are bundled with the sources into `dist/index.js`
by [esbuild](https://esbuild.github.io), with their licenses in `dist/licenses.txt`. After changing `src/` or the
dependencies, rebuild and commit `dist/` (the CI checks that it matches the sources):

```bash
npm run build
```
