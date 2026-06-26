const MATCH_DURATION_MS = 2 * 60 * 60 * 1000;
// Janela em que um jogo continua sendo o "foco" do painel: cobre 90' + acréscimos
// + prorrogação + pênaltis (mata-mata) sem o jogo "sumir" cedo demais.
const FOCAL_WINDOW_MS = 3.5 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_000_000_000;
const BR_TZ = "America/Sao_Paulo";
const PT_TZ = "Europe/Lisbon";
// Endpoint de UM jogo específico (filtra de verdade por idStage/idMatch e traz
// MatchStatus/MatchTime/pênaltis). O antigo calendar?...&idMatch=X&count=1 NÃO
// filtrava — devolvia sempre o 1º jogo do calendário (bug do placar errado).
const FIFA_MATCH_API = "https://api.fifa.com/api/v3/live/football/17/285023";

const el = {
  nextTitle: document.querySelector("#next-title"),
  matchState: document.querySelector("#match-state"),
  dayStrip: document.querySelector("#day-strip"),
  scoreline: document.querySelector("#scoreline"),
  predict: document.querySelector("#predict"),
  cityVenue: document.querySelector("#city-venue"),
  temp: document.querySelector("#temp"),
  when: document.querySelector("#when"),
  liveStreams: document.querySelector("#live-streams"),
  liveStreamsLabel: document.querySelector("#live-streams-label"),
  streamLinks: document.querySelector("#stream-links"),
  player: document.querySelector("#player"),
  playerIframe: document.querySelector("#player-iframe"),
  playerTitle: document.querySelector("#player-title"),
  playerClose: document.querySelector("#player-close"),
  playerOpen: document.querySelector("#player-open"),
  regionButtons: [...document.querySelectorAll(".region-toggle button")],
  broadcastBr: document.querySelector("#broadcast-br"),
  broadcastPt: document.querySelector("#broadcast-pt"),
  broadcastTitle: document.querySelector("#broadcast-title"),
  matchList: document.querySelector("#match-list"),
  resultList: document.querySelector("#result-list"),
  standings: document.querySelector("#standings"),
  standingsPhase: document.querySelector("#standings-phase"),
  knockout: document.querySelector("#knockout"),
  resultPager: document.querySelector("#result-pager"),
  enableAlerts: document.querySelector("#enable-alerts"),
  testAlert: document.querySelector("#test-alert"),
  downloadCalendar: document.querySelector("#download-calendar"),
  alertStatus: document.querySelector("#alert-status"),
  filters: [...document.querySelectorAll(".segmented button")]
};

let selectedMatchId = null;
const liveById = {}; // matchId -> { status, home, away, homePen, awayPen, time } da FIFA — PERSISTE (o sinal de "encerrado" não se perde)
let liveScorers = []; // artilheiros do jogo ao vivo atualmente consultado
let liveScorersId = null; // de qual jogo são os liveScorers acima

let MATCHES = [];

function utcDate(match) {
  const [year, month, day] = match.date.split("-").map(Number);
  const [hour, minute] = match.time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - match.offset, minute));
}

function formatTime(date, timeZone, locale) {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone
  }).format(date);
}

function shortDate(date, timeZone, locale) {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    timeZone
  }).format(date);
}

function two(value) {
  return String(value).padStart(2, "0");
}

function formatDistance(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${two(hours)}:${two(minutes)}:${two(seconds)}`;
  return `${two(hours)}:${two(minutes)}:${two(seconds)}`;
}

// Contagem p/ o badge, COM segundos (dá dinamismo): "4:48:23" / "48:23".
// A dias de distância vira "3d 4h" (segundos ali seriam ruído).
function compactCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}:${two(m)}:${two(s)}`;
  return `${m}:${two(s)}`;
}

// Hora compacta no fuso, 2 dígitos (lê como relógio): "02h" / "13h" / "13h30".
function compactHour(date, timeZone, locale) {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone,
  }).formatToParts(date);
  const h = two(parseInt(parts.find((p) => p.type === "hour").value, 10));
  const m = parts.find((p) => p.type === "minute").value;
  return m === "00" ? `${h}h` : `${h}h${m}`;
}

// Linha única de data + horários: "seg, 15/06 · 13h BR · 17h PT" (marca (+1) se em PT já é o dia seguinte).
function whenLine(date) {
  const wd = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: BR_TZ }).format(date).replace(/\.$/, "");
  const dmBr = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: BR_TZ }).format(date);
  const dmPt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: PT_TZ }).format(date);
  const dayKey = (tz) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).format(date);
  // Quando em Portugal já é o dia seguinte (jogos de madrugada na Europa), mostra a
  // DATA do PT — assim "02h PT (16/06)" não parece um horário "menor" que o de BR.
  const ptDate = dayKey(PT_TZ) !== dayKey(BR_TZ) ? ` (${dmPt})` : "";
  return `${wd}, ${dmBr} · ${compactHour(date, BR_TZ, "pt-BR")} BR · ${compactHour(date, PT_TZ, "pt-PT")} PT${ptDate}`;
}

// Status real da FIFA para o jogo (0=encerrado, 1=futuro, 3=ao vivo), ou null se
// ainda não consultamos. Vem de liveById, que PERSISTE entre ciclos.
function liveStatus(match) {
  const l = liveById[match.id];
  return l && l.status != null ? l.status : null;
}
// Encerrado = o coletor já marcou (json status 0) OU a FIFA já confirmou (status 0) OU — backstop —
// o jogo já estourou o fim provável e NEM o json NEM a FIFA confirmaram ao vivo (cold-start).
// Uma vez encerrado, NUNCA volta a ser o card — isto mata a regressão.
function isFinished(match, now = new Date()) {
  if (match.status === 0 || liveStatus(match) === 0) return true; // json OU FIFA confirmaram encerrado
  if (liveStatus(match) === 3) return false;                      // FIFA confirma AO VIVO → sobrepõe sempre
  // ÂNCORA TEMPORAL (camada 3): sem json-status-0 e sem FIFA, se o jogo já passou do fim provável
  // (grupos ~2,25h: 90'+acréscimos com folga; mata-mata ~3,25h: +prorrogação+pênaltis) → ENCERRADO.
  // Mata o "Ao vivo provisório" de um jogo obviamente terminado antes do 1º poll da FIFA. Como a FIFA
  // status 3 acima sempre sobrepõe, um jogo REALMENTE ao vivo (acréscimos/prorrogação) nunca é cortado cedo.
  const likelyEnd = match.group ? 2.25 * 60 * 60 * 1000 : 3.25 * 60 * 60 * 1000;
  return now >= new Date(utcDate(match).getTime() + likelyEnd);
}
// Ao vivo só com status 3 REAL da FIFA — nunca inventado pelo relógio.
function isLive(match) {
  return liveStatus(match) === 3;
}

function getActiveMatch(now = new Date()) {
  return MATCHES.find((match) => {
    if (isFinished(match, now)) return false; // encerrado (json OU FIFA) nunca é o card
    const start = utcDate(match);
    return start <= now && now < new Date(start.getTime() + FOCAL_WINDOW_MS);
  });
}

function getNextMatch(now = new Date()) {
  return (
    getActiveMatch(now) ||
    MATCHES.find((match) => !isFinished(match, now) && utcDate(match) > now) ||
    MATCHES.filter((m) => !isFinished(m, now)).pop() ||
    MATCHES[MATCHES.length - 1]
  );
}

// Sigla de 3 letras (código FIFA) por seleção — para a faixa do carrossel.
const TEAM_ABBR = {
  "Alemanha": "GER", "Argentina": "ARG", "Argélia": "ALG", "Arábia Saudita": "KSA",
  "Austrália": "AUS", "Áustria": "AUT", "Bélgica": "BEL", "Bósnia e Herzegovina": "BIH",
  "Brasil": "BRA", "Cabo Verde": "CPV", "Canadá": "CAN", "Catar": "QAT",
  "Colômbia": "COL", "Coreia do Sul": "KOR", "Costa do Marfim": "CIV", "Croácia": "CRO",
  "Curaçao": "CUW", "Egito": "EGY", "Equador": "ECU", "Escócia": "SCO",
  "Espanha": "ESP", "Estados Unidos": "USA", "França": "FRA", "Gana": "GHA",
  "Haiti": "HAI", "Inglaterra": "ENG", "Irã": "IRN", "Iraque": "IRQ",
  "Japão": "JPN", "Jordânia": "JOR", "Marrocos": "MAR", "México": "MEX",
  "Noruega": "NOR", "Nova Zelândia": "NZL", "Países Baixos": "NED", "Panamá": "PAN",
  "Paraguai": "PAR", "Portugal": "POR", "RD Congo": "COD", "República Tcheca": "CZE",
  "Senegal": "SEN", "Suécia": "SWE", "Suíça": "SUI", "Tunísia": "TUN",
  "Turquia": "TUR", "Uruguai": "URU", "Uzbequistão": "UZB", "África do Sul": "RSA",
};
function abbr(team) {
  return TEAM_ABBR[team] || (team && team !== "A definir" ? team.slice(0, 3).toUpperCase() : "?");
}

