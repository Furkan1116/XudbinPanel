import { type BuildPlan, finalChain, lastInChain, startText } from "./build.js";
import { FindingList } from "./findings.js";
import { whereText } from "./node.js";
import type { Note, PreflightContext, PreflightFinding } from "./types.js";
import { joinRel, type SourceTree } from "./tree.js";

/**
 * Dockerfile ve port kontrolü. Dockerfile bulguları yalnız depodaki Dockerfile gerçekten kullanılıyorsa üretilir;
 * framework ön ayarında Dockerfile'ı panel üretir ve bu grup yalnız dinlenen adrese bakar.
 */

const LOCAL_LISTEN = /(?:--bind|-b|--host|-H|--hostname|--listen|--address|--addr)(?:=|\s+)["']?(127\.0\.0\.1|localhost)\b|\brunserver\s+(127\.0\.0\.1|localhost)\b|\bHOST(?:NAME)?=(127\.0\.0\.1|localhost)\b/;

/** İmaj adında etiket ya da özet (digest) var mı; "latest" etiketsiz sayılır. */
export function unpinnedImage(image: string) {
  if (!image || image.includes("$") || image.toLowerCase() === "scratch") return false;
  if (image.includes("@sha256:")) return false;
  const last = image.split("/").at(-1)!;
  const tag = last.includes(":") ? last.split(":").at(-1)! : "";
  return !tag || tag === "latest";
}

export function checkDocker(tree: SourceTree, plan: BuildPlan, ctx: PreflightContext, notes: Note[]): PreflightFinding[] {
  const list = new FindingList("docker");
  const df = plan.dockerfile;

  if (!df) {
    if (plan.frameworkId && plan.frameworkId !== "dockerfile") {
      notes.push({ text: "Dockerfile panel tarafından üretilecek ({name}); Dockerfile kontrolleri atlandı.", vars: { name: plan.frameworkName ?? plan.frameworkId } });
      const own = joinRel(plan.context, ctx.dockerfilePath || "Dockerfile");
      if (tree.has(own)) {
        list.add({
          id: "docker-unused",
          level: "info",
          title: "Depodaki Dockerfile kullanılmıyor",
          detail: "Uygulama {name} ön ayarıyla derleniyor; {file} yok sayılır.",
          fix: "Kendi Dockerfile'ını kullanmak istiyorsan uygulama ayarlarından framework olarak Dockerfile seç.",
          vars: { name: plan.frameworkName ?? plan.frameworkId, file: own },
          file: own,
        });
      }
    } else if (plan.frameworkId === "dockerfile") {
      list.add({ id: "docker-missing", level: "warning", title: "Dockerfile bulunamadı", detail: "Uygulama depodaki Dockerfile ile derleniyor ama dosya okunamadı ya da yok; derleme başarısız olur.", file: joinRel(plan.context, ctx.dockerfilePath || "Dockerfile") });
    }
  } else {
    const chain = finalChain(df);
    const finalStage = df.stages.at(-1);
    const user = lastInChain(df, "USER");
    // distroless ":nonroot" gibi imajlar zaten root olmayan kullanıcıyla gelir.
    const nonRootBase = chain.some((i) => /nonroot|rootless/i.test(df.stages[i]!.image));
    if ((!user && !nonRootBase) || (user && /^(root|0)(:|$)/.test(user.args.trim()))) {
      list.add({
        id: "docker-root",
        level: "warning",
        title: user ? "Konteyner root kullanıcısıyla çalışıyor" : "Dockerfile'da USER yok",
        detail: "Son aşama root olarak çalışır; uygulamadaki bir açık konteynerin tamamını ele geçirmeye yeter.",
        fix: "Son aşamaya kullanıcı ekleyip geç: RUN useradd -m app ve USER app (Alpine'de adduser -D app).",
        file: df.rel,
        line: user?.line ?? finalStage?.line,
      });
    }
    for (const stage of df.stages) {
      const isAlias = df.stages.some((s) => s.alias && s.alias.toLowerCase() === stage.image.toLowerCase());
      if (isAlias || !unpinnedImage(stage.image)) continue;
      list.add({
        id: "docker-unpinned",
        level: "warning",
        title: "Taban imajın sürümü sabit değil: {image}",
        detail: "Etiketsiz ya da latest imaj her derlemede başka bir sürüm getirebilir; dün çalışan derleme bugün kırılabilir.",
        fix: "Sürüm etiketi yaz (ör. python:3.12-slim, node:22-alpine).",
        vars: { image: stage.image },
        file: df.rel,
        line: stage.line,
      });
    }
    const exposed = df.instrs
      .filter((i) => i.op === "EXPOSE" && chain.includes(i.stage))
      .flatMap((i) => i.args.split(/\s+/))
      .map((p) => Number(p.split("/")[0]))
      .filter((p) => Number.isInteger(p) && p > 0);
    if (exposed.length && !exposed.includes(ctx.port)) {
      list.add({
        id: "docker-expose",
        level: "warning",
        title: "EXPOSE paneldeki portla uyuşmuyor",
        detail: "Dockerfile {exposed} portunu açıyor, panel {port} portunu bekliyor. Uygulama başka portu dinlerse sağlık kontrolü geçmez.",
        fix: "Uygulama ayarlarından portu düzelt ya da uygulamayı PORT değişkenini dinleyecek şekilde başlat.",
        vars: { exposed: exposed.join(", "), port: ctx.port },
        file: df.rel,
        line: df.instrs.find((i) => i.op === "EXPOSE" && chain.includes(i.stage))?.line,
      });
    }
    for (const add of df.instrs.filter((i) => i.op === "ADD" && /(^|\s)https?:\/\//.test(i.args))) {
      list.add({
        id: "docker-add-url",
        level: "warning",
        title: "ADD ile uzak adresten dosya indiriliyor",
        detail: "ADD uzak dosyanın bütünlüğünü doğrulamaz; adres değişirse derlemeye başka bir dosya girer.",
        fix: "RUN curl -fsSL ... ile indirip özetini (sha256sum -c) doğrula ya da dosyayı depoya ekle.",
        file: df.rel,
        line: add.line,
      });
    }
    const copyAll = df.instrs.find((i) => (i.op === "COPY" || i.op === "ADD") && /^(--\S+\s+)*\.\/?\s+\S+$/.test(i.args));
    if (copyAll && !tree.has(joinRel(plan.context, ".dockerignore"))) {
      list.add({
        id: "docker-copy-all",
        level: "warning",
        title: "COPY . . var ama .dockerignore yok",
        detail: "Derleme klasöründeki her şey (.env, yerel veritabanı, node_modules, .git dışındaki her dosya) imaja kopyalanır.",
        fix: "Derleme klasörüne .env, node_modules, venv, *.sqlite3 gibi satırlar içeren bir .dockerignore ekle.",
        file: df.rel,
        line: copyAll.line,
      });
    }
  }

  const start = plan.start;
  const listen = start ? startText(start).match(LOCAL_LISTEN) : null;
  if (start && listen) {
    list.add({
      id: "docker-localhost",
      level: "warning",
      title: "Sunucu yalnız {addr} adresini dinliyor",
      detail: "{where} sunucuyu {addr} adresinde başlatıyor; konteyner dışından (panelin ters vekili dahil) ulaşılamaz.",
      fix: "0.0.0.0 adresini dinle (ör. --bind 0.0.0.0:$PORT).",
      vars: { addr: listen[1] ?? listen[2] ?? listen[3] ?? "127.0.0.1", where: whereText(start.source, start.file) },
      file: start.file,
      line: start.line,
    });
  }
  return list.result();
}
