import assert from "node:assert/strict";
import { test } from "node:test";
import { formatHostKey, hostKeyFingerprint, hostVerifier } from "../src/services/ssh.js";

const wire = (type: string, data: string) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.length);
  return Buffer.concat([len, t, Buffer.from(data)]);
};

test("SSH sunucu anahtarı: ilk görülen kaydedilir, değişirse bağlantı reddedilir (D7)", () => {
  const a = wire("ssh-ed25519", "anahtar-a");
  const b = wire("ssh-ed25519", "anahtar-b");
  let saved: string | null = null;
  assert.equal(hostVerifier({ hostKey: null, onNewHostKey: (k) => (saved = k) })(a), true);
  assert.equal(saved, formatHostKey(a));
  assert.equal(hostVerifier({ hostKey: saved })(a), true);
  assert.equal(hostVerifier({ hostKey: saved })(b), false);
  assert.match(hostKeyFingerprint(saved!), /^SHA256:[A-Za-z0-9+/]+$/);
});
