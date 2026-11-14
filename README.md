# cron-job.org folder sync

GitHub Action that keeps a folder of [cron-job.org](https://cron-job.org) in sync with a list of cron jobs, through
its [REST API](https://docs.cron-job.org/rest-api.html): it creates the folder and its jobs on the first run, updates
them on the next ones, and deletes them when they are no longer needed.

It is made for environments that come and go, such as the preview of each pull request: give every preview its own
folder, apply its jobs when it is deployed, and delete the folder when the pull request is closed.

- **Declarative**: the jobs are identified by their title within the folder, so running the action again updates them
  instead of creating duplicates, and (with `prune`) deletes the jobs of the folder that are no longer listed.
- **Crontab schedules**: `*/5 8-22 * * 1-5` instead of the lists of minutes, hours and days of the API.
- **Within the limits of the API**: the requests respect the rate limits of each method (e.g. 5 job creations per
  minute), and the ones rejected by a rate limit are retried.
- **No dependencies**: plain Node.js, nothing to install or bundle.

## Usage

Create an API key in the [cron-job.org Console](https://console.cron-job.org) (Settings → API) and store it in a
secret, e.g. `CRON_JOB_ORG_API_KEY`.

```yaml
- name: Create the cron jobs of the preview
  uses: LukeSavefrogs/cron-job-org-action@v1
  with:
    api-key: ${{ secrets.CRON_JOB_ORG_API_KEY }}
    folder: (Preview) PR-${{ github.event.pull_request.number }}
    timezone: Europe/Rome
    jobs: |
      [
        {
          "title": "Scheduler",
          "url": "https://pr-${{ github.event.pull_request.number }}.example.com/cron/schedule",
          "method": "POST",
          "schedule": "*/5 8-22 * * 1-5",
          "headers": { "X-Cron-Token": "${{ steps.token.outputs.token }}" }
        },
        {
          "title": "Nightly report",
          "url": "https://pr-${{ github.event.pull_request.number }}.example.com/cron/report",
          "schedule": "0 2 * * *"
        }
      ]
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

### Inputs

| Input | Description | Default |
| --- | --- | --- |
| `api-key` | API key of cron-job.org. **Required.** | |
| `command` | `apply`, `delete` or `list` (see below). | `apply` |
| `folder` | Title of the folder (`apply`), or titles of the folders, one per line (`delete`). At most 128 characters. | |
| `jobs` | `apply` only: JSON array of the jobs of the folder (see [Jobs](#jobs)). | |
| `timezone` | `apply` only: time zone of the schedules of the jobs that do not set their own. | `UTC` |
| `prune` | `apply` only: delete the jobs of the folder that are not listed in `jobs`. | `true` |
| `api-url` | Endpoint of the API, e.g. of a self-hosted cron-job.org. | `https://api.cron-job.org` |

### Commands

- **`apply`** creates the folder if it does not exist, then creates or updates each job of `jobs`, matching them by
  title with the jobs of the folder. With `prune` (the default), the other jobs of the folder are deleted: the folder
  belongs to the action. An empty array (`[]`) deletes every job of the folder, but keeps the folder.
- **`delete`** deletes the folders and every job they contain (the API alone would move the jobs to the root folder).
  The folders that do not exist are skipped, so it can run more than once.
- **`list`** sets the `folders` output to every folder of the account, e.g. to find the folders of the previews of the
  pull requests that are no longer open.

The jobs are validated before any request, so a mistake in `jobs` changes nothing.

### Outputs

| Output | Description |
| --- | --- |
| `folder-id` | `apply`: identifier of the folder. |
| `job-ids` | `apply`: JSON object mapping the title of each job to its identifier, e.g. `{"Scheduler": 12345}`. |
| `folders` | `delete`: the deleted folders; `list`: every folder of the account. JSON array of `{"folderId": 9876, "title": "..."}`. |

## Jobs

Each job of the `jobs` array is an object with these fields:

| Field | Description | Default |
| --- | --- | --- |
| `title` | Title of the job, unique within the folder: it identifies the job between runs. **Required.** | |
| `url` | URL called by the job (HTTP or HTTPS). **Required.** | |
| `schedule` | When the job runs: a crontab expression (see below), or a schedule object of the API, such as `{"minutes": [0, 30], "hours": [-1]}` (the missing fields allow every value). **Required.** | |
| `timezone` | Time zone of the schedule (e.g. `Europe/Rome`). | the `timezone` input |
| `expiresAt` | Date after which the job no longer runs, as a number in the `YYYYMMDDhhmmss` format, in the time zone of the job; `0` for never. | `0` |
| `enabled` | Whether the job runs. | `true` |
| `method` | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `TRACE` or `CONNECT`. | `GET` |
| `headers` | Request headers, as an object of strings, e.g. `{"Authorization": "Bearer ..."}`. | none |
| `body` | Request body, as a string. | empty |
| `timeout` | Timeout of the request, in seconds (`-1`: the default one of cron-job.org). | `-1` |
| `saveResponses` | Whether cron-job.org saves the headers and the body of the responses. | `false` |
| `redirectSuccess` | Whether the 3xx responses (redirects) count as successes. | `false` |
| `auth` | HTTP basic authentication: `{"user": "...", "password": "..."}`. | none |
| `notification` | [Notification settings](https://docs.cron-job.org/rest-api.html#jobnotificationsettings) of the API, e.g. `{"onFailure": true, "onFailureCount": 3}`. | unchanged |

Every field is sent on each run, so removing one (e.g. a header) also removes it on cron-job.org; except
`notification`, which keeps the settings of the job when it is not given (e.g. set in the console).

### Schedules

The crontab expressions have 5 fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12 or `JAN`-`DEC`)
and day of week (0-6 or `SUN`-`SAT`, 7 is Sunday too). Each field accepts `*`, values, ranges (`1-5`), steps (`*/5`,
`8-22/2`, `10/15`) and lists of them (`0,30`). The macros `@hourly`, `@daily` (or `@midnight`), `@weekly`, `@monthly`
and `@yearly` (or `@annually`) are accepted too.

For example, `*/5 8-22 * * 1-5` runs every 5 minutes from 8:00 to 22:55, Monday to Friday.

## Limits of the API

- By default, an API key can send **100 requests a day** (5,000 for the sustaining members of cron-job.org). A run of
  `apply` sends 2 requests (the lists of the folders and of the jobs), plus one for each job created, updated or
  deleted, plus one when it creates the folder; a run of `delete`, 2 requests plus one for each job and folder deleted.
- The rate limits of each method (e.g. 1 job creation per second and 5 per minute) are respected by waiting between the
  requests. The requests rejected by a rate limit (HTTP 429) are retried up to 4 times, honoring `Retry-After`; so are
  the other requests after a temporary error (HTTP 5xx), except the creations, which may have succeeded.
- API keys can be restricted to some IP addresses in the console, but the IP addresses of the runners hosted by GitHub
  change: keep the key in a secret, and use a key dedicated to the action.

## Development

```bash
npm test
```

The tests run the action against an in-memory fake of the API (`test/fake-api.js`).
