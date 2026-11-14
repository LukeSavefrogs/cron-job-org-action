import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildJobPayload, parseHeaders, parseJobDefaults, parseJobs, validateTimezone } from '../src/jobs.js';

const job = (fields = {}) => ({ title: 'Ping', url: 'https://example.com/ping', schedule: '*/5 * * * *', ...fields });

describe('parseJobs', () => {
  it('reads a YAML list of jobs', () => {
    const jobs = parseJobs(
      [
        '# The jobs of the preview',
        '- title: Ping',
        '  url: https://example.com/ping',
        '  schedule: "*/5 * * * *"',
        '- title: Report',
        '  url: https://example.com/report',
        '  schedule: "0 7 * * MON"',
        '  method: post',
        '  enabled: false',
        '  body: |',
        '    {"full": true}',
      ].join('\n'),
    );

    assert.deepEqual(jobs, [
      { ...job(), headers: {} },
      {
        title: 'Report',
        url: 'https://example.com/report',
        schedule: '0 7 * * MON',
        method: 'POST',
        enabled: false,
        body: '{"full": true}\n',
        headers: {},
      },
    ]);
  });

  it('still reads JSON, even with trailing commas', () => {
    const full = job({
      title: 'Full',
      headers: { 'X-Token': 'secret' },
      body: '{}',
      timezone: 'Europe/Rome',
      expiresAt: 20301231235959,
      enabled: false,
      timeout: 30,
      saveResponses: true,
      redirectSuccess: true,
      auth: { user: 'user', password: 'password' },
      notification: { onFailure: true },
      schedule: { minutes: [0, 30], wdays: [-1] },
    });

    assert.deepEqual(parseJobs(JSON.stringify([job(), full])), [{ ...job(), headers: {} }, full]);
    assert.deepEqual(parseJobs(`[\n  ${JSON.stringify(job())},\n]`), [{ ...job(), headers: {} }]);
    assert.deepEqual(parseJobs('[]'), []);
  });

  it('reports the position of syntax errors, without showing the input', () => {
    const secret = 's3cr"etTokenValue';
    const text = `[{"title": "A", "url": "https://a.b", "schedule": "* * * * *", "headers": {"X": "${secret}"}}]`;

    assert.throws(() => parseJobs(text), (error) => {
      assert.match(error.message, /^The "jobs" input is not valid YAML or JSON \(line 1, column \d+\): /);
      assert.ok(!error.message.includes('etTokenValue'), error.message);
      return true;
    });
    assert.throws(
      () => parseJobs('- title: A\n  title: B\n'),
      /not valid YAML or JSON \(line 2, column 3\): Map keys must be unique\./,
    );
  });

  it('explains that the cron expressions starting with * must be quoted', () => {
    assert.throws(
      () => parseJobs('- title: Ping\n  url: /ping\n  schedule: */5 8-22 * * 1-5\n'),
      /\(line 3, column \d+\).*Quote the cron expressions starting with "\*"/,
    );
  });

  it('applies the defaults to the jobs that do not set their own', () => {
    const defaults = parseJobDefaults({
      baseUrl: 'https://pr-42.example.com/',
      schedule: '*/5 8-22 * * 1-5',
      method: 'post',
      headers: 'X-Cron-Token: secret\nX-Other: value',
    });

    const jobs = parseJobs(
      [
        '- title: Schedule run',
        '  url: /api/schedule',
        '- title: Custom',
        '  url: https://other.example.com/hook',
        '  schedule: "0 9 * * *"',
        '  method: GET',
        '  headers:',
        '    x-other: overridden',
      ].join('\n'),
      defaults,
    );

    assert.deepEqual(jobs, [
      {
        title: 'Schedule run',
        url: 'https://pr-42.example.com/api/schedule',
        schedule: '*/5 8-22 * * 1-5',
        method: 'POST',
        headers: { 'X-Cron-Token': 'secret', 'X-Other': 'value' },
      },
      {
        title: 'Custom',
        url: 'https://other.example.com/hook',
        schedule: '0 9 * * *',
        method: 'GET',
        // A header of the job replaces the default one, whatever its case
        headers: { 'X-Cron-Token': 'secret', 'x-other': 'overridden' },
      },
    ]);
  });

  it('joins the relative URLs to the base URL', () => {
    const resolve = (baseUrl, url) => parseJobs(JSON.stringify([job({ url })]), { baseUrl })[0].url;

    assert.equal(resolve('https://example.com', 'ping'), 'https://example.com/ping');
    assert.equal(resolve('https://example.com/app/', '/api/ping?full=1'), 'https://example.com/app/api/ping?full=1');
    assert.equal(resolve('https://example.com', 'https://other.example.com/'), 'https://other.example.com/');
  });

  for (const [description, text, message] of [
    ['an empty input', '# nothing\n', /has no jobs: use \[\] for none/],
    ['a single job instead of a list', 'title: Ping\nurl: /ping\n', /must be a list of jobs: start each job with "- "/],
    ['a job that is not an object', '- Ping', /Job #1 \(line 1\): must be an object/],
    ['a job without title', JSON.stringify([job({ title: ' ' })]), /"title" is required/],
    ['a title that is not a text', '- title: 2024\n  url: https://a.b\n  schedule: "@daily"', /"title" is required \(a text\)/],
    ['a job without URL', JSON.stringify([job({ url: undefined })]), /"url" is required/],
    ['a relative URL without base URL', JSON.stringify([job({ url: '/ping' })]), /"url" is relative: set the "base-url" input/],
    ['a URL that is not HTTP', JSON.stringify([job({ url: 'ftp://example.com' })]), /HTTP\(S\) URL/],
    ['a URL with spaces', JSON.stringify([job({ url: 'https://example.com/a b' })]), /cannot contain spaces/],
    ['a job without schedule', JSON.stringify([job({ schedule: undefined })]), /"schedule" is required: set it on the job, or in the "schedule" input/],
    ['an invalid cron expression', JSON.stringify([job({ schedule: '61 * * * *' })]), /got value 61 expected range 0-59/],
    ['an unknown schedule field', JSON.stringify([job({ schedule: { seconds: [0] } })]), /unknown schedule field "seconds"/],
    ['a schedule value out of range', JSON.stringify([job({ schedule: { hours: [24] } })]), /"hours" must be \[-1\]/],
    ['an empty schedule list', JSON.stringify([job({ schedule: { hours: [] } })]), /"hours" must be \[-1\]/],
    ['a time zone in the schedule', JSON.stringify([job({ schedule: { timezone: 'UTC' } })]), /set "timezone" on the job/],
    ['an unknown field', JSON.stringify([job({ titel: 'Typo' })]), /unknown field\(s\) "titel"/],
    ['an invalid method', JSON.stringify([job({ method: 'FETCH' })]), /"method" must be one of/],
    ['headers that are not texts', '- title: A\n  url: https://a.b\n  schedule: "@daily"\n  headers:\n    X-Count: 1', /"headers" must be a map of texts/],
    ['a body that is not a text', JSON.stringify([job({ body: { a: 1 } })]), /"body" must be a text/],
    ['an invalid time zone', JSON.stringify([job({ timezone: 'Mars/Olympus' })]), /not a valid time zone/],
    ['an invalid timeout', JSON.stringify([job({ timeout: 0 })]), /"timeout" must be a number of seconds/],
    ['an invalid "enabled"', '- title: A\n  url: https://a.b\n  schedule: "@daily"\n  enabled: yes', /"enabled" must be true or false/],
    ['an invalid expiry', JSON.stringify([job({ expiresAt: '2030' })]), /"expiresAt" must be a date/],
    ['an incomplete authentication', JSON.stringify([job({ auth: { user: 'user' } })]), /"auth" must have the "user" and "password"/],
    ['invalid notification settings', JSON.stringify([job({ notification: true })]), /"notification" must be a map/],
    ['two jobs with the same title', JSON.stringify([job(), job()]), /Job #2 \("Ping", line 1\): another job has the same title/],
  ]) {
    it(`rejects ${description}`, () => {
      assert.throws(() => parseJobs(text), message);
    });
  }

  it('locates the jobs in the errors', () => {
    const text = ['- title: First', '  url: https://a.b', '  schedule: "@daily"', '', '- title: Second', '  url: /relative'].join('\n');

    assert.throws(() => parseJobs(text, { schedule: '@daily' }), /^Error: Job #2 \("Second", line 5\): "url" is relative/);
  });
});

describe('parseJobDefaults', () => {
  it('returns no default for the empty inputs', () => {
    assert.deepEqual(parseJobDefaults({}), { headers: {} });
  });

  for (const [description, inputs, message] of [
    ['a base URL that is not HTTP', { baseUrl: 'example.com' }, /"base-url" input must be an HTTP\(S\) URL/],
    ['an invalid schedule', { schedule: '* * *' }, /"schedule" input is not valid: Invalid cron expression "\* \* \*"/],
    ['an invalid method', { method: 'FETCH' }, /"method" input must be one of GET, POST/],
  ]) {
    it(`rejects ${description}`, () => {
      assert.throws(() => parseJobDefaults(inputs), message);
    });
  }
});

describe('parseHeaders', () => {
  it('reads one "Name: value" header per line, keeping the value as is', () => {
    assert.deepEqual(parseHeaders('X-Cron-Token: abc"def: #ghi\n\n  Accept :  application/json  \r\n'), {
      'X-Cron-Token': 'abc"def: #ghi',
      Accept: 'application/json',
    });
    assert.deepEqual(parseHeaders('X-Empty:'), { 'X-Empty': '' });
    assert.deepEqual(parseHeaders(''), {});
  });

  it('rejects the invalid lines without showing them', () => {
    assert.throws(() => parseHeaders('X-Ok: 1\nsecret-without-name'), (error) => {
      assert.equal(error.message, 'Line 2 of the "headers" input must be a "Name: value" header.');
      return true;
    });
    assert.throws(() => parseHeaders(': value'), /Line 1/);
    assert.throws(() => parseHeaders('Bad Name: value'), /Line 1/);
  });

  it('rejects the headers set twice', () => {
    assert.throws(() => parseHeaders('X-Token: a\nx-token: b'), /sets the "x-token" header more than once/);
  });
});

describe('validateTimezone', () => {
  it('accepts the IANA time zones', () => {
    for (const timezone of ['UTC', 'Europe/Rome', 'America/New_York']) {
      assert.doesNotThrow(() => validateTimezone(timezone));
    }
  });

  it('rejects the others', () => {
    for (const timezone of ['', 'Rome', 'Mars/Olympus', 42]) {
      assert.throws(() => validateTimezone(timezone), /not a valid time zone/);
    }
  });
});

describe('buildJobPayload', () => {
  it('sends the defaults of every field not given, so that removed settings are reset on update', () => {
    assert.deepEqual(buildJobPayload(job(), { folderId: 42, timezone: 'Europe/Rome' }), {
      title: 'Ping',
      url: 'https://example.com/ping',
      enabled: true,
      folderId: 42,
      schedule: {
        timezone: 'Europe/Rome',
        expiresAt: 0,
        minutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],
        hours: [-1],
        mdays: [-1],
        months: [-1],
        wdays: [-1],
      },
      requestMethod: 0,
      requestTimeout: -1,
      saveResponses: false,
      redirectSuccess: false,
      auth: { enable: false, user: '', password: '' },
      extendedData: { headers: {}, body: '' },
    });
  });

  it('maps the fields of the job to the ones of the API', () => {
    const payload = buildJobPayload(
      job({
        method: 'post',
        headers: { 'X-Token': 'secret' },
        body: '{"a":1}',
        timezone: 'America/New_York',
        expiresAt: 20301231235959,
        enabled: false,
        timeout: 30,
        saveResponses: true,
        redirectSuccess: true,
        auth: { user: 'user', password: 'password' },
        notification: { onFailure: true, onFailureCount: 3 },
      }),
      { folderId: 7, timezone: 'UTC' },
    );

    assert.equal(payload.requestMethod, 1);
    assert.deepEqual(payload.extendedData, { headers: { 'X-Token': 'secret' }, body: '{"a":1}' });
    assert.equal(payload.schedule.timezone, 'America/New_York');
    assert.equal(payload.schedule.expiresAt, 20301231235959);
    assert.equal(payload.enabled, false);
    assert.equal(payload.requestTimeout, 30);
    assert.equal(payload.saveResponses, true);
    assert.equal(payload.redirectSuccess, true);
    assert.deepEqual(payload.auth, { enable: true, user: 'user', password: 'password' });
    assert.deepEqual(payload.notification, { onFailure: true, onFailureCount: 3 });
  });

  it('fills the fields missing from a schedule object with every value', () => {
    const payload = buildJobPayload(job({ schedule: { minutes: [0], hours: [3] } }), { folderId: 1, timezone: 'UTC' });

    assert.deepEqual(payload.schedule, {
      timezone: 'UTC',
      expiresAt: 0,
      minutes: [0],
      hours: [3],
      mdays: [-1],
      months: [-1],
      wdays: [-1],
    });
  });
});
