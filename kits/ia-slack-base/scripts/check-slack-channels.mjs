#!/usr/bin/env node
// inventarch/ia-slack-base-kit offline Slack channel settings & governance checker (declared check: check-slack-channels).
// Pure Node built-in ESM, zero external npm dependencies, zero network access, and zero live tokens.
//
// Usage from an IA workspace root (via plugins/ia/scripts/check.mjs):
//   node check-slack-channels.mjs [--ia] <the command words that run ia...>
// Prints { format, revision, ok, counts, findings } on stdout and exits 0 when ok, 1 when findings exist,
// or 2 (with nothing on stdout) when the workspace is missing, refused by ia validate, or unreadable.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'ia.slack.channel-check.v1';
const MAX_BUFFER = 256 * 1024 * 1024;

const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]{6,20}$/;
const SLACK_USER_ID_RE = /^(?:T[A-Z0-9]{6,20}\s+)?[UW][A-Z0-9]{6,20}$/;
const OPAQUE_SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const TOKEN_LIKE_RE = /(?:^xox[abpeors]-|^xapp-|bearer\s|https?:\/\/|slack\.com\/api)/i;
const RATE_RE = /^([1-9]\d*)\s+([1-9]\d*)$/;

export function isOpaqueSecretName(value) {
  if (typeof value !== 'string' || !OPAQUE_SECRET_NAME_RE.test(value)) return false;
  if (TOKEN_LIKE_RE.test(value)) return false;
  return true;
}

export function parseSlackUserId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed !== value || !SLACK_USER_ID_RE.test(value)) return null;
  const parts = value.split(/\s+/);
  return parts.length === 2 ? { teamId: parts[0], userId: parts[1] } : { teamId: null, userId: parts[0] };
}

export function isCredentialFreeHome(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || /\s/.test(value)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.username === '' && parsed.password === '' && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(value)) return true;
  if (value.includes('://') || value.includes('@') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function sectionField(record, path) {
  const [section, key] = path.split('.');
  return record.sections?.find(s => s.name === section)?.fields?.find(f => f.key === key)?.value;
}

function scalarText(value) {
  if (!value) return null;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.value === 'number' || typeof value.value === 'string') return String(value.value);
  return null;
}

function listItems(value) {
  return value?.kind === 'list' && Array.isArray(value.items) ? value.items : [];
}

function refKey(value) {
  if (!value) return null;
  if (value.kind === 'identity' && typeof value.identity === 'string') return value.identity;
  if (value.kind === 'ref' && value.discriminator && value.name) {
    return `@${value.discriminator} ${String(value.name).toLowerCase()}`;
  }
  return null;
}

function buildLookup(records) {
  const byIdentity = new Map();
  const byRef = new Map();
  for (const r of records) {
    byIdentity.set(r.identity, r);
    const key = `@${r.discriminator} ${String(r.name ?? '').toLowerCase()}`;
    if (!byRef.has(key) || r.provenance === 'workspace') byRef.set(key, r.identity);
  }
  const resolveRef = ref => {
    if (!ref) return null;
    if (typeof ref === 'string') return byIdentity.has(ref) ? ref : (byRef.get(ref.toLowerCase()) ?? null);
    if (ref.target && byIdentity.has(ref.target)) return ref.target;
    const key = refKey(ref.reference ?? ref);
    if (!key) return null;
    return byIdentity.has(key) ? key : (byRef.get(key) ?? null);
  };
  return { byIdentity, resolveRef };
}