// --- Carrossel da rodada do dia ---
// null = automático (mostra o "jogo da vez" e auto-avança); um id = o jogo que o
// usuário escolheu no carrossel (swipe/faixa), respeitado até ele voltar ao vivo.
let activeMatchId = null;

// Chave da RODADA: a data OFICIAL do jogo (fuso do estádio/FIFA), igual para todo
// mundo. A rodada é a unidade da competição — todos os jogos do mesmo "dia da Copa"
// ficam juntos, mesmo o que cai na nossa madrugada (ex.: 01h BR). NÃO agrupamos por
// fuso de Brasília/Portugal (fatiaria a rodada e poderia errar). O horário exibido
// por jogo segue em BR/PT no whenLine, com a data real — então não há confusão.
function roundKey(match) {
  return match.date;
}

// Jogos da MESMA RODADA (mesma data oficial) do jogo de referência, em ordem de horário.
function dayMatches(ref) {
  const key = roundKey(ref);
  return MATCHES.filter((m) => roundKey(m) === key);
}

// O jogo mostrado no card: o escolhido pelo usuário, senão o "jogo da vez".
// A escolha manual vale DENTRO da rodada; quando a rodada vira (o jogo da vez passa
// pra outra rodada), a escolha expira e o card volta ao automático (item 5, situação 8).
function getCardMatch(now = new Date()) {
  if (activeMatchId != null) {
    const m = MATCHES.find((x) => x.id === activeMatchId);
    const focal = getNextMatch(now);
    if (m && roundKey(m) === roundKey(focal)) return m;
    activeMatchId = null; // rodada virou (ou jogo sumiu) → automático
  }
  return getNextMatch(now);
}

// Anda no carrossel dentro do dia: -1 anterior, +1 próximo.
function moveCard(dir) {
  const cur = getCardMatch();
  const day = dayMatches(cur);
  const i = day.findIndex((m) => m.id === cur.id);
  const next = day[i + dir];
  if (next) {
    activeMatchId = next.id;
    renderNext();
  }
}

// Slide DIRECIONAL ao TROCAR de jogo (entra da direita no "próximo", da esquerda
// no "anterior"). Respeita prefers-reduced-motion.
function flashPanel(dir) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const p = document.querySelector(".card-inner");
  if (!p) return;
  p.classList.remove("slide-next", "slide-prev");
  void p.offsetWidth; // força reflow p/ reiniciar a animação
  p.classList.add(dir < 0 ? "slide-prev" : "slide-next");
}

// Faixa "mapa da rodada": uma pílula por jogo do dia (hora / placar / ao vivo),
// a ativa destacada, tocável. Some quando há só 1 jogo no dia.
function renderDayStrip(cur) {
  if (!el.dayStrip) return;
  const day = dayMatches(cur);
  if (day.length < 2) {
    el.dayStrip.hidden = true;
    el.dayStrip.innerHTML = "";
    return;
  }
  el.dayStrip.hidden = false;
  el.dayStrip.innerHTML = day
    .map((m) => {
      const phase = matchPhase(m);
      const active = m.id === cur.id;
      let label;
      if (phase === "finished") {
        const lv = liveById[m.id];
        const h = lv && lv.home != null ? lv.home : m.homeScore;
        const a = lv && lv.away != null ? lv.away : m.awayScore;
        label = h != null ? `${abbr(m.home)} ${h}-${a} ${abbr(m.away)}` : `${abbr(m.home)}×${abbr(m.away)}`;
      } else {
        label = `${abbr(m.home)}×${abbr(m.away)}`;
      }
      const dot = phase === "live" ? '<span class="pill-live-dot" aria-hidden="true"></span>' : "";
      return `<button type="button" class="day-pill ph-${phase}${active ? " active" : ""}" data-match-id="${m.id}" aria-pressed="${active}">${dot}${label}</button>`;
    })
    .join("");
}

// Fase pela FONTE DA VERDADE: ENCERRADO (json status 0 OU FIFA status 0) tem
// prioridade > AO VIVO (só status 3 REAL da FIFA) > futuro/relógio. O relógio só
// dá "ao vivo provisório" a um jogo que começou e AINDA não foi confirmado encerrado
// — e o isFinished acima já barra os encerrados de verdade (fim do "ao vivo" falso).
function matchPhase(match) {
  const now = new Date();
  if (isFinished(match, now)) return "finished";
  if (isLive(match)) return "live";
  const start = utcDate(match);
  if (now < start) return "upcoming";
  if (now < new Date(start.getTime() + FOCAL_WINDOW_MS)) return "live";
  return "finished";
}

function teamText(match) {
  return `${match.home} x ${match.away}`;
}

function stageLabel(match) {
  return match.group ? `Grupo ${match.group}` : (match.stage || "");
}

// Campos localizados da FIFA chegam como [{Locale, Description}] (ou string simples).
function fifaText(value) {
  if (Array.isArray(value)) return value.map((n) => n.Description || "").join("");
  return value == null ? "" : String(value);
}

// FIFA entrega o sobrenome em CAIXA ALTA (RAÚL, KREJCI) -> Title Case (igual ao coletor).
function prettyName(name) {
  return name
    .split(" ")
    .map((word) => word.split("-").map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p)).join("-"))
    .join(" ");
}

// Lê o timeline oficial e devolve os gols. Detecta pelo PLACAR que sobe (não
// pelo Type): gol de bola rolando = Type 0, mas pênalti = 41 e gol contra = 34
// — o placar que incrementa pega qualquer um. Lado pelo placar que sobe; nome
// do EventDescription. Mesmo critério do coletor.
async function fetchScorers(idStage, idMatch) {
  const url = `https://api.fifa.com/api/v3/timelines/17/285023/${idStage}/${idMatch}?language=pt-BR`;
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  const scorers = [];
  let prevHome = 0;
  let prevAway = 0;
  for (const event of data.Event || []) {
    const home = event.HomeGoals;
    const away = event.AwayGoals;
    if (home == null || away == null) continue;
    let side;
    if (home > prevHome) side = "home";
    else if (away > prevAway) side = "away";
    else { prevHome = home; prevAway = away; continue; }
    prevHome = home;
    prevAway = away;
    const desc = fifaText(event.EventDescription);
    const name = desc.includes(" (") ? desc.split(" (")[0].trim() : fifaText(event.PlayerName);
    if (!name) continue;
    const low = desc.toLowerCase();
    let note = "";
    if (low.includes("contra") || low.includes("own goal")) note = "gc";
    else if (["pênalti", "penalti", "penálti", "penalty"].some((k) => low.includes(k))) note = "p";
    scorers.push({ name: prettyName(name), minute: fifaText(event.MatchMinute), side, note });
  }
  return scorers;
}

function teamScorersHtml(side, match) {
  // ao vivo: liveScorers (só se forem deste jogo); encerrado: match.scorers do JSON.
  const list =
    liveScorersId === match.id && liveScorers.length
      ? liveScorers
      : Array.isArray(match.scorers)
        ? match.scorers
        : [];
  if (!list.length) return "";
  const text = list
    .filter((s) => s.side === side)
    .map((s) => `${s.name} ${s.minute}${s.note ? ` (${s.note})` : ""}`)
    .join(", ");
  return text ? `<span class="team-scorers">${text}</span>` : "";
}

