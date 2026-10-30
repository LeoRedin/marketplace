#!/usr/bin/env node
import { executeDesign, INPUT_LIMIT } from './lib/design-client.mjs';

async function main() {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > INPUT_LIMIT) throw new Error('input-too-large');
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid-json'); }
  return executeDesign(input);
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  const messages = {
    'input-too-large': 'Input exceeds the supported size.',
    'invalid-json': 'Input must be valid JSON.',
    'invalid-input': 'Input does not match a supported operation.',
    'invalid-pins': 'Kit and agent pins must be valid strings and a supported pair.',
    'invalid-workspace': 'Workspace identifier is invalid.',
    'invalid-run': 'Run identifier is invalid.',
    'invalid-origin': 'The configured API origin is invalid.',
    'invalid-binding': 'The operator binding must be a valid external absolute file.',
    'untrusted-origin': 'The API origin does not match the operator binding.',
    'hosted-unconfigured': 'No operator hosted design binding is configured.',
    'workspace-binding-mismatch': 'The workspace does not match the operator binding.',
    'workspace-binding-required': 'Bind the created private workspace before running agents.',
    'missing-token': 'An access token is required.',
    'invalid-timeout': 'Timeout is invalid.',
    'response-too-large': 'The service response exceeds the supported size.',
    'invalid-response': 'The service response is invalid.',
    'invalid-discovery': 'The discovery response is invalid.',
    'provenance-mismatch': 'The response does not match the requested provenance.',
    'invalid-agents': 'The agent response is invalid.',
    'agent-unavailable': 'The selected agent is unavailable.',
    'invalid-result': 'The run result is invalid.',
    'request-refused': 'The service refused the request.',
    'access-refused': 'The service refused access.',
    'not-found': 'The requested service resource was not found.',
    'conflict': 'The request conflicts with the current service state.',
    'rate-limited': 'The service rate limit was reached.',
    'service-unavailable': 'The service is temporarily unavailable.',
    'service-refused': 'The service refused the operation.',
    'timeout': 'The service request timed out.',
    'transport-refused': 'The service connection failed.',
    'client-failure': 'The design client failed.',
  };
  const candidate = error?.code ?? error?.message;
  const code = Object.hasOwn(messages, candidate) ? candidate : 'client-failure';
  process.stdout.write(`${JSON.stringify({ error: { code, message: messages[code] } })}\n`);
  const usage = new Set(['input-too-large', 'invalid-json', 'invalid-input', 'invalid-pins', 'invalid-workspace', 'invalid-run', 'invalid-origin', 'invalid-binding', 'untrusted-origin', 'hosted-unconfigured', 'workspace-binding-mismatch', 'workspace-binding-required', 'missing-token', 'invalid-timeout']);
  process.exitCode = usage.has(code) ? 2 : 1;
}
