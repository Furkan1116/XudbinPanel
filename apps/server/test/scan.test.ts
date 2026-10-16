import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, isBaseToolingPath, pickFixedVersion, summarize, type TrivyReport } from "../src/services/scan.js";

const vuln = (id: string, pkg: string, severity: string, extra: Record<string, unknown> = {}) => ({
  VulnerabilityID: id,
  PkgName: pkg,
  InstalledVersion: "1.0.0",
  Severity: severity,
  Title: `${id} title`,
  Description: "x".repeat(400),
  ...extra,
});

const report: TrivyReport = {
  Metadata: { OS: { Family: "debian", Name: "11.8", EOSL: false } },
  Results: [
    {
      Target: "img (debian 11.8)",
      Class: "os-pkgs",
      Type: "debian",
      Vulnerabilities: [
        vuln("CVE-1", "openssl", "CRITICAL", { InstalledVersion: "1.1.1n-0+deb11u4", FixedVersion: "1.1.1w-0+deb11u1" }),
        // Aynı CVE aynı pakette iki kez (farklı katmanlardan): tek sayılır.
        vuln("CVE-1", "openssl", "CRITICAL", { InstalledVersion: "1.1.1n-0+deb11u4", FixedVersion: "1.1.1w-0+deb11u1" }),
        vuln("CVE-2", "zlib1g", "HIGH", { Status: "will_not_fix" }),
        vuln("CVE-9", "libc6", "LOW", { Status: "not_affected" }),
      ],
    },
    {
      Target: "Node.js",
      Class: "lang-pkgs",
      Type: "node-pkg",
      Vulnerabilities: [
        // npm'in kendi içindeki paket: temel imajın parçası.
        vuln("CVE-3", "cross-spawn", "HIGH", { PkgPath: "usr/local/lib/node_modules/npm/node_modules/cross-spawn/package.json", FixedVersion: "7.0.5, 6.0.6", InstalledVersion: "7.0.3" }),
        // Uygulamanın bağımlılığı: virgüllü listeden kurulu sürüme uyan en küçük düzeltme, CVE'ler arasında en büyüğü.
        vuln("CVE-4", "express", "HIGH", { PkgPath: "app/node_modules/express/package.json", InstalledVersion: "4.17.1", FixedVersion: "4.19.2, 5.0.0-beta.3" }),
        vuln("CVE-5", "express", "MEDIUM", { PkgPath: "app/node_modules/express/package.json", InstalledVersion: "4.17.1", FixedVersion: "4.20.0" }),
        // Aynı CVE, aynı paket, başka bir yolda: tekrar sayılmaz.
        vuln("CVE-4", "express", "HIGH", { PkgPath: "app/other/node_modules/express/package.json", InstalledVersion: "4.17.1", FixedVersion: "4.19.2" }),
      ],
    },
    {
      Target: "Python",
      Class: "lang-pkgs",
      Type: "python-pkg",
      Vulnerabilities: [vuln("CVE-6", "pip", "MEDIUM", { PkgPath: "usr/local/lib/python3.11/site-packages/pip-23.0.1.dist-info/METADATA", FixedVersion: "23.3" })],
    },
  ],
};

