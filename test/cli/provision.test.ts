import { describe, it, expect } from 'vitest';
import {
  provisionToRolesSettingsYaml,
  provisionToJson,
} from '../../src/cli/provision.js';
import type { JoinProvision } from '../../src/types.js';

describe('provisionToRolesSettingsYaml', () => {
  it('returns comment when membrane_proofs is empty', () => {
    const prov: JoinProvision = { membrane_proofs: {} };
    expect(provisionToRolesSettingsYaml(prov)).toBe(
      '# No membrane proofs returned by joining service\n',
    );
  });

  it('returns comment when membrane_proofs is undefined', () => {
    const prov: JoinProvision = {};
    expect(provisionToRolesSettingsYaml(prov)).toBe(
      '# No membrane proofs returned by joining service\n',
    );
  });

  it('outputs role entry with quoted key and proof', () => {
    const prov: JoinProvision = {
      membrane_proofs: { my_role: 'AQID' },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('"my_role":');
    expect(yaml).toContain('membrane_proof: "AQID"');
    expect(yaml).toContain('type: provisioned');
  });

  it('quotes network_seed to prevent YAML injection', () => {
    const prov: JoinProvision = {
      membrane_proofs: { role: 'proof' },
      dna_modifiers: { network_seed: 'seed: with [special] chars' },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('network_seed: "seed: with [special] chars"');
  });

  it('single-quotes properties JSON to prevent YAML misparse', () => {
    const prov: JoinProvision = {
      membrane_proofs: { role: 'proof' },
      dna_modifiers: { properties: { key: 'value', nested: { a: 1 } } },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    // Properties should be wrapped in single quotes
    expect(yaml).toMatch(/properties: '\{.*\}'/);
  });

  it('handles multiple roles', () => {
    const prov: JoinProvision = {
      membrane_proofs: { role_a: 'proofA', role_b: 'proofB' },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('"role_a":');
    expect(yaml).toContain('"role_b":');
    expect(yaml).toContain('membrane_proof: "proofA"');
    expect(yaml).toContain('membrane_proof: "proofB"');
  });

  it('omits modifiers block when dna_modifiers is absent', () => {
    const prov: JoinProvision = {
      membrane_proofs: { role: 'proof' },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).not.toContain('modifiers');
  });

  it('handles key names with special YAML characters', () => {
    const prov: JoinProvision = {
      membrane_proofs: { 'role:with:colons': 'proof' },
    };
    const yaml = provisionToRolesSettingsYaml(prov);
    expect(yaml).toContain('"role:with:colons":');
  });
});

describe('provisionToJson', () => {
  it('outputs pretty-printed JSON', () => {
    const prov: JoinProvision = {
      membrane_proofs: { role: 'proof' },
      dna_modifiers: { network_seed: 'test-seed' },
    };
    const json = provisionToJson(prov);
    const parsed = JSON.parse(json);
    expect(parsed.membrane_proofs.role).toBe('proof');
    expect(parsed.dna_modifiers.network_seed).toBe('test-seed');
  });

  it('includes trailing newline', () => {
    const prov: JoinProvision = {};
    expect(provisionToJson(prov)).toMatch(/\n$/);
  });
});
