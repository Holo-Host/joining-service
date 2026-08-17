import { describe, it, expect } from 'vitest';
import {
  provisionToRolesSettingsYaml,
  provisionToJson,
} from '../../src/cli/provision.js';
import type { JoinProvision } from '../../src/types.js';

describe('provisionToRolesSettingsYaml', () => {
  it('returns comment when roles is undefined', () => {
    const prov: JoinProvision = {};
    expect(provisionToRolesSettingsYaml(prov)).toBe(
      '# No membrane proofs returned by joining service\n',
    );
  });

  it('falls back to the no-proofs comment when roles is empty', () => {
    const yaml = provisionToRolesSettingsYaml({ roles: {} });
    expect(yaml).toBe('# No membrane proofs returned by joining service\n');
  });

  it('falls back to the no-proofs comment when a role has neither a proof nor modifiers', () => {
    const yaml = provisionToRolesSettingsYaml({ roles: { main: {} } });
    expect(yaml).toBe('# No membrane proofs returned by joining service\n');
    expect(yaml).not.toContain('"main":');
  });

  it('outputs role entry with quoted key and proof', () => {
    const prov: JoinProvision = {
      roles: { my_role: { membrane_proof: 'AQID' } },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('"my_role":');
    expect(yaml).toContain('membrane_proof: "AQID"');
    expect(yaml).toContain('type: provisioned');
  });

  it('quotes network_seed to prevent YAML injection', () => {
    const prov: JoinProvision = {
      roles: {
        role: {
          membrane_proof: 'proof',
          dna_modifiers: { network_seed: 'seed: with [special] chars' },
        },
      },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('network_seed: "seed: with [special] chars"');
  });

  it('single-quotes properties JSON to prevent YAML misparse', () => {
    const prov: JoinProvision = {
      roles: {
        role: {
          membrane_proof: 'proof',
          dna_modifiers: { properties: { key: 'value', nested: { a: 1 } } },
        },
      },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    // Properties should be wrapped in single quotes
    expect(yaml).toMatch(/properties: '\{.*\}'/);
  });

  it('handles multiple roles', () => {
    const prov: JoinProvision = {
      roles: {
        role_a: { membrane_proof: 'proofA' },
        role_b: { membrane_proof: 'proofB' },
      },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('"role_a":');
    expect(yaml).toContain('"role_b":');
    expect(yaml).toContain('membrane_proof: "proofA"');
    expect(yaml).toContain('membrane_proof: "proofB"');
  });

  it('omits modifiers block when dna_modifiers is absent', () => {
    const prov: JoinProvision = {
      roles: { role: { membrane_proof: 'proof' } },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).not.toContain('modifiers');
  });

  it('handles role names with special YAML characters', () => {
    const prov: JoinProvision = {
      roles: { 'role:with:colons': { membrane_proof: 'proof' } },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('"role:with:colons":');
  });

  it('prefers per-role data with distinct modifiers per role', () => {
    const yaml = provisionToRolesSettingsYaml({
      roles: {
        main: {
          membrane_proof: 'cHJvb2Zh',
          dna_modifiers: { network_seed: 'seed-main' },
        },
        chat: {
          membrane_proof: 'cHJvb2Zi',
          dna_modifiers: { properties: { progenitor: 'uhCAkX' } },
        },
      },
    });
    expect(yaml).toContain('"main":');
    expect(yaml).toContain('network_seed: "seed-main"');
    expect(yaml).toContain('"chat":');
    expect(yaml).toContain(`properties: '{"progenitor":"uhCAkX"}'`);
    // main's modifiers must not leak into chat
    const chatBlock = yaml.slice(yaml.indexOf('"chat":'));
    expect(chatBlock).not.toContain('seed-main');
  });

  it('emits a role entry with modifiers even when its proof is absent', () => {
    const yaml = provisionToRolesSettingsYaml({
      roles: { main: { dna_modifiers: { network_seed: 's' } } },
    });
    expect(yaml).toContain('"main":');
    expect(yaml).toContain('network_seed: "s"');
    expect(yaml).not.toContain('membrane_proof');
  });

  it('omits the modifiers header for a role with a proof and empty modifiers', () => {
    const yaml = provisionToRolesSettingsYaml({
      roles: { main: { membrane_proof: 'cHJvb2Y=', dna_modifiers: {} } },
    });
    expect(yaml).toContain('"main":');
    expect(yaml).not.toContain('modifiers:');
  });
});

describe('provisionToJson', () => {
  it('outputs pretty-printed JSON', () => {
    const prov: JoinProvision = {
      roles: {
        role: { membrane_proof: 'proof', dna_modifiers: { network_seed: 'test-seed' } },
      },
    };
    const json = provisionToJson(prov);
    const parsed = JSON.parse(json);
    expect(parsed.roles.role.membrane_proof).toBe('proof');
    expect(parsed.roles.role.dna_modifiers.network_seed).toBe('test-seed');
  });

  it('includes trailing newline', () => {
    const prov: JoinProvision = {};
    expect(provisionToJson(prov)).toMatch(/\n$/);
  });
});