function scorelineHtml(match) {
  const phase = matchPhase(match);
  const live = liveById[match.id];
  // placar ao vivo vem da FIFA (liveById); encerrado, do matches.json como fallback.
  let h = null;
  let a = null;
  let penH = null;
  let penA = null;
  if (live && live.home != null) {
    h = live.home; a = live.away; penH = live.homePen; penA = live.awayPen;
  } else if (phase === "finished" && match.homeScore != null) {
    h = match.homeScore; a = match.awayScore;
  }
  const showScore = (phase === "live" || phase === "finished") && h != null;
  let middle = "x";
  if (showScore) {
    middle = `${h} - ${a}`;
    if (penH != null && penA != null) {
      middle += `<small class="pens">${penH}-${penA} nos pênaltis</small>`;
    }
  }
  return `
    <div class="team">${match.home}${showScore ? teamScorersHtml("home", match) : ""}</div>
    <div class="versus${showScore ? " has-score" : ""}" id="versus">${middle}</div>
    <div class="team">${match.away}${showScore ? teamScorersHtml("away", match) : ""}</div>
  `;
}

// --- Auto-cura: backfill direto da FIFA, sem depender do coletor ---
// O coletor (cron do GitHub, best-effort) pode ter buraco — sobretudo de madrugada,
// quando o jogo tardio da rodada termina e ninguém escreve o matches.json por horas.
// Resultado de manhã: aquele jogo aparece SEM placar (chip vazio) ou "ao vivo"
// provisório pelo relógio, e não entra na lista de encerrados. Aqui o próprio front
// pergunta à FIFA o status REAL de QUALQUER jogo que já começou e ainda não foi
// confirmado encerrado — curando carrossel, card e "encerrados" sem o coletor.
const HEAL_WINDOW_MS = 18 * 60 * 60 * 1000; // só jogos recentes — conjunto minúsculo (0-2 normalmente)
async function healRecentMatches(now = new Date()) {
  const t = now.getTime();
  const targets = MATCHES.filter((m) => {
    if (!m.idMatch || !m.idStage) return false; // sem ids da FIFA não há o que consultar
    if (m.status === 0) return false;            // coletor já confirmou encerrado
    const l = liveById[m.id];
    if (l && l.status === 0) return false;       // FIFA já confirmou → não reconsulta
    const start = utcDate(m).getTime();
    return start <= t && t - start <= HEAL_WINDOW_MS; // já começou e é recente
  });
  if (!targets.length) return;
  let changed = false;
  for (const match of targets) {
    try {
      const url = `${FIFA_MATCH_API}/${match.idStage}/${match.idMatch}?language=pt-BR`;
      const m = await fetch(url, { cache: "no-store" }).then((response) => response.json());
      if (!m || m.IdMatch !== match.idMatch) continue; // sanidade: tem que ser o jogo certo
      liveById[match.id] = {
        status: m.MatchStatus,
        home: m.HomeTeam ? m.HomeTeam.Score : null,
        away: m.AwayTeam ? m.AwayTeam.Score : null,
        homePen: m.HomeTeamPenaltyScore,
        awayPen: m.AwayTeamPenaltyScore,
        time: m.MatchTime,
      };
      changed = true;
    } catch (error) {
      // sem rede / FIFA fora do ar — tenta de novo no próximo ciclo, sem quebrar a tela
    }
  }
  if (changed) {
    renderNext();    // card + faixa do carrossel já leem liveById
    renderHistory(); // a lista de encerrados passa a incluir o que a FIFA confirmou
  }
}

async function updateLiveScore() {
  const now = new Date();
  const match = getNextMatch(now);
  const start = utcDate(match);
  // Só consulta a API na janela em que o jogo pode estar rolando (15min antes do
  // apito até o fim da janela de foco). Fora disso, economiza e cai no fallback.
  const windowOpen = match.idMatch && match.idStage &&
    now >= new Date(start.getTime() - 15 * 60 * 1000) &&
    now < new Date(start.getTime() + FOCAL_WINDOW_MS);
  // Fora da janela NÃO mexemos no estado (preserva o que já sabemos — inclusive o
  // "encerrado"). Quem desenha a tela é sempre o renderNext (a cada 1s).
  if (!windowOpen) return;
  try {
    const url = `${FIFA_MATCH_API}/${match.idStage}/${match.idMatch}?language=pt-BR`;
    const m = await fetch(url, { cache: "no-store" }).then((response) => response.json());
    if (!m || m.IdMatch !== match.idMatch) return; // sanidade: tem que ser o jogo certo
    const home = m.HomeTeam ? m.HomeTeam.Score : null;
    const away = m.AwayTeam ? m.AwayTeam.Score : null;
    liveById[match.id] = {
      status: m.MatchStatus,
      home,
      away,
      homePen: m.HomeTeamPenaltyScore,
      awayPen: m.AwayTeamPenaltyScore,
      time: m.MatchTime,
    };
    // Artilheiros: só com jogo ao vivo/encerrado e com gols (timeline oficial).
    if ((m.MatchStatus === 3 || m.MatchStatus === 0) && ((home || 0) + (away || 0)) > 0) {
      try {
        liveScorers = await fetchScorers(match.idStage, match.idMatch);
        liveScorersId = match.id;
      } catch (error) {
        // timeline indisponível — mantém placar sem marcadores
      }
    } else {
      liveScorers = [];
      liveScorersId = match.id;
    }
    renderNext(); // único ponto que escreve a tela — sincroniza com o status real
  } catch (error) {
    // sem rede ou API indisponível — mantém o estado atual
  }
}

// ===== Transmissão por jogo — grade TIPADA gerada por scripts/copa_broadcasts.py =====
// Fonte: data/broadcasts.json (v2) -> games[id] = {grade_br, grade_pt, br:[...], pt:[...]}.
// Cada entrada: {canal, tipo:aberta|paga|streaming, acesso:grátis|assinatura|conta,
//   regiao:BR|PT, url, embed?, confianca:confirmado|provavel|a-confirmar, fonte}.
// CazéTV cobre os 104 grátis no Brasil; Sport TV cobre os 104 (pago) em Portugal; o
// canal aberto específico vem da grade publicada (confirmado) ou fica "a-confirmar".
let BROADCASTS = {};

function gameBroadcast(match) {
  return BROADCASTS[match.id] || { grade_br: "regra", grade_pt: "regra", br: [], pt: [] };
}

// Apresentação por canal (rótulo, "via", nota e números de operadora). url/embed/
// confiança vêm do DADO gerado; aqui fica só o que é estável de exibição.
const CHANNEL_META = {
  "CazéTV":     { label: "CazéTV", via: "YouTube", numbers: "YouTube: @CazeTV. Em Smart TV/FAST, procure CazéTV no guia." },
  "Globo":      { label: "Globo", via: "TV aberta", note: "ou Globoplay (conta grátis)", numbers: "Ref. SP: Globo 5.1; muda pela afiliada local." },
  "SporTV":     { label: "SporTV", via: "TV paga", numbers: "SKY 39/439 HD; Claro 39/539 HD; Vivo 539; Oi 39 HD." },
  "ge TV":      { label: "ge TV", via: "ge.globo", note: "requer conta", numbers: "ge.globo: app/site, sem número." },
  "Globoplay":  { label: "Globoplay", via: "Globoplay", note: "requer conta", numbers: "Globoplay: app/site, sem número." },
  "SBT":        { label: "SBT", via: "TV aberta", note: "ou sbt.com.br/aovivo", numbers: "Ref. SP: SBT 4.1; muda pela afiliada local. Online: sbt.com.br/aovivo." },
  "N Sports":   { label: "N Sports", via: "TV paga", numbers: "N Sports: número varia por operadora." },
  "Sport TV":   { label: "Sport TV", via: "TV paga", numbers: "SPORT.TV1: NOS 20; MEO 21. O subcanal muda na grelha do dia." },
  "RTP1":       { label: "RTP1", via: "RTP Play", numbers: "RTP1: 1 na TDT/grelha. Online: RTP Play (grátis)." },
  "SIC":        { label: "SIC", via: "Opto", numbers: "SIC: 3 na TDT/grelha. Online: SIC Direto/Opto." },
  "TVI":        { label: "TVI", via: "TVI Player", numbers: "TVI: 4 na TDT/grelha. Online: TVI Player." },
  "LiveModeTV": { label: "LiveModeTV", via: "YouTube", numbers: "YouTube: @LiveModeTV_PT." }
};

function channelMeta(canal) {
  return CHANNEL_META[canal] || { label: canal, via: "" };
}

function detectRegion() {
  const saved = localStorage.getItem("preferredRegion");
  if (saved === "BR" || saved === "PT") return saved;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (tz === "Europe/Lisbon" || tz.startsWith("Atlantic/")) return "PT";
    if (tz.startsWith("America/")) return "BR";
    if ((navigator.language || "").toLowerCase() === "pt-pt") return "PT";
  } catch (error) {
    // sem Intl/navegador utilizável — cai no padrão
  }
  return "BR";
}

