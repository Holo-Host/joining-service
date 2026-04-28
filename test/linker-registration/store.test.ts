import { describe, it, expect, beforeEach } from 'vitest';
import { LinkerRegistrationStore } from '../../src/linker-registration/store.js';
import { createMockKV, makeInvite, makeLinker } from './helpers.js';

describe('LinkerRegistrationStore', () => {
  let kv: ReturnType<typeof createMockKV>;
  let store: LinkerRegistrationStore;

  beforeEach(() => {
    kv = createMockKV();
    store = new LinkerRegistrationStore(kv);
  });

  describe('invites', () => {
    it('creates and retrieves an invite', async () => {
      const invite = makeInvite();
      await store.createInvite(invite);
      const result = await store.getInvite('lnk_test123');
      expect(result).toEqual(invite);
    });

    it('returns null for missing invite', async () => {
      const result = await store.getInvite('lnk_nonexistent');
      expect(result).toBeNull();
    });

    it('lists all invites', async () => {
      await store.createInvite(makeInvite({ token: 'lnk_a' }));
      await store.createInvite(makeInvite({ token: 'lnk_b' }));
      const invites = await store.listInvites();
      expect(invites).toHaveLength(2);
    });

    it('deletes an invite', async () => {
      await store.createInvite(makeInvite());
      await store.deleteInvite('lnk_test123');
      const result = await store.getInvite('lnk_test123');
      expect(result).toBeNull();
    });
  });

  describe('linkers', () => {
    it('puts and retrieves a linker with TTL', async () => {
      const linker = makeLinker();
      await store.putLinker(linker, 600);
      const result = await store.getLinker(linker.pubkey);
      expect(result).toEqual(linker);

      // Verify TTL was passed
      expect(kv.put).toHaveBeenCalledWith(
        `registered_linker:${linker.pubkey}`,
        JSON.stringify(linker),
        { expirationTtl: 600 },
      );
    });

    it('returns null for missing linker', async () => {
      const result = await store.getLinker('nonexistent');
      expect(result).toBeNull();
    });

    it('lists all linkers', async () => {
      await store.putLinker(makeLinker({ pubkey: 'key1' }), 600);
      await store.putLinker(makeLinker({ pubkey: 'key2' }), 600);
      const linkers = await store.listLinkers();
      expect(linkers).toHaveLength(2);
    });

    it('deletes a linker', async () => {
      const linker = makeLinker();
      await store.putLinker(linker, 600);
      await store.deleteLinker(linker.pubkey);
      const result = await store.getLinker(linker.pubkey);
      expect(result).toBeNull();
    });
  });
});