test("tarama: sürüm karşılaştırma ve düzeltme sürümü seçimi", () => {
  assert.ok(compareVersions("4.19.2", "4.17.1") > 0);
  assert.ok(compareVersions("v1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("1.1.1w-0+deb11u1", "1.1.1n-0+deb11u4") > 0);
  assert.equal(compareVersions("2.0", "2.0"), 0);
  assert.equal(pickFixedVersion("7.0.5, 6.0.6", "7.0.3"), "7.0.5");
  assert.equal(pickFixedVersion("7.0.5, 6.0.6", "6.0.5"), "6.0.6");
  assert.equal(pickFixedVersion("1.2.0", "1.3.0"), "1.2.0");
});

test("tarama: temel imaj araçları yol kuralıyla ayrılır", () => {
  assert.ok(isBaseToolingPath("usr/local/lib/node_modules/npm/node_modules/semver/package.json"));
  assert.ok(isBaseToolingPath("usr/local/lib/node_modules/corepack/package.json"));
  assert.ok(isBaseToolingPath("usr/lib/python3/dist-packages/setuptools/__init__.py"));
  assert.ok(isBaseToolingPath("usr/local/lib/python3.12/site-packages/wheel-0.41.dist-info/METADATA"));
  assert.ok(isBaseToolingPath("opt/yarn-v1.22.19/package.json"));
  assert.ok(!isBaseToolingPath("app/node_modules/npm/package.json"));
  assert.ok(!isBaseToolingPath("usr/local/lib/python3.11/site-packages/django/__init__.py"));
  assert.ok(!isBaseToolingPath(undefined));
});

test("tarama: rapor gruplara ayrılır, tekrarlar elenir, durum belirlenir", () => {
  const s = summarize(report);
  assert.equal(s.v, 2);
  assert.equal(s.status, "acil");
  assert.deepEqual(s.counts, { critical: 1, high: 3, medium: 2, low: 0, unknown: 0 });
  assert.deepEqual(s.os, { family: "debian", name: "11.8", eosl: false });

  assert.deepEqual(s.baseFix.map((p) => p.name).sort(), ["cross-spawn", "openssl", "pip"]);
  const openssl = s.baseFix.find((p) => p.name === "openssl")!;
  assert.equal(openssl.cveCount, 1);
  assert.equal(openssl.fixed, "1.1.1w-0+deb11u1");
  assert.equal(openssl.ecosystem, "debian");
  assert.equal(s.baseFix.find((p) => p.name === "cross-spawn")!.fixed, "7.0.5");
  assert.equal(s.baseFix[0].name, "openssl"); // önce en önemlisi

  assert.equal(s.appFix.length, 1);
  const npm = s.appFix[0];
  assert.equal(npm.ecosystem, "npm");
  assert.equal(npm.packages.length, 1);
  const express = npm.packages[0];
  assert.equal(express.source, "app");
  assert.equal(express.cveCount, 2);
  assert.equal(express.fixed, "4.20.0");
  assert.equal(express.maxSeverity, "HIGH");
  assert.equal(npm.command, "npm install express@4.20.0");
  assert.ok(express.cves[0].description.length <= 200);
  assert.equal(express.cves[0].url, "https://avd.aquasec.com/nvd/cve-4");

  assert.deepEqual(s.noFix.map((p) => p.name), ["zlib1g"]);
  assert.ok(![...s.baseFix, ...s.noFix].some((p) => p.name === "libc6"), "not_affected atlanır");
  assert.deepEqual(s.groups.base, { critical: 1, high: 1, medium: 1, low: 0, unknown: 0 });
  assert.equal(s.critical, 1);
  assert.equal(s.high, 3);
  assert.equal(s.fixable, 3);
});

test("tarama: durum kuralları", () => {
  assert.equal(summarize({}).status, "temiz");
  assert.equal(summarize({ Results: [{ Target: "x", Class: "os-pkgs", Type: "alpine", Vulnerabilities: [vuln("CVE-7", "musl", "MEDIUM")] }] }).status, "temiz");
  assert.equal(summarize({ Results: [{ Target: "x", Class: "os-pkgs", Type: "alpine", Vulnerabilities: [vuln("CVE-7", "musl", "HIGH")] }] }).status, "dikkat");
  assert.equal(summarize({ Metadata: { OS: { Family: "debian", Name: "9", EOSL: true } } }).status, "dikkat");
  const pip = summarize({ Results: [{ Target: "Python", Class: "lang-pkgs", Type: "pip", Vulnerabilities: [vuln("CVE-8", "django", "HIGH", { FixedVersion: "4.2.8" })] }] });
  assert.equal(pip.appFix[0].command, "pip install -U 'django>=4.2.8'");
});