let preferredRegion = detectRegion();
let liveMatch = null;
let liveActive = false;

// Streams "assistir ao vivo grátis": TODAS as entradas grátis (CazéTV, Globo, SBT, RTP, SIC,
// TVI, LiveModeTV) — incluímos os detentores de direito mesmo ainda não confirmados no jogo, p/
// não deixar o "Ao Vivo" pobre. O sistema confirma/atualiza sozinho; preferimos estar mais completo.
function openStreamsFor(match) {
  const g = gameBroadcast(match);
  const seen = new Set();
  const out = [];
  [...(g.br || []), ...(g.pt || [])].forEach((e) => {
    if (e.acesso !== "grátis") return;
    if (seen.has(e.canal)) return;
    seen.add(e.canal);
    const meta = channelMeta(e.canal);
    out.push({ label: meta.label, via: meta.via, region: e.regiao, url: e.url, embed: e.embed, note: meta.note });
  });
  return out;
}

// Ordena os streams: região preferida primeiro; dentro dela, grátis-sem-login antes.
function sortStreamsByRegion(streams) {
  return streams.slice().sort((a, b) => {
    const regionRank = (a.region === preferredRegion ? 0 : 1) - (b.region === preferredRegion ? 0 : 1);
    if (regionRank !== 0) return regionRank;
    return (a.note ? 1 : 0) - (b.note ? 1 : 0);
  });
}

// Chips de canal clicáveis para a agenda — mesma lógica do painel do topo:
// canais com embed abrem o player no app; os demais abrem o site do canal.
function scheduleChannelsHtml(match) {
  const streams = sortStreamsByRegion(openStreamsFor(match));
  if (!streams.length) return `<span class="small-muted">Sem transmissão confirmada</span>`;
  return streams
    .map((stream) => {
      const tag = stream.region === "PT" ? "PT" : "BR";
      const embedAttrs = stream.embed ? ` data-embed="${stream.embed}" data-title="${stream.label}"` : "";
      const title = stream.embed ? `Assistir ${stream.label} no app` : `Abrir ${stream.label} (${stream.via})`;
      const play = stream.embed ? `<span class="chan-play" aria-hidden="true">▸</span>` : "";
      return `<a class="chan-chip${stream.embed ? " is-embed" : ""}" href="${stream.url}" target="_blank" rel="noopener noreferrer" title="${title}"${embedAttrs}>${play}<span class="region-tag">${tag}</span>${stream.label}</a>`;
    })
    .join("");
}

