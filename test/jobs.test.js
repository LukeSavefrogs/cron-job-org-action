import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildJobPayload, parseJobs, validateTimezone } from '../src/jobs.js';

const job = (fields = {}) => ({ title: 'Ping', url: 'https://example.com/ping', schedule: '*/5 * * * *', ...fields });

describe('parseJobs', () => {
  it('returns the jobs of a valid JSON array', () => {
    const jobs = [
      job(),
      job({
        title: 'Full',
        method: 'post',
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
      }),
    ];

    assert.deepEqual(parseJobs(JSON.stringify(jobs)), jobs);
    assert.deepEqual(parseJobs('[]'), []);
  });

  for (const [description, text, message] of [
    ['invalid JSON', '[{', /not valid JSON/],
    ['an object instead of an array', JSON.stringify(job()), /must be a JSON array/],
    ['a job that is not an object', '["Ping"]', /Job #1: must be an object/],
    ['a job without title', JSON.stringify([job({ title: ' ' })]), /"title" is required/],
    ['a job without URL', JSON.stringify([job({ url: undefined })]), /"url" is required/],
    ['a URL that is not HTTP', JSON.stringify([job({ url: 'ftp://example.com' })]), /HTTP\(S\) URL/],
    ['a job without schedule', JSON.stringify([job({ schedule: undefined })]), /"schedule" is required/],
    ['an invalid cron expression', JSON.stringify([job({ schedule: '61 * * * *' })]), /invalid minute "61"/],
    ['an unknown schedule field', JSON.stringify([job({ schedule: { seconds: [0] } })]), /unknown schedule field "seconds"/],
    ['a schedule value out of range', JSON.stringify([job({ schedule: { hours: [24] } })]), /"hours" must be \[-1\]/],
    ['an empty schedule list', JSON.stringify([job({ schedule: { hours: [] } })]), /"hours" must be \[-1\]/],
    ['a time zone in the schedule', JSON.stringify([job({ schedule: { timezone: 'UTC' } })]), /set "timezone" on the job/],
    ['an unknown field', JSON.stringify([job({ titel: 'Typo' })]), /unknown field\(s\) "titel"/],
    ['an invalid method', JSON.stringify([job({ method: 'FETCH' })]), /"method" must be one of/],
    ['headers that are not strings', JSON.stringify([job({ headers: { 'X-Count': 1 } })]), /"headers" must be an object of strings/],
    ['a body that is not a string', JSON.stringify([job({ body: { a: 1 } })]), /"body" must be a string/],
    ['an invalid time zone', JSON.stringify([job({ timezone: 'Mars/Olympus' })]), /not a valid time zone/],
    ['an invalid timeout', JSON.stringify([job({ timeout: 0 })]), /"timeout" must be a number of seconds/],
    ['an invalid "enabled"', JSON.stringify([job({ enabled: 'yes' })]), /"enabled" must be true or false/],
    ['an invalid expiry', JSON.stringify([job({ expiresAt: '2030' })]), /"expiresAt" must be a date/],
    ['an incomplete authentication', JSON.stringify([job({ auth: { user: 'user' } })]), /"auth" must be an object/],
    ['invalid notification settings', JSON.stringify([job({ notification: true })]), /"notification" must be an object/],
    ['two jobs with the same title', JSON.stringify([job(), job()]), /Job #2 \("Ping"\): another job has the same title/],
  ]) {
    it(`rejects ${description}`, () => {
      assert.throws(() => parseJobs(text), message);
    });
  }
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
