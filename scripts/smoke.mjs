// smoke.mjs — smoke-test headless do front (camada #3 da blindagem anti-regressão).
// Carrega a página SERVIDA localmente num Chromium headless, espera o boot e FALHA (exit 1)
// se houver ERRO DE JS ou se o render básico quebrar (dados não carregam, bracket vazio,
// mata-mata sem cruzamento). Pega a regressão de RENDER — que o `node --check` (sintaxe) NÃO
// pega. Roda no update.yml ANTES do deploy, só em push de front (não no cron de dados).
import { chromium } from "playwright";

const URL = process.env.SMOKE_URL || "http://localhost:8099";
const browser = await chromium.launch();
const page = await browser.newPage();
const jsErrors = [];
page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
page.on("pageerror", (e) => jsErrors.push(String(e)));

try {
  await page.goto(URL, { waitUntil: "load", timeout: 20000 });
  await page.waitForFunction(
    () => typeof MATCHES !== "undefined" && MATCHES.length > 0,
    { timeout: 15000 }
  );
} catch (e) {
  console.error("SMOKE FALHOU — a pagina nao carregou/bootou:", String(e));
  if (jsErrors.length) console.error("  erros de JS:", jsErrors.slice(0, 5).join(" | "));
  await browser.close();
  process.exit(1);
}

const r = await page.evaluate(() => ({
  matches: MATCHES.length,
  ko: MATCHES.filter((m) => !m.group).length,
  koSemPh: MATCHES.filter((m) => !m.group && (!m.placeholderA || !m.placeholderB)).length,
  bracket: (document.getElementById("knockout")?.innerHTML || "").length,
}));
await browser.close();

const problems = [];
if (jsErrors.length) problems.push("erro de JS no boot: " + jsErrors.slice(0, 3).join(" | "));
if (r.matches !== 104) problems.push(`MATCHES=${r.matches} (esperado 104)`);
if (r.ko !== 32) problems.push(`KO=${r.ko} (esperado 32)`);
if (r.koSemPh > 0) problems.push(`${r.koSemPh} KO sem cruzamento (bracket quebrado)`);
if (r.bracket < 100) problems.push(`bracket vazio (innerHTML=${r.bracket})`);

if (problems.length) {
  console.error("SMOKE FALHOU:");
  problems.forEach((p) => console.error(" -", p));
  process.exit(1);
}
console.log(`OK — front carrega sem erro de JS, ${r.matches} jogos, ${r.ko} KO com cruzamento, bracket renderiza`);