function renderLiveStreams(match, active) {
  liveMatch = match;
  liveActive = active;
  let streams = openStreamsFor(match);
  if (!streams.length) {
    el.liveStreams.hidden = true;
    return;
  }
  // Prioriza os streams da região preferida (ex.: em Portugal, LiveModeTV/RTP/TVI primeiro).
  streams = sortStreamsByRegion(streams);
  el.regionButtons.forEach((button) => {
    const on = button.dataset.region === preferredRegion;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  el.liveStreamsLabel.textContent = active ? "● Assistir AO VIVO grátis" : "Onde assistir ao vivo grátis";
  el.streamLinks.innerHTML = streams
    .map((stream) => {
      const embedAttrs = stream.embed ? ` data-embed="${stream.embed}" data-title="${stream.label}"` : "";
      const hint = stream.embed ? "assistir aqui" : ""; // não-embed (Globo/SBT/RTP…): só o nome da emissora
      const tag = stream.region === "PT" ? "PT" : "BR";
      const other = stream.region !== preferredRegion ? " is-other-region" : "";
      return `<a class="stream-link${active ? " is-live" : ""}${other}" href="${stream.url}" target="_blank" rel="noopener noreferrer"${embedAttrs}><span class="region-tag">${tag}</span> ${stream.label}${hint ? ` <small>${hint}</small>` : ""}</a>`;
    })
    .join("");
  el.liveStreams.hidden = false;
}

function openPlayer(embedUrl, title, openUrl) {
  el.playerIframe.src = embedUrl + (embedUrl.includes("?") ? "&" : "?") + "autoplay=1";
  el.playerTitle.textContent = `Assistindo: ${title}`;
  el.playerOpen.href = openUrl;
  el.liveStreams.hidden = false; // garante o contêiner visível (ex.: aberto a partir da agenda)
  el.player.hidden = false;
  el.player.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closePlayer() {
  el.playerIframe.src = "";
  el.player.hidden = true;
}

function isTeam(match, team) {
  return match.home === team || match.away === team;
}

function statusLabel(status) {
  const labels = {
    confirmed: "Onde assistir",
    published: "Grade publicada",
    mixed: "O Globo + fonte comunitária; conferir grade",
    community: "Fonte comunitária; conferir na grade",
    rights: "Direito confirmado, canal do jogo a checar",
    partial: "Pacote parcial, não confirmado neste jogo",
    notFound: "Não encontrado como transmissão deste jogo"
  };
  return labels[status] || status;
}

// As fontes (FIFA Media Rights + O Globo/Observador/DN/A Televisão) agora vivem no
// GERADOR: scripts/copa_broadcasts.py (constantes F_*) e scripts/broadcast_grade_seed.json
// (campo "fonte" por jogo). Cada entrada de broadcasts.json carrega sua própria fonte.

// ===== Grade tipada -> linhas do quadro (TV aberta / TV fechada / Streaming) =====
const _CONF_RANK = { confirmado: 3, provavel: 2, "a-confirmar": 1 };

// Uma linha do quadro a partir das entradas de um meio. gradePublicada = a grade
// oficial deste jogo é conhecida; sem ela, ausência vira "a confirmar" (não "não tem").
function broadcastRow(entries, label, gradePublicada, emptyOverride) {
  if (!entries.length) {
    if (emptyOverride) {
      // ex.: aberta PT vazia = o jogo NÃO vai em sinal aberto (lista fechada do acordo), não "a confirmar".
      return { type: label, channels: emptyOverride, numbers: "", status: "closed" };
    }
    return {
      type: label,
      channels: gradePublicada ? "Não indicado para este jogo" : "A confirmar na grade",
      numbers: "",
      status: gradePublicada ? "notFound" : "partial"
    };
  }
  const best = entries.reduce(
    (a, e) => ((_CONF_RANK[e.confianca] || 0) > (_CONF_RANK[a.confianca] || 0) ? e : a),
    entries[0]
  );
  const status =
    best.confianca === "confirmado" ? (gradePublicada ? "published" : "confirmed")
    : best.confianca === "provavel" ? "rights"
    : "partial";
  const names = entries.map((e) => channelMeta(e.canal).label);
  const numbers = entries.map((e) => channelMeta(e.canal).numbers).filter(Boolean).join(" · ");
  // Mostra o canal referido sem hedge "(a confirmar)" — preferimos completo; o sistema confirma
  // /atualiza sozinho. A incerteza fica no texto auxiliar ("Consultar grade oficial"), não no nome.
  const channels = names.join("; ");
  return { type: label, channels, numbers, status };
}

// Quatro linhas de uma região (BR/PT) a partir das entradas tipadas do jogo.
function regionRows(entries, gradePublicada, paidStreamLabel, region) {
  const pick = (tipo, freeOnly) =>
    entries.filter((e) => e.tipo === tipo && (freeOnly === undefined || (freeOnly ? e.acesso === "grátis" : e.acesso !== "grátis")));
  // PT: o sinal aberto é uma lista FECHADA (acordo RTP/SIC/TVI = ~20 jogos). Aberta vazia em PT
  // significa "não vai em aberto" (definitivo), não "a confirmar".
  const abertaVazia = region === "PT" ? "Não vai em sinal aberto" : undefined;
  return [
    broadcastRow(pick("aberta"), "TV aberta", gradePublicada, abertaVazia),
    broadcastRow(pick("paga"), "TV fechada", gradePublicada),
    broadcastRow(pick("streaming", true), "Streaming grátis", gradePublicada),
    broadcastRow(pick("streaming", false), paidStreamLabel, gradePublicada)
  ];
}

function broadcastData(match) {
  const g = gameBroadcast(match);
  return {
    br: { items: regionRows(g.br || [], g.grade_br === "publicada", "Streaming pago/FAST", "BR") },
    pt: { items: regionRows(g.pt || [], g.grade_pt === "publicada", "Streaming pago", "PT") }
  };
}

function practicalInfo(item) {
  if (item.status === "notFound") return "Não confirmado por fontes oficiais.";
  if (["community", "mixed", "partial", "rights"].includes(item.status)) return "Consultar grade oficial.";
  return item.numbers;
}

function setBroadcastList(node, items) {
  node.innerHTML = items
    .map(
      (item) => `
        <li>
          <span class="label">${item.type}</span>
          <span class="broadcast-detail">
            <strong>${item.channels}</strong>
            <small>${practicalInfo(item)}</small>
          </span>
        </li>
      `
    )
    .join("");
}

function renderBroadcasts(match) {
  const data = broadcastData(match);
  el.broadcastTitle.textContent = `${teamText(match)} · ${stageLabel(match)} · Jogo ${match.id}`;
  setBroadcastList(el.broadcastBr, data.br.items);
  setBroadcastList(el.broadcastPt, data.pt.items);
}

function compactBroadcastSummary(match) {
  const g = gameBroadcast(match);
  const sure = (arr) => [...new Set((arr || [])
    .map((e) => channelMeta(e.canal).label))];
  const br = sure(g.br);
  const pt = sure(g.pt);
  return {
    br: br.length ? br.join("; ") : "a confirmar na grade",
    pt: pt.length ? pt.join("; ") : "a confirmar na grade"
  };
}

let renderedMatchId = null;
let renderedPhase = null;
let renderedScoreSig = null; // assinatura do placar/marcadores renderizados (re-render no gol)

// "Quem leva?" — probabilidade pré-jogo (índice Elo), só na fase de pré-jogo.
function renderPredict(match, phase) {
  if (!el.predict) return;
  const p = match.prob;
  if (phase !== "upcoming" || !p) {
    el.predict.hidden = true;
    el.predict.innerHTML = "";
    return;
  }
  el.predict.hidden = false;
  el.predict.innerHTML = `
    <p class="eyebrow">Quem leva?</p>
    <div class="predict-bar" role="img" aria-label="${match.home} ${p.home}%, empate ${p.draw}%, ${match.away} ${p.away}%">
      <span class="seg home" style="width:${p.home}%"></span>
      <span class="seg draw" style="width:${p.draw}%"></span>
      <span class="seg away" style="width:${p.away}%"></span>
    </div>
    <div class="predict-legend">
      <span><i class="dot home"></i>${match.home} <b>${p.home}%</b></span>
      <span><i class="dot draw"></i>Empate <b>${p.draw}%</b></span>
      <span><i class="dot away"></i>${match.away} <b>${p.away}%</b></span>
    </div>
    <p class="predict-note">estimativa pelo índice Elo (força das seleções) · não é aposta</p>
  `;
}

// --- "Dia de seleção": efeito festivo no card de Brasil/Portugal ---
// Roda a CADA visita/reload (a pedido), enquanto a seleção tem jogo na rodada e ANTES
// do apito — depois nao, pra nao comemorar sem saber se ganhou/perdeu. Confete + glow
// suave na cor da selecao + faixa. Respeita prefers-reduced-motion (so a faixa).
const CELEB = {
  Brasil: {
    text: "Dia do Brasil",
    colors: ["#00A859", "#FFD400", "#1C57B5", "#ffffff"],
    accent: "#FFD400",
    soft: "rgba(0, 168, 89, 0.32)",
    stripe: "linear-gradient(90deg, #00A859 33%, #FFD400 33% 66%, #1C57B5 66%)",
  },
  Portugal: {
    text: "Dia de Portugal",
    colors: ["#C8102E", "#1B7A3D", "#F2C14E", "#ffffff"],
    accent: "#C8102E",
    soft: "rgba(200, 16, 46, 0.30)",
    stripe: "linear-gradient(90deg, #C8102E 55%, #1B7A3D 55%)",
  },
};

function bpTeam(match) {
  if (match.home === "Brasil" || match.away === "Brasil") return "Brasil";
  if (match.home === "Portugal" || match.away === "Portugal") return "Portugal";
  return null;
}

// O jogo de B/P da rodada FOCAL ainda nao iniciado (o de apito mais cedo, se os dois
// jogarem no mesmo dia). Usado no boot pra abrir o carrossel direto nesse card.
function celebrationTarget(now = new Date()) {
  const focal = getNextMatch(now);
  if (!focal) return null;
  const key = roundKey(focal);
  return MATCHES
    .filter((m) => roundKey(m) === key)
    .filter((m) => bpTeam(m) && utcDate(m) > now)
    .sort((a, b) => utcDate(a) - utcDate(b))[0] || null;
}

// Dispara o efeito se o card mostrado AGORA for um jogo de B/P antes do apito.
// Sem trava de "1x": roda toda vez que o card de B/P aparece (boot/reload/swipe) —
// só não roda depois do apito (aí não dá pra comemorar sem saber o resultado).
function maybeCelebrate(match) {
  const team = bpTeam(match);
  if (!team) return;
  if (utcDate(match) <= new Date()) return; // ja comecou -> nao comemora (sem resultado)
  playCelebration(team);
}

function celebConfetti(canvas, panel, colors) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = panel.clientWidth;
  const h = panel.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ps = [];
  for (let i = 0; i < 26; i++) {
    ps.push({
      x: w * (0.12 + 0.76 * Math.random()), y: -12 - Math.random() * 40,
      vx: (Math.random() - 0.5) * 1.1, vy: 1.3 + Math.random() * 1.7,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.22,
      pw: 5 + Math.random() * 5, ph: 2 + Math.random() * 3, c: colors[i % colors.length],
    });
  }
  let startT = null;
  function frame(t) {
    if (startT === null) startT = t;
    const el = t - startT;
    ctx.clearRect(0, 0, w, h);
    let alive = false;
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.012; p.rot += p.vr;
      const a = el < 1700 ? 1 : Math.max(0, 1 - (el - 1700) / 900);
      if (p.y < h + 20 && a > 0) alive = true;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.pw / 2, -p.ph / 2, p.pw, p.ph);
      ctx.restore();
    }
    if (el < 2600 && alive) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, w, h);
  }
  requestAnimationFrame(frame);
}

function playCelebration(team) {
  const panel = document.querySelector(".match-panel");
  if (!panel) return;
  const conf = CELEB[team];
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.style.setProperty("--celeb-accent", conf.accent);
  panel.style.setProperty("--celeb-soft", conf.soft);
  const prev = panel.querySelector(".celebrate-layer");
  if (prev) prev.remove();
  const layer = document.createElement("div");
  layer.className = "celebrate-layer";
  const ribbon = document.createElement("div");
  ribbon.className = "celebrate-ribbon";
  const stripe = document.createElement("span");
  stripe.className = "stripe";
  stripe.style.background = conf.stripe;
  const label = document.createElement("strong");
  label.textContent = conf.text;
  ribbon.append(stripe, label);
  layer.appendChild(ribbon);
  let canvas = null;
  if (!reduce) {
    canvas = document.createElement("canvas");
    canvas.className = "celebrate-canvas";
    layer.appendChild(canvas);
  }
  panel.appendChild(layer);
  panel.classList.add("celebrating"); // esconde o badge "Próximo" enquanto a faixa está no topo
  if (!reduce) {
    panel.classList.remove("celebrate-glow");
    void panel.offsetWidth; // reinicia a animação do glow
    panel.classList.add("celebrate-glow");
    celebConfetti(canvas, panel, conf.colors);
  }
  window.setTimeout(() => {
    if (layer.parentNode) layer.remove();
    panel.classList.remove("celebrate-glow");
    panel.classList.remove("celebrating");
  }, 4000); // segura a faixa ~1s a mais (a pedido)
}