export function checkSlackChannels(snapshot) {
  const allRecords = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const { byIdentity, resolveRef } = buildLookup(allRecords);
  const findings = [];

  const report = (code, record, message) => {
    findings.push({
      code,
      severity: 'error',
      discriminator: record.discriminator,
      identity: record.identity,
      name: record.name ?? null,
      file: record.origin?.file ?? null,
      line: record.origin?.line ?? null,
      message,
    });
  };

  const own = allRecords.filter(r => (r.provenance ?? 'workspace') === 'workspace');
  const channels = own.filter(r => r.discriminator === 'slack-channel');
  const workspaces = allRecords.filter(r => r.discriminator === 'workspace');

  const seenChannelIds = new Map();
  const seenAppChannels = new Map();

  for (const ch of channels) {
    const label = scalarText(sectionField(ch, 'slack.label')) ?? '';
    const channelName = scalarText(sectionField(ch, 'slack.channel')) ?? '';
    const channelId = scalarText(sectionField(ch, 'slack.channel-id'));
    const wsRef = sectionField(ch, 'slack.workspace');
    const home = scalarText(sectionField(ch, 'slack.home')) ?? '';
    const approverRaw = scalarText(sectionField(ch, 'slack.approver')) ?? '';
    const membersRaw = listItems(sectionField(ch, 'slack.members')).map(scalarText);
    const app = scalarText(sectionField(ch, 'slack.app')) ?? '';
    const secret = scalarText(sectionField(ch, 'slack.secret')) ?? '';
    const answers = scalarText(sectionField(ch, 'slack.answers')) ?? 'off';
    const sources = listItems(sectionField(ch, 'slack.sources'))
      .map(scalarText)
      .filter(v => typeof v === 'string' && v.trim().length > 0);
    const shows = listItems(sectionField(ch, 'slack.shows'))
      .map(scalarText)
      .filter(v => typeof v === 'string' && v.trim().length > 0);
    const kind = scalarText(sectionField(ch, 'slack.kind')) ?? 'design-channel';
    const form = scalarText(sectionField(ch, 'slack.form'));
    const rate = scalarText(sectionField(ch, 'slack.rate'));
    const disclosure = scalarText(sectionField(ch, 'slack.disclosure')) ?? 'link-only';

    if (!label.trim()) {
      report('SLACK_LABEL_EMPTY', ch, `@slack-channel ${ch.name}: slack.label must be non-empty`);
    }
    if (!channelName.trim() || /\s/.test(channelName.trim())) {
      report('SLACK_CHANNEL_NAME_INVALID', ch, `@slack-channel ${ch.name}: slack.channel must be a single non-empty conversation name`);
    } else {
      const appChannelKey = `${app}:${channelName.trim().toLowerCase()}`;
      if (seenAppChannels.has(appChannelKey)) {
        report(
          'SLACK_CHANNEL_NAME_DUPLICATE',
          ch,
          `@slack-channel ${ch.name} duplicates slack.app=${app} slack.channel=${channelName} already bound by ${seenAppChannels.get(appChannelKey)}`,
        );
      } else {
        seenAppChannels.set(appChannelKey, ch.name);
      }
    }

    if (channelId !== null) {
      if (!SLACK_CHANNEL_ID_RE.test(channelId)) {
        report(
          'SLACK_CHANNEL_ID_FORMAT',
          ch,
          `@slack-channel ${ch.name}: slack.channel-id ${JSON.stringify(channelId)} must be a valid Slack conversation id (C..., G... or D...)`,
        );
      } else if (seenChannelIds.has(channelId)) {
        report(
          'SLACK_CHANNEL_ID_DUPLICATE',
          ch,
          `@slack-channel ${ch.name} duplicates slack.channel-id ${channelId} already bound by ${seenChannelIds.get(channelId)}`,
        );
      } else {
        seenChannelIds.set(channelId, ch.name);
      }
    }

    const resolvedWs = resolveRef(wsRef);
    const targetWs = resolvedWs ? byIdentity.get(resolvedWs) : null;
    if (!targetWs || targetWs.discriminator !== 'workspace') {
      report('SLACK_WORKSPACE_UNRESOLVED', ch, `@slack-channel ${ch.name}: slack.workspace does not resolve to an admitted @workspace`);
    }

    if (!isCredentialFreeHome(home)) {
      report('SLACK_HOME_INVALID', ch, `@slack-channel ${ch.name}: slack.home must be a non-empty, credential-free locator`);
    }

    if (!isOpaqueSecretName(secret)) {
      report(
        'SLACK_SECRET_TOKEN',
        ch,
        `@slack-channel ${ch.name}: slack.secret must be an opaque secret reference name, never a token, URL or blank string`,
      );
    }

    const parsedApprover = parseSlackUserId(approverRaw);
    if (!parsedApprover) {
      report(
        'SLACK_APPROVER_FORMAT',
        ch,
        `@slack-channel ${ch.name}: slack.approver ${JSON.stringify(approverRaw)} must be '<Slack user id>' or '<Slack team id> <Slack user id>'`,
      );
    }

    if (membersRaw.length === 0) {
      report('SLACK_MEMBERS_EMPTY', ch, `@slack-channel ${ch.name}: slack.members must list at least one Slack user identifier`);
    }

    const memberUserIds = new Set();
    for (const member of membersRaw) {
      const parsed = parseSlackUserId(member ?? '');
      if (!parsed) {
        report(
          'SLACK_MEMBER_FORMAT',
          ch,
          `@slack-channel ${ch.name}: slack.members entry ${JSON.stringify(member)} is not a valid Slack user identifier`,
        );
        continue;
      }
      if (memberUserIds.has(parsed.userId)) {
        report('SLACK_MEMBER_DUPLICATE', ch, `@slack-channel ${ch.name}: duplicate member Slack user id ${parsed.userId}`);
      }
      memberUserIds.add(parsed.userId);
    }

    if (parsedApprover && memberUserIds.size > 0 && !memberUserIds.has(parsedApprover.userId)) {
      report(
        'SLACK_APPROVER_NOT_MEMBER',
        ch,
        `@slack-channel ${ch.name}: checkpoint approver ${parsedApprover.userId} must also be listed in slack.members`,
      );
    }

    // Person-app governance rule (REQ-SLACK-12 & audience law): direct conversation with sole owner only
    if (app === 'person') {
      if (membersRaw.length > 1) {
        report('SLACK_PERSON_APP_POSTURE', ch, `@slack-channel ${ch.name}: slack.app person may list only its single owner in slack.members`);
      }
      if ((form && form !== 'direct') || (scalarText(sectionField(ch, 'slack.kind')) && kind !== 'direct')) {
        report(
          'SLACK_PERSON_APP_POSTURE',
          ch,
          `@slack-channel ${ch.name}: slack.app person may only serve a direct space (slack.form direct, slack.kind direct)`,
        );
      }
    }

    const allowList = [...sources, ...shows];
    if (disclosure === 'content') {
      if (allowList.length === 0) {
        report(
          'SLACK_CONTENT_ALLOWLIST_EMPTY',
          ch,
          `@slack-channel ${ch.name}: slack.disclosure content requires a non-empty read allow-list in slack.shows or slack.sources`,
        );
      }
      if (allowList.some(entry => entry.trim() === '*')) {
        report(
          'SLACK_CONTENT_WILDCARD',
          ch,
          `@slack-channel ${ch.name}: slack.disclosure content cannot use a wildcard '*' read allow-list`,
        );
      }
    }

    if (answers === 'on' && allowList.length === 0) {
      report(
        'SLACK_ANSWERS_ALLOWLIST_EMPTY',
        ch,
        `@slack-channel ${ch.name}: slack.answers on requires at least one allowed entry in slack.sources or slack.shows`,
      );
    }

    if (rate !== null && !RATE_RE.test(rate)) {
      report(
        'SLACK_RATE_FORMAT',
        ch,
        `@slack-channel ${ch.name}: slack.rate ${JSON.stringify(rate)} must match '<messages-per-hour> <characters-per-message>' with positive integers`,
      );
    }
  }

  findings.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    format: FORMAT,
    revision: snapshot?.revision ?? null,
    ok: findings.length === 0,
    counts: {
      workspaces: workspaces.length,
      channels: channels.length,
      findings: findings.length,
    },
    findings,
  };
}

