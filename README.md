# cron-job.org folder sync

GitHub Action that keeps a folder of [cron-job.org](https://cron-job.org) jobs in sync with a list written in your
workflow. Define the jobs next to the code they call: each run creates, updates or deletes them on cron-job.org,
through its [REST API](https://docs.cron-job.org/rest-api.html).

## How it works

- **A folder belongs to the action.** `apply` makes the jobs of the folder match your list: it creates the folder and
  the missing jobs, updates the existing ones, and deletes the jobs you no longer list (`prune`, on by default).
- **Jobs are matched by their title**, so running the action again updates them instead of creating duplicates.
- **`delete` removes folders together with their jobs**, and accepts wildcards to remove several at once.
- **`dry-run` shows what would change**, without changing anything.

Each run shows every job with its schedule in plain English and its next runs, in the log and in the step summary.

## Quick start

1. Create an API key in the [cron-job.org Console](https://console.cron-job.org) (Settings → API).
2. Store it in a secret of your repository, e.g. `CRON_JOB_ORG_API_KEY`.
3. Add a step to your workflow:

```yaml
- name: Sync the cron jobs
  uses: LukeSavefrogs/cron-job-org-action@v2
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    folder: My app
    # Settings shared by every job
    base-url: https://app.example.com
    timezone: Europe/Rome
    headers: |
      Authorization: Bearer ${{ secrets.APP_CRON_TOKEN }}
    jobs: |
      - title: Health check
        url: /health
        schedule: "*/5 * * * *"
      - title: Nightly cleanup
        url: /tasks/cleanup
        method: POST
        schedule: "0 3 * * *"
```

The first run creates the folder `My app` with two jobs, both sending the `Authorization` header:

- `GET https://app.example.com/health` every 5 minutes;
- `POST https://app.example.com/tasks/cleanup` every day at 03:00, Rome time.

The next runs update them, and a job removed from the list is deleted.

## Examples

### Remove the jobs

```yaml
- name: Remove the cron jobs
  uses: LukeSavefrogs/cron-job-org-action@v2
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    command: delete
    folder: My app
```

The folders that do not exist are skipped, so the step can safely run more than once.

### Check the changes before making them

Add `dry-run: true` to an `apply` or `delete` step: the action only reads, and the log, the step summary and the
outputs show what would be created, updated or deleted.

### Remove several folders at once

For `delete`, `folder` takes one title per line, where `*` matches any characters; `exclude` keeps some of the
matching folders:

```yaml
- name: Remove the test folders
  uses: LukeSavefrogs/cron-job-org-action@v2
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    command: delete
    folder: Test *
    exclude: |
      Test (shared)
```

### Use the outputs

```yaml
- name: Sync the cron jobs
  id: cron
  uses: LukeSavefrogs/cron-job-org-action@v2
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    folder: My app
    jobs: |
      - title: Health check
        url: https://app.example.com/health
        schedule: "*/5 * * * *"

- name: Show the identifier of the job
  run: echo "Job #${{ fromJSON(steps.cron.outputs.job-ids)['Health check'] }}"
```

## Inputs

All the commands:

| Input | Description | Required | Default |
| --- | --- | --- | --- |
| `api-key` | API key of cron-job.org. | **Yes** | |
| `command` | `apply` (create or update the jobs of a folder), `delete` (delete folders and their jobs) or `list` (list the folders). | No | `apply` |
| `folder` | `apply`: title of the folder. `delete`: titles of the folders, one per line, where `*` matches any characters. At most 128 characters. | No | |
| `dry-run` | `apply` and `delete`: only read, and report what would change. | No | `false` |
| `api-url` | Endpoint of the API, e.g. of a self-hosted cron-job.org. | No | `https://api.cron-job.org` |

`apply` only:

| Input | Description | Required | Default |
| --- | --- | --- | --- |
| `jobs` | The jobs of the folder, as a YAML (or JSON) list: see [Jobs](#jobs). | **Yes** | |
| `base-url` | URL prepended to the relative `url` of the jobs (e.g. `/health`). | No | |
| `schedule` | Crontab expression of the jobs that do not set their own. | No | |
| `method` | HTTP method of the jobs that do not set their own. | No | `GET` |
| `headers` | Request headers of every job, one `Name: value` per line (see [Secrets](#secrets)). | No | |
| `timezone` | Time zone of the schedules of the jobs that do not set their own. | No | `UTC` |
| `prune` | Delete the jobs of the folder that are not listed in `jobs`. | No | `true` |

`delete` only:

| Input | Description | Required | Default |
| --- | --- | --- | --- |
| `exclude` | Titles of the folders to keep, one per line, where `*` matches any characters. | No | |

The inputs and the jobs are validated before any request, so a mistake changes nothing.

## Outputs

| Output | Command | Description |
| --- | --- | --- |
| `folder-id` | `apply` | Identifier of the folder (empty when it would be created, with `dry-run`). |
| `job-ids` | `apply` | JSON object mapping the title of each job to its identifier, e.g. `{"Health check": 12345}`. |
| `created`, `updated`, `deleted` | `apply` | JSON arrays of the titles of the jobs created, updated, and deleted by `prune`. |
| `folders` | `delete`, `list` | The deleted folders (`delete`) or every folder of the account (`list`), as a JSON array of `{"folderId": 9876, "title": "..."}`. |

With `dry-run`, the outputs describe what would change.

## Jobs

`jobs` is a YAML list (JSON works too, since it is YAML). Each job has these fields:

| Field | Description | Required | Default |
| --- | --- | --- | --- |
| `title` | Title of the job, unique within the folder: it identifies the job between runs. | **Yes** | |
| `url` | URL called by the job (HTTP or HTTPS), or a path relative to `base-url`. | **Yes** | |
| `schedule` | When the job runs: a crontab expression (see [Schedules](#schedules)), or a schedule object of the API, such as `{minutes: [0, 30], hours: [-1]}` (the missing fields allow every value). | **Yes**, unless set by the `schedule` input | the `schedule` input |
| `timezone` | Time zone of the schedule (e.g. `Europe/Rome`). | No | the `timezone` input |
| `expiresAt` | Date after which the job no longer runs, as a number in the `YYYYMMDDhhmmss` format, in the time zone of the job; `0` for never. | No | `0` |
| `enabled` | Whether the job runs. | No | `true` |
| `method` | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `TRACE` or `CONNECT`. | No | the `method` input, or `GET` |
| `headers` | Request headers, as a map of texts. | No | the `headers` input |
| `body` | Request body, as a text. | No | empty |
| `timeout` | Timeout of the request, in seconds (`-1`: the default one of cron-job.org). | No | `-1` |
| `saveResponses` | Whether cron-job.org saves the headers and the body of the responses. | No | `false` |
| `redirectSuccess` | Whether the 3xx responses (redirects) count as successes. | No | `false` |
| `auth` | HTTP basic authentication: `{user: ..., password: ...}`. | No | none |
| `notification` | [Notification settings](https://docs.cron-job.org/rest-api.html#jobnotificationsettings) of the API, e.g. `{onFailure: true, onFailureCount: 3}`. | No | unchanged |

### Settings shared by every job

The `base-url`, `schedule`, `method`, `headers` and `timezone` inputs apply to every job, so each job only needs what
makes it different:

- a field set on the job wins over the input;
- the `headers` of a job are added to the ones of the input, replacing those with the same name, whatever their case;
- a relative `url` is appended to `base-url` (`/health` with `https://app.example.com` gives
  `https://app.example.com/health`), while a full URL is used as is.

## Schedules

The crontab expressions have 5 fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12 or `JAN`-`DEC`)
and day of week (0-7 or `SUN`-`SAT`, 0 and 7 being Sunday). Each field accepts `*` (or `?`), values, ranges (`1-5`),
steps (`*/5`, `8-22/2`, `10/15`) and lists of them (`0,30`). The macros `@hourly`, `@daily`, `@weekly`, `@monthly`
and `@yearly` (or `@annually`) are accepted too. They are parsed by [cron-parser](https://github.com/harrisiirak/cron-parser).

For example, `*/5 8-22 * * 1-5` runs every 5 minutes from 08:00 to 22:55, Monday to Friday.

cron-job.org has no seconds or years, so the 6- and 7-field expressions are not supported, and neither are `L` (last),
`W` (nearest weekday), `#` (nth day of week) and `H` (hash).

## Writing the jobs in YAML

- **Quote the crontab expressions**: YAML reads a value starting with `*` as an alias, so `schedule: */5 * * * *` is
  an error, while `schedule: "*/5 * * * *"` is not. The action points it out when it happens.
- **Quote the values containing ` #` or `: `**: YAML reads ` #` as the start of a comment (`body: a #b` is `a`).
- The errors give the line and column of the mistake in the `jobs` input, but never its text, which may hold secrets.

### Secrets

Pass the secrets (e.g. tokens) through the `headers` input: each line is `Name: value`, and the value is the rest of
the line, used as is, so no character of the secret can break the YAML of the jobs. Keep them in GitHub secrets (or
mask them with `::add-mask::`): the action never logs the headers, the bodies or the URLs of the jobs.

## Log and step summary

Each job created or updated is logged with its schedule and its next runs, and the step summary (on the page of the
workflow run) shows them in a table:

| Job | Change | Schedule | Next runs |
| --- | --- | --- | --- |
| Health check (#12345) | Created | Every 5 minutes (Europe/Rome) | Mon 16 Nov 08:00<br>Mon 16 Nov 08:05<br>Mon 16 Nov 08:10 |

The next runs are computed by the action. They are not shown for a schedule restricting both the days of month and
the days of week, since how cron-job.org combines them is not documented.

## Good to know

- Every field of a job is sent on each run, so removing one (e.g. a header) also removes it on cron-job.org. The only
  exception is `notification`, which keeps the settings of the job when it is not given (e.g. set in the console).
- A job paused in the console is enabled again by the next run, unless it sets `enabled: false`.
- Renaming a job deletes it and creates a new one, since its title is what identifies it: its history is lost.
- The titles of the folders are unique within an account, and at most 128 characters long.

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