function renderNext() {
  const now = new Date();
  const match = getCardMatch(now);
  const start = utcDate(match);
  const phase = matchPhase(match);
  const live = liveById[match.id];

  // Cabeçalho/meta/transmissão/predict só mudam quando o JOGO ou a FASE muda.
  if (match.id !== renderedMatchId || phase !== renderedPhase) {
    if (renderedMatchId !== null && match.id !== renderedMatchId) {
      const day = dayMatches(match);
      const oi = day.findIndex((m) => m.id === renderedMatchId);
      const ni = day.findIndex((m) => m.id === match.id);
      flashPanel(oi >= 0 && ni >= 0 && ni < oi ? -1 : 1);
    }
    renderDayStrip(match);
    el.nextTitle.textContent = `${stageLabel(match)} · Jogo ${match.id}`;
    el.cityVenue.textContent = `${match.city} · ${match.venue}`;
    if (match.weather && match.weather.tempC != null) {
      el.temp.textContent = `${match.weather.tempC}°C`;
      el.temp.hidden = false;
    } else {
      el.temp.hidden = true;
    }
    el.when.textContent = whenLine(start);
    if (!selectedMatchId) renderBroadcasts(match);
    renderLiveStreams(match, phase === "live");
    const ls = document.querySelector("#live-streams");
    if (ls) ls.classList.toggle("demoted", phase === "finished");
    renderPredict(match, phase);
    renderedMatchId = match.id;
    renderedPhase = phase;
    maybeCelebrate(match); // efeito festivo se este card virou jogo de Brasil/Portugal (pré-apito)
  }

  // Placar + marcadores: re-renderiza quando o jogo, a fase OU o placar ao vivo muda.
  // (Único ponto que escreve o placar — sem dois renderizadores brigando.)
  const sig = `${match.id}|${phase}|${live ? `${live.home}-${live.away}/${live.homePen}-${live.awayPen}/${live.time}` : ""}|${liveScorersId === match.id ? liveScorers.length : 0}`;
  if (sig !== renderedScoreSig) {
    el.scoreline.innerHTML = scorelineHtml(match);
    renderedScoreSig = sig;
  }

  // Badge = estado + tempo juntos (a contagem "Começa em" entrou aqui). Atualiza todo tick.
  if (phase === "live") {
    el.matchState.className = "badge badge-live";
    el.matchState.textContent = live && live.time ? `Ao vivo · ${live.time}` : "Ao vivo";
  } else if (phase === "finished") {
    el.matchState.className = "badge badge-finished";
    // Encerrado pela âncora temporal mas placar ainda não confirmado (json/FIFA) → diz que está apurando,
    // em vez de mostrar "Encerrado" com o "x" da scoreline parecendo bug. finalScore() é puro/barato.
    el.matchState.textContent = finalScore(match) ? "Encerrado" : "Encerrado · apurando placar";
  } else {
    el.matchState.className = "badge badge-upcoming";
    el.matchState.textContent = `Próximo · ${compactCountdown(start - now)}`;
  }
}

function renderSchedule(filter = "all") {
  const now = new Date();
  const upcoming = MATCHES
    .filter((match) => utcDate(match).getTime() + MATCH_DURATION_MS > now.getTime())
    .filter((match) => filter === "all" || match.home === filter || match.away === filter)
    .slice(0, 10);

  el.matchList.innerHTML = upcoming
    .map((match) => {
      const start = utcDate(match);
      return `
        <article class="match-row">
          <time datetime="${start.toISOString()}">${shortDate(start, PT_TZ, "pt-PT")}</time>
          <div>
            <strong>${teamText(match)}</strong>
            <span class="small-muted">${stageLabel(match)} · ${match.city}</span>
          </div>
          <div class="small-muted times">
            Brasil: ${formatTime(start, BR_TZ, "pt-BR")}<br>
            Portugal: ${formatTime(start, PT_TZ, "pt-PT")}
          </div>
          <div class="broadcast-chips" aria-label="Onde assistir">
            ${scheduleChannelsHtml(match)}
          </div>
          <button class="row-action" type="button" data-match-id="${match.id}">Ver grade</button>
        </article>
      `;
    })
    .join("");

  if (!upcoming.length) {
    el.matchList.innerHTML = `<p class="plain-copy">Não há jogos futuros para este filtro.</p>`;
  }
}

const HISTORY_PAGE_SIZE = 10;
let historyPage = 0;

// Classificação por grupos — calculada no app a partir dos jogos encerrados.
function computeStandings() {
  const groups = {};
  for (const m of MATCHES) {
    if (!m.group) continue;
    const g = (groups[m.group] = groups[m.group] || {});
    for (const team of [m.home, m.away]) {
      if (team && team !== "A definir" && !g[team]) {
        g[team] = { team, j: 0, v: 0, e: 0, d: 0, gf: 0, ga: 0, pts: 0 };
      }
    }
    if (m.status === 0 && m.homeScore != null && m.awayScore != null) {
      const h = g[m.home];
      const a = g[m.away];
      if (!h || !a) continue;
      h.j++; a.j++;
      h.gf += m.homeScore; h.ga += m.awayScore;
      a.gf += m.awayScore; a.ga += m.homeScore;
      if (m.homeScore > m.awayScore) { h.v++; h.pts += 3; a.d++; }
      else if (m.homeScore < m.awayScore) { a.v++; a.pts += 3; h.d++; }
      else { h.e++; a.e++; h.pts++; a.pts++; }
    }
  }
  const out = {};
  for (const key of Object.keys(groups)) {
    out[key] = Object.values(groups[key])
      .map((t) => ({ ...t, sg: t.gf - t.ga }))
      .sort((x, y) => y.pts - x.pts || y.sg - x.sg || y.gf - x.gf || x.team.localeCompare(y.team, "pt-BR"));
  }
  return out;
}