const handoffOff = () => ({ ...process.env, IA_NO_HANDOFF: '1' });

function refusal(ran, reply) {
  if (ran.error) return ran.error.message;
  if (typeof reply?.message === 'string') return reply.code && !reply.message.startsWith(reply.code) ? `${reply.code}: ${reply.message}` : reply.message;
  if (reply?.ok === true) return ran.status !== 0 ? `it answered ok but exited ${ran.status}` : 'its answer holds no records';
  return (ran.stderr || ran.stdout || '').trim() || `exit ${ran.status}`;
}

function readAdmission(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'validate', '--root', root, '--severity', 'error', '--json'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (reply?.status === 'admitted') return;
  if (reply?.status === 'refused') {
    const errors = reply.counts?.errors;
    const first = (reply.findings ?? []).find(f => f.severity === 'error');
    const named = first ? `, the first ${first.code}: ${first.message}` : '';
    throw new Error(`ia validate refused the workspace with ${errors} error${errors === 1 ? '' : 's'}${named}; a refused workspace is not judged`);
  }
  throw new Error(`ia validate did not admit the workspace: ${refusal(ran, reply)}`);
}

function readRecords(command, root) {
  const ran = spawnSync(command[0], [...command.slice(1), 'records', '--root', root, '--params', '{}'], {
    cwd: root,
    env: handoffOff(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  let reply;
  try {
    reply = JSON.parse(ran.stdout);
  } catch {
    reply = undefined;
  }
  if (!ran.error && ran.status === 0 && reply?.ok === true && Array.isArray(reply.result?.records)) return reply.result;
  throw new Error(`ia records did not return the admitted records: ${refusal(ran, reply)}`);
}

export function runWorkspaceSlackChannelCheck(rawCommand, root = process.cwd()) {
  const command = rawCommand[0] === '--ia' ? rawCommand.slice(1) : rawCommand;
  if (!command.length) {
    throw new Error('usage: node check-slack-channels.mjs <the command words that run ia>, from the workspace root');
  }
  if (!existsSync(join(root, '.ia', 'src'))) {
    throw new Error(`${root} is not an IA workspace root (missing .ia/src)`);
  }
  readAdmission(command, root);
  return checkSlackChannels(readRecords(command, root));
}

function samePath(a, b) {
  const [x, y] = [realpathSync.native(a), realpathSync.native(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const report = runWorkspaceSlackChannelCheck(process.argv.slice(2), process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`check-slack-channels: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
