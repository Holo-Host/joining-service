#!/usr/bin/env node
/**
 * joining-cli — CLI for headless Holochain node provisioning.
 *
 * Commands:
 *   provision              Join a network and output roles-settings YAML
 *   hc-auth authenticate   Generate conductor auth material via lair signing
 *   hc-auth check          Check agent state on hc-auth server
 *   hc-auth register       Admin-side register and authorize an agent
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  provision,
  provisionToRolesSettingsYaml,
  provisionToJson,
} from './provision.js';
import {
  authenticate,
  formatAuthOutput,
  check,
  register,
} from './hc-auth.js';
import type { LairSignerOptions } from './lair.js';

// ---- Arg parsing helpers ----

function die(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(3);
}

function env(name: string): string | undefined {
  return process.env[name];
}

function requireArg(value: string | undefined, name: string): string {
  if (value === undefined || value === '') die(`${name} is required`);
  return value;
}

function readPassphrase(path: string): string {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch (err) {
    die(`Cannot read passphrase file ${path}: ${(err as Error).message}`);
  }
}

function parsePollTimeout(val: string): number {
  const n = parseInt(val, 10);
  if (isNaN(n) || n <= 0) die('--poll-timeout must be a positive integer');
  return n;
}

function buildLairOptions(values: Record<string, unknown>): LairSignerOptions | undefined {
  const lairUrl = values['lair-url'] as string | undefined;
  if (!lairUrl) return undefined;

  const passphraseFile = values['lair-passphrase-file'] as string | undefined;
  const passphrase = passphraseFile
    ? readPassphrase(passphraseFile)
    : (env('LAIR_PASSPHRASE') ?? die('--lair-passphrase-file or LAIR_PASSPHRASE env is required when using --lair-url'));

  return {
    lairUrl,
    passphrase,
    keyutilBin: values['keyutil-bin'] as string | undefined,
  };
}

// ---- Usage ----

const USAGE = `\
joining-cli — Headless Holochain node provisioning tool

Usage:
  joining-cli provision [options]
  joining-cli hc-auth authenticate [options]
  joining-cli hc-auth check [options]
  joining-cli hc-auth register [options]

Commands:
  provision              Join a network, get membrane proofs, output roles-settings YAML
  hc-auth authenticate   GET /now → sign → PUT /authenticate → output auth material
  hc-auth check          Check agent registration state on hc-auth server
  hc-auth register       Admin-side: register and authorize an agent

Common options:
  --agent-key <key>             AgentPubKey in HoloHash format (uhCAk...)
  --lair-url <url>              Lair IPC connection URL
  --lair-passphrase-file <path> File containing lair passphrase
  --keyutil-bin <path>          Path to holo-keyutil binary (default: in PATH)
  --quiet                       Suppress progress output

Provision options:
  --service-url <url>           Joining service base URL
  --discover <domain>           Auto-discover service via .well-known
  --invite-code <code>          Invite code (also reads INVITE_CODE env)
  --email <address>             Email for email_code auth
  --network <id>                happ_id of a registered network to join
  --output <path>               Output file (default: stdout)
  --format <yaml|json>          Output format (default: yaml)
  --poll-timeout <seconds>      Max wait for async challenges (default: 300)

hc-auth authenticate options:
  --hc-auth-url <url>           hc-auth server base URL
  --output-format <fmt>         base64 | json | conductor-yaml-patch (default: base64)

hc-auth check/register options:
  --hc-auth-url <url>           hc-auth server base URL
  --hc-auth-token <token>       Admin API bearer token (also reads HC_AUTH_TOKEN env)
`;

// ---- Main ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const command = args[0];

  if (command === 'provision') {
    await runProvision(args.slice(1));
  } else if (command === 'hc-auth') {
    const subcommand = args[1];
    if (!subcommand || subcommand === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    await runHcAuth(subcommand, args.slice(2));
  } else {
    die(`Unknown command: ${command}. Run with --help for usage.`);
  }
}

async function runProvision(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'service-url': { type: 'string' },
      'discover': { type: 'string' },
      'agent-key': { type: 'string' },
      'lair-url': { type: 'string' },
      'lair-passphrase-file': { type: 'string' },
      'keyutil-bin': { type: 'string' },
      'invite-code': { type: 'string' },
      'email': { type: 'string' },
      'network': { type: 'string' },
      'output': { type: 'string' },
      'format': { type: 'string' },
      'poll-timeout': { type: 'string' },
      'quiet': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const agentKey = requireArg(values['agent-key'] as string, '--agent-key');

  // Build claims from options
  const claims: Record<string, string> = {};
  const inviteCode = (values['invite-code'] as string) ?? env('INVITE_CODE');
  if (inviteCode) claims.invite_code = inviteCode;
  const email = values['email'] as string;
  if (email) claims.email = email;

  const lair = buildLairOptions(values as Record<string, unknown>);
  const format = (values['format'] as string) ?? 'yaml';
  if (format !== 'yaml' && format !== 'json') {
    die(`--format must be yaml or json, got: ${format}`);
  }

  const prov = await provision({
    serviceUrl: values['service-url'] as string,
    discover: values['discover'] as string,
    agentKey,
    network: values['network'] as string,
    lair,
    claims: Object.keys(claims).length > 0 ? claims : undefined,
    format: format as 'yaml' | 'json',
    quiet: values['quiet'] as boolean,
    pollTimeout: values['poll-timeout'] ? parsePollTimeout(values['poll-timeout'] as string) : undefined,
  });

  const output = format === 'yaml'
    ? provisionToRolesSettingsYaml(prov)
    : provisionToJson(prov);

  const outputPath = values['output'] as string;
  if (outputPath) {
    writeFileSync(outputPath, output);
    if (!values['quiet']) {
      process.stderr.write(`Written to ${outputPath}\n`);
    }
  } else {
    process.stdout.write(output);
  }
}

async function runHcAuth(subcommand: string, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'hc-auth-url': { type: 'string' },
      'hc-auth-token': { type: 'string' },
      'agent-key': { type: 'string' },
      'lair-url': { type: 'string' },
      'lair-passphrase-file': { type: 'string' },
      'keyutil-bin': { type: 'string' },
      'output-format': { type: 'string' },
      'output': { type: 'string' },
      'quiet': { type: 'boolean', default: false },
    },
    strict: true,
  });

  const hcAuthUrl = requireArg(values['hc-auth-url'] as string, '--hc-auth-url');
  const agentKey = requireArg(values['agent-key'] as string, '--agent-key');

  switch (subcommand) {
    case 'authenticate': {
      const lair = buildLairOptions(values as Record<string, unknown>);
      if (!lair) die('--lair-url is required for hc-auth authenticate');

      const result = await authenticate({
        hcAuthUrl,
        agentKey,
        lair,
      });

      const fmt = (values['output-format'] as string) ?? 'base64';
      if (fmt !== 'base64' && fmt !== 'json' && fmt !== 'conductor-yaml-patch') {
        die(`--output-format must be base64, json, or conductor-yaml-patch, got: ${fmt}`);
      }
      const output = formatAuthOutput(result, fmt);

      const outputPath = values['output'] as string;
      if (outputPath) {
        writeFileSync(outputPath, output + '\n');
      } else {
        process.stdout.write(output + '\n');
      }
      break;
    }

    case 'check': {
      const token = (values['hc-auth-token'] as string) ?? env('HC_AUTH_TOKEN');
      const output = await check({ hcAuthUrl, apiToken: token, agentKey });
      process.stdout.write(output + '\n');
      break;
    }

    case 'register': {
      const token = (values['hc-auth-token'] as string) ?? env('HC_AUTH_TOKEN');
      if (!token) die('--hc-auth-token or HC_AUTH_TOKEN env is required');

      const output = await register({ hcAuthUrl, apiToken: token, agentKey });
      process.stdout.write(output + '\n');
      break;
    }

    default:
      die(`Unknown hc-auth subcommand: ${subcommand}. Use authenticate, check, or register.`);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