function renderStandings() {
  if (!el.standings) return;
  const table = computeStandings();
  const groups = Object.keys(table).sort();
  const sg = (n) => (n > 0 ? "+" : "") + n;
  el.standings.innerHTML = groups
    .map((g) => `
      <div class="standings-group">
        <h3>Grupo ${g}</h3>
        <table class="standings-table">
          <thead>
            <tr>
              <th class="c-pos">#</th><th class="c-team">Time</th>
              <th>J</th><th class="c-vd">V</th><th class="c-vd">E</th><th class="c-vd">D</th><th>SG</th><th>Pts</th>
            </tr>
          </thead>
          <tbody>
            ${table[g].map((t, i) => `
              <tr class="${i < 2 ? "qualified" : ""}">
                <td class="c-pos">${i + 1}</td>
                <td class="c-team">${t.team}</td>
                <td>${t.j}</td>
                <td class="c-vd">${t.v}</td><td class="c-vd">${t.e}</td><td class="c-vd">${t.d}</td>
                <td>${sg(t.sg)}</td>
                <td><b>${t.pts}</b></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>`)
    .join("");
}

// ===== Mata-mata: chaveamento round-a-round (aparece quando a fase de grupos encerra) =====
const KO_STAGE_ORDER = [
  "16-avos de final", "Oitavas de final", "Quartas de final",
  "Semifinal", "Disputa de 3º lugar", "Final"
];

// Fase de grupos encerrada = TODOS os jogos de grupo já têm placar final.
function groupsPhaseOver() {
  const groupGames = MATCHES.filter((m) => m.group);
  return groupGames.length > 0 && groupGames.every((m) => finalScore(m) != null);
}

// Resultado/estado de um jogo do chaveamento: encerrado (placar + pênaltis se houver da FIFA),
// ao vivo, ou a data. Reusa finalScore/matchPhase — a mesma verdade do resto do app.
function knockoutResultHtml(match) {
  const fs = finalScore(match);
  const live = liveById[match.id];
  if (fs) {
    const pens = live && live.homePen != null && live.awayPen != null
      ? ` <small class="ko-pen">(${live.homePen}–${live.awayPen} pên)</small>` : "";
    return `<span class="ko-score">${fs.home}–${fs.away}${pens}</span>`;
  }
  if (matchPhase(match) === "live") {
    const s = live && live.home != null ? `${live.home}–${live.away} · ` : "";
    return `<span class="ko-score ko-score-live">${s}ao vivo</span>`;
  }
  return `<span class="ko-when">${shortDate(utcDate(match), PT_TZ, "pt-PT")}</span>`;
}

// Chaveamento completo, agrupado por fase em ordem; + relabel da Classificação como "final".
function renderKnockout() {
  if (el.standingsPhase) {
    el.standingsPhase.textContent = groupsPhaseOver() ? "Fase de grupos · final" : "Fase de grupos";
  }
  if (!el.knockout) return;
  const ko = MATCHES.filter((m) => !m.group);
  // Mostra quando a fase de grupos encerra OU — robustez anti-buraco — quando algum jogo de
  // mata-mata já começou (placar/ao vivo), mesmo que um jogo de grupo tenha ficado pendente no dado.
  const show = ko.length > 0 &&
    (groupsPhaseOver() || ko.some((m) => finalScore(m) != null || matchPhase(m) === "live"));
  el.knockout.hidden = !show;
  if (!show) { el.knockout.innerHTML = ""; return; }
  // Ordem conhecida primeiro + qualquer fase nova do dado no fim — nunca derruba um jogo em silêncio.
  const stages = [...new Set(MATCHES.filter((m) => !m.group).map((m) => m.stage).filter(Boolean))];
  const ordered = [
    ...KO_STAGE_ORDER.filter((s) => stages.includes(s)),
    ...stages.filter((s) => !KO_STAGE_ORDER.includes(s))
  ];
  const rounds = ordered
    .map((stage) => ({ stage, games: ko.filter((m) => m.stage === stage).sort((a, b) => utcDate(a) - utcDate(b)) }))
    .filter((r) => r.games.length);
  el.knockout.innerHTML = `
    <h3 class="ko-title">Mata-mata</h3>
    ${rounds.map((r) => `
      <section class="ko-round">
        <h4>${r.stage}</h4>
        <ul class="ko-list">
          ${r.games.map((m) => `
            <li class="ko-match ph-${matchPhase(m)}">
              <span class="ko-teams">${m.home} <span class="ko-x">×</span> ${m.away}</span>
              ${knockoutResultHtml(m)}
            </li>`).join("")}
        </ul>
      </section>`).join("")}
  `;
}

// Placar final de um jogo, com auto-cura: usa o JSON do coletor (registro oficial
// congelado) e, se ele ainda não escreveu, o que a FIFA confirmou em liveById.
// Retorna null se o jogo não está encerrado ou ainda não tem placar.
function finalScore(match) {
  const l = liveById[match.id];
  const finished = match.status === 0 || (l && l.status === 0);
  if (!finished) return null;
  const home = match.homeScore != null ? match.homeScore : (l ? l.home : null);
  const away = match.awayScore != null ? match.awayScore : (l ? l.away : null);
  if (home == null || away == null) return null;
  return { home, away };
}

function renderHistory() {
  const section = document.querySelector(".section-results");
  const finished = MATCHES
    .filter((match) => finalScore(match)) // encerrado pelo coletor OU confirmado pela FIFA
    .sort((a, b) => utcDate(b) - utcDate(a));

  if (!finished.length) {
    if (section) section.hidden = true;
    return;
  }
  if (section) section.hidden = false;

  const pageCount = Math.max(1, Math.ceil(finished.length / HISTORY_PAGE_SIZE));
  historyPage = Math.min(Math.max(historyPage, 0), pageCount - 1);
  const start = historyPage * HISTORY_PAGE_SIZE;
  const pageItems = finished.slice(start, start + HISTORY_PAGE_SIZE);

  el.resultList.innerHTML = pageItems
    .map((match) => {
      const kickoff = utcDate(match);
      const fs = finalScore(match);
      const homeWin = fs.home > fs.away;
      const awayWin = fs.away > fs.home;
      return `
        <article class="result-row">
          <time datetime="${kickoff.toISOString()}">${shortDate(kickoff, BR_TZ, "pt-BR")}</time>
          <div class="result-match">
            <span class="result-team home${homeWin ? " win" : ""}">${match.home}</span>
            <span class="result-score">${fs.home} - ${fs.away}</span>
            <span class="result-team away${awayWin ? " win" : ""}">${match.away}</span>
            ${scorersHtml(match)}
            <span class="small-muted result-stage">${stageLabel(match)}</span>
          </div>
        </article>
      `;
    })
    .join("");

  renderHistoryPager(finished.length, pageCount);
}

function renderHistoryPager(total, pageCount) {
  if (!el.resultPager) return;
  if (pageCount <= 1) {
    el.resultPager.hidden = true;
    el.resultPager.innerHTML = "";
    return;
  }
  const from = historyPage * HISTORY_PAGE_SIZE + 1;
  const to = Math.min((historyPage + 1) * HISTORY_PAGE_SIZE, total);
  el.resultPager.hidden = false;
  el.resultPager.innerHTML = `
    <button class="pager-btn" type="button" data-page="prev"${historyPage === 0 ? " disabled" : ""} aria-label="Resultados mais recentes">‹</button>
    <span class="pager-info">${from}–${to} de ${total}&nbsp;&middot;&nbsp;pág. ${historyPage + 1}/${pageCount}</span>
    <button class="pager-btn" type="button" data-page="next"${historyPage >= pageCount - 1 ? " disabled" : ""} aria-label="Resultados mais antigos">›</button>
  `;
}

function scorersHtml(match) {
  const list = match.scorers;
  if (!Array.isArray(list) || !list.length) return "";
  const fmt = (s) => `${s.name} ${s.minute}${s.note ? ` (${s.note})` : ""}`;
  const home = list.filter((s) => s.side === "home").map(fmt).join(", ");
  const away = list.filter((s) => s.side === "away").map(fmt).join(", ");
  if (!home && !away) return "";
  return `
    <span class="result-scorers home">${home}</span>
    <span class="result-scorers away">${away}</span>
  `;
}

function scheduleLongTimeout(callback, delay) {
  if (delay <= 0) return undefined;
  if (delay <= MAX_TIMEOUT_MS) return window.setTimeout(callback, delay);
  return window.setTimeout(() => scheduleLongTimeout(callback, delay - MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const options = { body, icon: "assets/worldcup-mark.svg", badge: "assets/worldcup-mark.svg", tag: title };
  const fallback = () => {
    try { new Notification(title, options); } catch (error) { /* navegador sem suporte direto */ }
  };
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready
      .then((registration) => registration.showNotification(title, options))
      .catch(fallback);
  } else {
    fallback();
  }
}

function scheduleAlerts() {
  const alerted = new Set(JSON.parse(localStorage.getItem("alertedMatches") || "[]"));
  const now = new Date();

  MATCHES.forEach((match) => {
    if (alerted.has(match.id)) return;
    const start = utcDate(match);
    const alarmAt = new Date(start.getTime() - 60 * 60 * 1000);
    const delay = alarmAt.getTime() - now.getTime();
    if (delay <= 0 || start <= now) return;

    scheduleLongTimeout(() => {
      notify(`Copa 2026 em 1 hora: ${teamText(match)}`, `${match.city}. Brasil: ${formatTime(start, BR_TZ, "pt-BR")} · Portugal: ${formatTime(start, PT_TZ, "pt-PT")}`);
      alerted.add(match.id);
      localStorage.setItem("alertedMatches", JSON.stringify([...alerted]));
    }, delay);
  });

  localStorage.setItem("alertsEnabled", "true");
  el.alertStatus.textContent = "Alertas ativados.";
}

async function enableAlerts() {
  if (!("Notification" in window)) {
    el.alertStatus.textContent = "Este navegador não suporta notificações. Use o botão de calendário.";
    return;
  }
  if (Notification.permission === "denied") {
    el.alertStatus.textContent = "Notificações bloqueadas no navegador. Libere nas permissões do site, ou use o botão de calendário.";
    return;
  }
  let permission = Notification.permission;
  if (permission !== "granted") {
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      permission = await new Promise((resolve) => Notification.requestPermission(resolve));
    }
  }
  if (permission === "granted") {
    scheduleAlerts();
    notify("Alertas ativados", "Você será avisado 1 hora antes de cada jogo.");
  } else {
    el.alertStatus.textContent = "Permissão não concedida. Use o botão de calendário como alternativa.";
  }
}

function escapeIcs(text) {
  return text.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function buildCalendar() {
  const futureMatches = MATCHES.filter((match) => utcDate(match).getTime() + MATCH_DURATION_MS > Date.now());
  const events = futureMatches.map((match) => {
    const start = utcDate(match);
    const end = new Date(start.getTime() + MATCH_DURATION_MS);
    const summary = `Copa 2026: ${teamText(match)}`;
    const description = [
      `Cidade: ${match.city}`,
      `Estádio: ${match.venue}`,
      `Brasil: ${formatTime(start, BR_TZ, "pt-BR")}`,
      `Portugal: ${formatTime(start, PT_TZ, "pt-PT")}`,
      `BR: ${compactBroadcastSummary(match).br}`,
      `PT: ${compactBroadcastSummary(match).pt}`
    ].join("\\n");

    return [
      "BEGIN:VEVENT",
      `UID:copa-2026-${match.id}@codex.local`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${escapeIcs(summary)}`,
      `LOCATION:${escapeIcs(`${match.venue}, ${match.city}`)}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT1H",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcs(`Daqui a 1 hora: ${teamText(match)}`)}`,
      "END:VALARM",
      "END:VEVENT"
    ].join("\r\n");
  });

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Codex//Copa 2026 Alertas//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR"
  ].join("\r\n");
}

