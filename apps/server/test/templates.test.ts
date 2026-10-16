import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { composeHostAccessIssues } from "../src/services/compose-policy.js";
import { TEMPLATES, templateEnv } from "../src/services/templates.js";

test("şablonlar geçerli, güvenli ve tutarlı", () => {
  const ids = new Set<string>();
  for (const t of TEMPLATES) {
    assert.ok(!ids.has(t.id), `${t.id} tekrar ediyor`);
    ids.add(t.id);
    const doc = YAML.parse(t.compose) as { services: Record<string, { image?: string }> };
    assert.ok(doc.services[t.service], `${t.id}: yönlendirilen servis yok`);
    assert.deepEqual(composeHostAccessIssues(doc), [], `${t.id}: sunucu erişimi istememeli`);
    for (const svc of Object.values(doc.services)) assert.match(svc.image ?? "", /:[\w.-]+$/, `${t.id}: imaj etiketi sabit olmalı`);
    // Compose dosyasındaki her ${AD} şablon değişkenlerinde tanımlı olmalı ($$ kaçışları hariç).
    const used = [...t.compose.replace(/\$\$/g, "").matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]!);
    const defined = new Set(t.vars.map((v) => v.key));
    for (const u of used) assert.ok(defined.has(u), `${t.id}: \${${u}} tanımlı değil`);
    const env = templateEnv(t, (n) => "x".repeat(n));
    for (const v of t.vars) if (v.generate) assert.ok((env[v.key] ?? "").length >= 24, `${t.id}: ${v.key} üretilmedi`);
  }
  assert.ok(TEMPLATES.length >= 12);
});