function downloadCalendar() {
  const blob = new Blob([buildCalendar()], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "copa-2026-alertas.ics";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  el.alertStatus.textContent = "Calendário baixado com lembrete 1 hora antes de cada jogo carregado.";
}

function bindEvents() {
  el.enableAlerts.addEventListener("click", enableAlerts);
  el.testAlert.addEventListener("click", () => {
    notify("Teste de alerta Copa 2026", "Se apareceu no celular/computador, as notificações estão funcionando.");
    if (!("Notification" in window) || Notification.permission !== "granted") {
      el.alertStatus.textContent = "Ative as notificações antes de testar, ou use o calendário.";
    }
  });
  el.downloadCalendar.addEventListener("click", downloadCalendar);
  el.streamLinks.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-embed]");
    if (!link) return;
    event.preventDefault();
    openPlayer(link.dataset.embed, link.dataset.title, link.href);
  });
  el.playerClose.addEventListener("click", closePlayer);
  el.regionButtons.forEach((button) => {
    button.addEventListener("click", () => {
      preferredRegion = button.dataset.region;
      localStorage.setItem("preferredRegion", preferredRegion);
      if (liveMatch) renderLiveStreams(liveMatch, liveActive);
    });
  });
  el.matchList.addEventListener("click", (event) => {
    const chip = event.target.closest("a.chan-chip[data-embed]");
    if (chip) {
      event.preventDefault();
      openPlayer(chip.dataset.embed, chip.dataset.title, chip.href);
      return;
    }
    const button = event.target.closest("[data-match-id]");
    if (!button) return;
    const match = MATCHES.find((item) => item.id === Number(button.dataset.matchId));
    if (!match) return;
    selectedMatchId = match.id;
    renderBroadcasts(match);
    const broadcastSection = document.querySelector(".broadcast-grid").closest("details");
    if (broadcastSection) broadcastSection.open = true;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.querySelector(".broadcast-grid").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  });
  el.filters.forEach((button) => {
    button.addEventListener("click", () => {
      el.filters.forEach((item) => {
        const on = item === button;
        item.classList.toggle("active", on);
        item.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderSchedule(button.dataset.filter);
    });
  });

  if (el.resultPager) {
    el.resultPager.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button || button.disabled) return;
      historyPage += button.dataset.page === "next" ? 1 : -1;
      renderHistory();
      el.resultList.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // --- Carrossel da rodada: tocar na faixa, swipe (mobile), setas (desktop) ---
  if (el.dayStrip) {
    el.dayStrip.addEventListener("click", (event) => {
      const pill = event.target.closest("button[data-match-id]");
      if (!pill) return;
      activeMatchId = Number(pill.dataset.matchId);
      renderNext();
    });
  }
  const panel = document.querySelector(".match-panel");
  if (panel) {
    let sx = 0;
    let sy = 0;
    let tracking = false;
    panel.addEventListener("touchstart", (e) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    panel.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      // swipe horizontal de verdade (ignora rolagem vertical e toques curtos)
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        moveCard(dx < 0 ? 1 : -1); // arrasta p/ a esquerda = próximo jogo
      }
    }, { passive: true });
  }
}

async function loadData() {
  const [matchesDoc, broadcastsDoc] = await Promise.all([
    fetch("data/matches.json", { cache: "no-store" }).then((response) => response.json()),
    fetch("data/broadcasts.json", { cache: "no-store" }).then((response) => response.json())
  ]);
  MATCHES = matchesDoc.matches.slice().sort((a, b) => utcDate(a) - utcDate(b));
  BROADCASTS = (broadcastsDoc && broadcastsDoc.games) || {};
}

// --- "Meus Acréscimos": coluna diária de opinião (1ª aba abaixo do card) ---
// Lê o today.json (texto do dia + base de likes semeada), preenche a seção, ABRE na 1ª
// visita do dia (depois que o usuário fecha, fica fechada o resto do dia), e cuida do like
// (base semeada + 1 do próprio aparelho; sem backend de likes reais ainda — impulso inicial).
function acEscape(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
  ));
}

async function renderAcrescimos() {
  let doc;
  try {
    doc = await fetch("data/today.json", { cache: "no-store" }).then((r) => r.json());
  } catch (e) {
    return; // sem coluna do dia → a seção fica oculta, sem quebrar nada
  }
  const sec = document.getElementById("acrescimos");
  if (!sec || !doc || !doc.paragraphs) return;

  const dateEl = document.getElementById("ac-date");
  if (dateEl) dateEl.textContent = doc.dateLabel ? `opinião do dia · ${doc.dateLabel}` : "opinião do dia";

  // Likes só entram quando há base semeada (likesBase no today.json). Sem ela — produção dos
  // likes ainda não concluída — o card sai limpo, sem a UI de curtidas. REATIVAR: basta o
  // today.json voltar a trazer "likesBase".
  const hasLikes = doc.likesBase != null;
  const base = Number(doc.likesBase) || 0;
  const likeKey = `sob_ac_like_${doc.date}`;
  let liked = false;
  try { liked = localStorage.getItem(likeKey) === "1"; } catch (e) { /* storage off */ }

  const paras = doc.paragraphs.map((p) => `<p class="ac-para">${acEscape(p)}</p>`).join("");
  const likesHtml = hasLikes
    ? `<div class="ac-likes">` +
        `<button type="button" class="ac-like-btn${liked ? " liked" : ""}" id="ac-like" aria-pressed="${liked}">` +
          `<span class="ac-heart" aria-hidden="true">♥</span> ` +
          `<span id="ac-like-count">${(base + (liked ? 1 : 0)).toLocaleString("pt-BR")}</span>` +
        `</button>` +
        `<span class="ac-like-label">curtidas</span>` +
      `</div>`
    : "";
  document.getElementById("ac-body").innerHTML =
    `<p class="ac-greeting">${acEscape(doc.greeting)}</p>` +
    paras +
    `<p class="ac-bordao">${acEscape(doc.bordao)}</p>` +
    likesHtml;
  sec.hidden = false;

  // Abre na 1ª visita do dia; marca "visto" quando o usuário FECHA (fica fechada depois).
  const seenKey = `sob_ac_seen_${doc.date}`;
  let seen = false;
  try { seen = localStorage.getItem(seenKey) === "1"; } catch (e) {}
  sec.open = !seen;
  sec.addEventListener("toggle", () => {
    if (!sec.open) { try { localStorage.setItem(seenKey, "1"); } catch (e) {} }
  });

  // Like: base semeada + 1 do próprio aparelho (sem servidor de likes reais ainda).
  const btn = document.getElementById("ac-like");
  if (btn) {
    btn.addEventListener("click", () => {
      const nowLiked = !btn.classList.contains("liked");
      try { localStorage.setItem(likeKey, nowLiked ? "1" : "0"); } catch (e) {}
      btn.classList.toggle("liked", nowLiked);
      btn.setAttribute("aria-pressed", String(nowLiked));
      document.getElementById("ac-like-count").textContent =
        (base + (nowLiked ? 1 : 0)).toLocaleString("pt-BR");
    });
  }
}

async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
  }

  bindEvents();

  try {
    await loadData();
  } catch (error) {
    el.nextTitle.textContent = "Não foi possível carregar os jogos";
    el.alertStatus.textContent = "Falha ao carregar os dados. Verifique a conexão e recarregue a página.";
    return;
  }

  // "Dia de seleção": na 1ª visita do dia, se a rodada tem Brasil/Portugal antes do
  // apito e ainda não comemoramos, abre o carrossel já nesse card (o efeito dispara no
  // renderNext quando o card aparece). Depois do apito, nada — não comemoramos sem placar.
  const celebTarget = celebrationTarget(new Date());
  if (celebTarget) activeMatchId = celebTarget.id;

  renderNext();
  renderSchedule();
  renderHistory();
  renderStandings();
  renderKnockout();
  renderAcrescimos(); // "Meus Acréscimos": 1ª aba abaixo do card, aberta na 1ª visita do dia

  if (localStorage.getItem("alertsEnabled") === "true" && "Notification" in window && Notification.permission === "granted") {
    scheduleAlerts();
  }

  window.setInterval(renderNext, 1000);
  updateLiveScore();
  window.setInterval(updateLiveScore, 45000);
  healRecentMatches(); // backfill imediato de jogos que o coletor não confirmou (ex.: madrugada)
  window.setInterval(healRecentMatches, 45000);
  window.setInterval(renderKnockout, 45000); // chaveamento + relabel da Classificação, frescos
}

boot();
