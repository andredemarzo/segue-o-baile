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
  scoreline: document.querySelector("#scoreline"),
  predict: document.querySelector("#predict"),
  city: document.querySelector("#city"),
  timeBr: document.querySelector("#time-br"),
  timePt: document.querySelector("#time-pt"),
  countLabel: document.querySelector("#count-label"),
  countdown: document.querySelector("#countdown"),
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

// Status real da FIFA para o jogo (0=encerrado, 1=futuro, 3=ao vivo), ou null se
// ainda não consultamos. Vem de liveById, que PERSISTE entre ciclos.
function liveStatus(match) {
  const l = liveById[match.id];
  return l && l.status != null ? l.status : null;
}
// Encerrado = o coletor já marcou (json status 0) OU a FIFA já confirmou (status 0).
// Uma vez encerrado, NUNCA volta a ser o card — isto mata a regressão.
function isFinished(match) {
  return match.status === 0 || liveStatus(match) === 0;
}
// Ao vivo só com status 3 REAL da FIFA — nunca inventado pelo relógio.
function isLive(match) {
  return liveStatus(match) === 3;
}

function getActiveMatch(now = new Date()) {
  return MATCHES.find((match) => {
    if (isFinished(match)) return false; // encerrado (json OU FIFA) nunca é o card
    const start = utcDate(match);
    return start <= now && now < new Date(start.getTime() + FOCAL_WINDOW_MS);
  });
}

function getNextMatch(now = new Date()) {
  return (
    getActiveMatch(now) ||
    MATCHES.find((match) => !isFinished(match) && utcDate(match) > now) ||
    MATCHES.filter((m) => !isFinished(m)).pop() ||
    MATCHES[MATCHES.length - 1]
  );
}

// Fase pela FONTE DA VERDADE: ENCERRADO (json status 0 OU FIFA status 0) tem
// prioridade > AO VIVO (só status 3 REAL da FIFA) > futuro/relógio. O relógio só
// dá "ao vivo provisório" a um jogo que começou e AINDA não foi confirmado encerrado
// — e o isFinished acima já barra os encerrados de verdade (fim do "ao vivo" falso).
function matchPhase(match) {
  if (isFinished(match)) return "finished";
  if (isLive(match)) return "live";
  const start = utcDate(match);
  const now = new Date();
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

// Streams ao vivo abertos/grátis (URLs de "direto" verificados). CazéTV cobre todos
// os jogos no Brasil; os de Portugal dependem do que está em sinal aberto / LiveModeTV.
const OPEN_STREAMS = {
  "CazéTV": { label: "CazéTV", via: "YouTube", region: "BR", url: "https://www.youtube.com/@CazeTV/live", embed: "https://www.youtube.com/embed/live_stream?channel=UCZiYbVptd3PVPf4f6eR6UaQ" },
  "Globo": { label: "Globo", via: "Globoplay", region: "BR", note: "requer conta", url: "https://globoplay.globo.com/" },
  "Ge TV": { label: "ge TV", via: "ge.globo", region: "BR", note: "requer conta", url: "https://ge.globo.com/" },
  "SBT": { label: "SBT", via: "N Sports", region: "BR", url: "https://www.youtube.com/@NSports/live", embed: "https://www.youtube.com/embed/live_stream?channel=UCf9WJPpsh5BHDY-OeISgIqA" },
  "LiveModeTV": { label: "LiveModeTV", via: "YouTube", region: "PT", url: "https://www.youtube.com/@LiveModeTV/live", embed: "https://www.youtube.com/embed/live_stream?channel=UCJ77nj1oS6reQD2BRbp5Mrg" },
  "RTP1": { label: "RTP1", via: "RTP Play", region: "PT", url: "https://www.rtp.pt/play/direto/rtp1" },
  "TVI": { label: "TVI", via: "TVI Player", region: "PT", url: "https://tviplayer.iol.pt/direto" },
  "SIC": { label: "SIC", via: "Opto", region: "PT", note: "requer conta", url: "https://opto.sic.pt/" }
};

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

function openStreamsFor(match) {
  const streams = [OPEN_STREAMS["CazéTV"]]; // Brasil: CazéTV no YouTube cobre todos os jogos
  // Brasil: demais canais da grade (Globo, ge TV, SBT) quando indicados para o jogo
  (BRAZIL_GLOBO_BROADCASTS[match.id] || []).forEach((channel) => {
    if (OPEN_STREAMS[channel] && channel !== "CazéTV") streams.push(OPEN_STREAMS[channel]);
  });
  // Portugal: sinal aberto (RTP1/TVI/SIC)
  const open = PORTUGAL_OPEN_BROADCASTS[match.id];
  if (open && Array.isArray(open.channels)) {
    open.channels.forEach((channel) => {
      if (OPEN_STREAMS[channel]) streams.push(OPEN_STREAMS[channel]);
    });
  }
  if (PORTUGAL_LIVEMODE_BROADCASTS[match.id]) streams.push(OPEN_STREAMS["LiveModeTV"]);
  const seen = new Set();
  return streams.filter((stream) => stream && !seen.has(stream.label) && seen.add(stream.label));
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
      const hint = stream.embed ? "assistir aqui" : (stream.note ? `${stream.via} · ${stream.note}` : stream.via);
      const tag = stream.region === "PT" ? "PT" : "BR";
      const other = stream.region !== preferredRegion ? " is-other-region" : "";
      return `<a class="stream-link${active ? " is-live" : ""}${other}" href="${stream.url}" target="_blank" rel="noopener noreferrer"${embedAttrs}><span class="region-tag">${tag}</span> ${stream.label} <small>${hint}</small></a>`;
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

const BRAZIL_COMMUNITY_SOURCE =
  "Tabela 365Scores compartilhada no r/Canarinho: o ícone Globo representa Globo, SporTV e Globoplay; SBT vem junto de N Sports.";
const BRAZIL_COMMUNITY_URL =
  "https://www.reddit.com/r/Canarinho/comments/1twyelb/onde_assistir_copa_do_mundo/";

const BRAZIL_GLOBO_SOURCE =
  "O Globo publicou a grade da primeira rodada no Brasil, com TV Globo, SBT, SporTV, ge TV e CazéTV por partida.";
const BRAZIL_GLOBO_URL =
  "https://oglobo.globo.com/play/noticia/2026/06/11/onde-assistir-aos-jogos-da-copa-do-mundo-saiba-onde-sera-transmitida-cada-partida-da-primeira-fase-da-competicao.ghtml";

const PORTUGAL_OBSERVADOR_SOURCE =
  "Observador publicou a divisão em Portugal: Sport TV em todos os jogos, LiveModeTV nos jogos de Portugal e RTP/SIC/TVI em sinal aberto nos jogos indicados.";
const PORTUGAL_OBSERVADOR_URL = "https://observador.pt/prognosticos/onde-assistir-mundial/";
const PORTUGAL_ATV_SOURCE =
  "A Televisão publicou o guia dos 20 jogos em sinal aberto na RTP, SIC e TVI.";
const PORTUGAL_ATV_URL =
  "https://www.atelevisao.com/tvi/guia-completo-dos-jogos-do-mundial-2026-na-rtp-sic-e-tvi/";
const PORTUGAL_TVI_SOURCE =
  "A TVI confirmou em fonte própria os seus jogos do Mundial e mantém o TVI Player como canal digital da emissora.";
const PORTUGAL_TVI_URL =
  "https://tvi.iol.pt/mundial-de-futebol/selecao-portuguesa/tvi-transmite-jogos-do-mundial-de-futebol";
const PORTUGAL_RTP_SOURCE =
  "A RTP confirmou em fonte própria França x Senegal, Suíça x Bósnia, Colômbia x Portugal e a final do Mundial.";
const PORTUGAL_RTP_URL =
  "https://www.rtp.pt/noticias/selecao-nacional/rtp-vai-transmitir-jogo-decisivo-de-portugal-na-fase-de-grupos-frente-a-colombia-e-a-final-do-mundial-2026_d1745622";
const PORTUGAL_SIC_SOURCE =
  "A SIC publicou o calendário da fase de grupos com os jogos que passam na SIC e os acessos SIC Direto/Opto SIC.";
const PORTUGAL_SIC_URL =
  "https://sic.pt/mundial-fifa-2026/2026-06-09-quando-e-e-a-que-horas--o-calendario-completo-das-72-partidas-da-fase-de-grupos-do-mundial-2026-ecd949ae";
const PORTUGAL_DN_SOURCE =
  "DN Brasil confirmou, para Portugal, quais jogos do Brasil passam na LiveModeTV/YouTube e quais ficam só na Sport TV.";
const PORTUGAL_DN_URL =
  "https://dnbrasil.dn.pt/a-copa-do-mundo-vem-a-confira-onde-ver-os-jogos-do-brasil-na-televiso-em-portugal";

let BRAZIL_GLOBO_BROADCASTS = {};

let BRAZIL_COMMUNITY_BROADCASTS = {};

let PORTUGAL_OPEN_BROADCASTS = {};

let PORTUGAL_LIVEMODE_BROADCASTS = {};

function brazilCommunityFor(match) {
  const channels = BRAZIL_COMMUNITY_BROADCASTS[match.id];
  if (!channels) return undefined;

  return {
    hasCaze: channels.includes("CazéTV"),
    hasGlobo: channels.includes("Globo"),
    hasSbt: channels.includes("SBT")
  };
}

function brazilGloboFor(match) {
  const channels = BRAZIL_GLOBO_BROADCASTS[match.id];
  if (!channels) return undefined;

  return {
    channels,
    hasCaze: channels.includes("CazéTV"),
    hasGlobo: channels.includes("Globo"),
    hasSporTv: channels.includes("SporTV"),
    hasGeTv: channels.includes("Ge TV"),
    hasSbt: channels.includes("SBT")
  };
}

function portugalFor(match) {
  return {
    open: PORTUGAL_OPEN_BROADCASTS[match.id],
    liveMode: PORTUGAL_LIVEMODE_BROADCASTS[match.id],
    hasSportTv: true,
    isPortugalGame: isTeam(match, "Portugal"),
    isBrazilGame: isTeam(match, "Brasil")
  };
}

function portugalOpenStreaming(channels) {
  return channels.map((channel) => {
    if (channel === "RTP1") return "RTP Play";
    if (channel === "SIC") return "SIC Direto/Opto SIC";
    if (channel === "TVI") return "TVI Player";
    return `${channel} online`;
  });
}

function portugalStreamingAccess(hasLiveMode, openStreaming) {
  const access = [];
  if (hasLiveMode) access.push("LiveModeTV: YouTube");
  openStreaming.forEach((channel) => {
    if (channel === "RTP Play") access.push("RTP Play: app/site");
    if (channel === "SIC Direto/Opto SIC") access.push("SIC Direto/Opto SIC: app/site");
    if (channel === "TVI Player") access.push("TVI Player: app/site");
  });
  return access.join(". ");
}

function joinOrNone(items, fallback) {
  return items.length ? items.join("; ") : fallback;
}

function broadcastData(match) {
  const brazilGame = isTeam(match, "Brasil");
  const brazilGlobo = brazilGloboFor(match);
  const brazilCommunity = brazilCommunityFor(match);
  const openTv = brazilGlobo
    ? [
        ...(brazilGlobo.hasGlobo ? ["Globo"] : []),
        ...(brazilGlobo.hasSbt ? ["SBT"] : [])
      ]
    : brazilCommunity
      ? [
          ...(brazilCommunity.hasGlobo ? ["Globo"] : []),
          ...(brazilCommunity.hasSbt ? ["SBT"] : [])
        ]
      : [];
  const payTv = brazilGlobo
    ? [
        ...(brazilGlobo.hasSporTv ? ["SporTV"] : [])
      ]
    : brazilCommunity
      ? [
          ...(brazilCommunity.hasGlobo ? ["SporTV"] : []),
          ...(brazilCommunity.hasSbt ? ["N Sports"] : [])
        ]
      : [];
  const streaming = brazilGlobo
    ? [
        ...(brazilGlobo.hasCaze ? ["CazéTV no YouTube"] : []),
        ...(brazilGlobo.hasGeTv ? ["ge TV"] : [])
      ]
    : brazilCommunity
      ? [
          ...(brazilCommunity.hasCaze ? ["CazéTV no YouTube"] : []),
          ...(brazilCommunity.hasGlobo ? ["Globoplay"] : [])
        ]
      : ["CazéTV no YouTube"];
  const portugal = portugalFor(match);
  const ptOpenChannels = portugal.open?.channels || [];
  const ptOpenNumbers = ptOpenChannels
    .map((channel) => {
      if (channel === "RTP1") return "RTP1 1";
      if (channel === "SIC") return "SIC 3";
      if (channel === "TVI") return "TVI 4";
      return "RTP1 1; SIC 3; TVI 4";
    })
    .join("; ");
  const ptOpenStreaming = portugalOpenStreaming(ptOpenChannels);
  const ptFreeStreaming = [
    ...(portugal.liveMode ? ["LiveModeTV no YouTube"] : []),
    ...ptOpenStreaming
  ];
  const ptFreeStreamingAccess = portugalStreamingAccess(Boolean(portugal.liveMode), ptOpenStreaming);
  const portugalNoteParts = [PORTUGAL_OBSERVADOR_SOURCE, PORTUGAL_ATV_SOURCE];
  if (ptOpenChannels.includes("TVI")) portugalNoteParts.push(PORTUGAL_TVI_SOURCE);
  if (ptOpenChannels.includes("RTP1")) portugalNoteParts.push(PORTUGAL_RTP_SOURCE);
  if (ptOpenChannels.includes("SIC")) portugalNoteParts.push(PORTUGAL_SIC_SOURCE);
  if (portugal.isBrazilGame) portugalNoteParts.push(PORTUGAL_DN_SOURCE);

  return {
    br: {
      note: brazilGlobo
        ? `${BRAZIL_GLOBO_SOURCE} ${brazilCommunity ? "Usei a tabela 365Scores/Reddit como complemento para N Sports." : ""}`
        : brazilCommunity
          ? `${BRAZIL_COMMUNITY_SOURCE} CazéTV segue confirmada por cobertura integral.`
        : `Ficha específica para ${teamText(match)}. Pacotes parciais só entram como confirmados quando a grade do jogo é conhecida.`,
      items: [
        {
          type: "TV aberta",
          channels: brazilGlobo || brazilCommunity ? joinOrNone(openTv, "Sem TV aberta indicada para este jogo") : "TV Globo; SBT",
          numbers: "Referência SP: Globo 5.1; SBT 4.1. Em outra cidade, muda pela afiliada local.",
          status: brazilGlobo ? (openTv.length ? "published" : "notFound") : brazilCommunity ? (openTv.length ? "community" : "notFound") : "partial",
          text: brazilGlobo
            ? openTv.length
              ? `Grade publicada pelo O Globo para ${teamText(match)}.`
              : "O Globo não indica TV aberta brasileira para este jogo."
            : brazilCommunity
              ? openTv.length
                ? `Indicado pela tabela 365Scores/Reddit para ${teamText(match)}. Conferir no guia da TV antes do jogo.`
                : "A tabela 365Scores/Reddit não indica TV aberta brasileira para este jogo."
            : brazilGame
              ? "Jogos do Brasil tendem a entrar nos pacotes nacionais, mas o canal exato deve vir da grade da partida."
              : "Globo/SBT têm pacotes parciais; este jogo só deve aparecer aqui se houver grade específica."
        },
        {
          type: "TV fechada",
          channels: brazilGlobo || brazilCommunity ? joinOrNone(payTv, "Sem TV fechada indicada para este jogo") : "SporTV; N Sports",
          numbers: payTv.includes("N Sports")
            ? "SporTV: SKY 39/439 HD; Claro 39/539 HD; Vivo 539; Oi 39 HD. N Sports: número varia por operadora."
            : "SporTV: SKY 39/439 HD; Claro 39/539 HD; Vivo 539; Oi 39 HD.",
          status: brazilGlobo ? (payTv.length ? (payTv.includes("N Sports") ? "mixed" : "published") : "notFound") : brazilCommunity ? (payTv.length ? "community" : "notFound") : "partial",
          text: brazilGlobo
            ? payTv.length
              ? "SporTV vem da grade publicada pelo O Globo; N Sports entra quando a tabela 365Scores/Reddit indica SBT/N Sports para o mesmo jogo."
              : "O Globo e a tabela complementar não indicam TV fechada brasileira para este jogo."
            : brazilCommunity
              ? payTv.length
                ? "Derivado da mesma tabela: Globo implica SporTV; SBT implica N Sports."
                : "A tabela 365Scores/Reddit não indica TV fechada brasileira para este jogo."
            : "Use o número acima só quando a partida aparecer na grade do canal."
        },
        {
          type: "Streaming grátis",
          channels: joinOrNone(streaming.filter((name) => name.includes("CazéTV")), "Sem streaming grátis indicado"),
          numbers: "YouTube: @CazeTV. Em Smart TV/FAST, procure por CazéTV no guia da plataforma.",
          status: brazilCommunity?.hasCaze ? "confirmed" : "notFound",
          text: "Confirmado para todos os 104 jogos no Brasil; é o caminho mais seguro para este jogo."
        },
        {
          type: "Streaming pago/FAST",
          channels: joinOrNone(streaming, "Sem streaming indicado"),
          numbers: "ge TV e Globoplay: app/site, sem número. Prime Video, Disney+, Samsung TV Plus, Sky+ e Mercado Play: buscar CazéTV.",
          status: brazilGlobo ? "published" : brazilCommunity ? "community" : "partial",
          text: brazilGlobo
            ? "ge TV aparece quando a grade do O Globo marca o streaming do grupo; CazéTV segue por cobertura integral."
            : brazilCommunity
              ? "CazéTV aparece por cobertura integral; Globoplay aparece quando a tabela marca Globo para o jogo."
            : "CazéTV é a cobertura integral; os demais dependem da seleção de jogos dos pacotes."
        }
      ]
    },
    pt: {
      note: `${portugalNoteParts.join(" ")} Ficha específica para ${teamText(match)}.`,
      items: [
        {
          type: "TV aberta",
          channels: portugal.open ? joinOrNone(ptOpenChannels, "Sinal aberto indicado, canal a confirmar") : "Sem TV aberta confirmada para este jogo",
          numbers: portugal.open ? `${ptOpenNumbers} na grelha comum/TDT. Na operadora, use o mesmo nome do canal.` : "RTP1 1; SIC 3; TVI 4, se a partida for escalada em aberto.",
          status: portugal.open ? (portugal.open.exact ? "published" : "rights") : "notFound",
          text: portugal.open
            ? portugal.open.exact
              ? `${portugal.open.source} indica ${joinOrNone(ptOpenChannels, "TV aberta")} para ${teamText(match)}.`
              : "As fontes colocam este jogo no pacote de 20 jogos em sinal aberto, mas não nomeiam ainda qual canal RTP/SIC/TVI."
            : "Não encontrei RTP/SIC/TVI confirmando TV aberta portuguesa para este jogo."
        },
        {
          type: "TV fechada",
          channels: "Sport TV",
          numbers: "SPORT.TV1: NOS 20; MEO 21. SPORT.TV2-7: NOS 21-26; MEO 22-27. Vodafone: procurar SPORT.TV na grelha.",
          status: "confirmed",
          text: "Confirmado para todos os 104 jogos em Portugal. O subcanal exato pode mudar na grelha Sport TV do dia."
        },
        {
          type: "Streaming grátis",
          channels: ptFreeStreaming.length ? joinOrNone(ptFreeStreaming, "") : "Sem streaming grátis confirmado para este jogo",
          numbers: ptFreeStreaming.length
            ? ptFreeStreamingAccess
            : "LiveModeTV terá 34 jogos, mas este jogo não apareceu nas listas consultadas.",
          status: ptFreeStreaming.length ? "published" : "notFound",
          text: ptFreeStreaming.length
            ? [
                ...(portugal.liveMode ? [`${portugal.liveMode.source} lista este jogo na LiveModeTV: ${portugal.liveMode.reason}.`] : []),
                ...(ptOpenStreaming.length ? ["Observador indica apps/sites da RTP, SIC e TVI nos jogos em sinal aberto."] : [])
              ].join(" ")
            : "Não marquei LiveModeTV nem app de emissora aberta porque as fontes encontradas não confirmam esta partida específica."
        },
        {
          type: "Streaming pago",
          channels: "Sport TV app/operadora",
          numbers: "Mesmo pacote Sport TV da operadora; sem número separado no app.",
          status: "confirmed",
          text: "Para assinantes, acompanha a cobertura integral da Sport TV."
        }
      ]
    }
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
  const data = broadcastData(match);
  const brazilGlobo = brazilGloboFor(match);
  const brazilCommunity = brazilCommunityFor(match);
  const brConfirmed = brazilGlobo
    ? [
        ...(brazilGlobo.hasCaze ? ["CazéTV"] : []),
        ...(brazilGlobo.hasGlobo || brazilGlobo.hasSporTv || brazilGlobo.hasGeTv
          ? [[
              ...(brazilGlobo.hasGlobo ? ["Globo"] : []),
              ...(brazilGlobo.hasSporTv ? ["SporTV"] : []),
              ...(brazilGlobo.hasGeTv ? ["ge TV"] : [])
            ].join("/")]
          : []),
        ...(brazilGlobo.hasSbt ? ["SBT"] : []),
      ]
    : brazilCommunity
      ? [
          ...(brazilCommunity.hasCaze ? ["CazéTV"] : [])
      ]
    : data.br.items.filter((item) => item.status === "confirmed").map((item) => item.channels.split(";")[0]);
  const ptAvailable = data.pt.items
    .filter((item) => item.type !== "Streaming pago")
    .filter((item) => item.status === "confirmed" || item.status === "published")
    .map((item) => item.channels);
  return {
    br: brConfirmed.length ? brConfirmed.join("; ") : "BR: sem transmissão confirmada",
    pt: ptAvailable.length ? ptAvailable.join("; ") : "PT: sem transmissão confirmada"
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

function renderNext() {
  const now = new Date();
  const match = getNextMatch(now);
  const start = utcDate(match);
  const phase = matchPhase(match);
  const bar = el.countdown.parentElement;
  const live = liveById[match.id];

  // Cabeçalho/cidade/horários/transmissão/predict só mudam quando o JOGO ou a FASE
  // muda (evita flicker a cada segundo).
  if (match.id !== renderedMatchId || phase !== renderedPhase) {
    el.nextTitle.textContent = `${stageLabel(match)} · Jogo ${match.id}`;
    el.city.textContent = `${match.city} · ${match.venue}`;
    el.timeBr.textContent = formatTime(start, BR_TZ, "pt-BR");
    el.timePt.textContent = formatTime(start, PT_TZ, "pt-PT");
    if (!selectedMatchId) renderBroadcasts(match);
    renderLiveStreams(match, phase === "live");
    renderPredict(match, phase);
    renderedMatchId = match.id;
    renderedPhase = phase;
  }

  // Placar + marcadores: re-renderiza quando o jogo, a fase OU o placar ao vivo muda.
  // (Único ponto que escreve o placar — sem dois renderizadores brigando.)
  const sig = `${match.id}|${phase}|${live ? `${live.home}-${live.away}/${live.homePen}-${live.awayPen}/${live.time}` : ""}|${liveScorersId === match.id ? liveScorers.length : 0}`;
  if (sig !== renderedScoreSig) {
    el.scoreline.innerHTML = scorelineHtml(match);
    renderedScoreSig = sig;
  }

  if (phase === "live") {
    bar.hidden = false;
    el.matchState.className = "badge badge-live";
    el.matchState.textContent = "Ao vivo";
    el.countLabel.textContent = "Tempo de jogo";
    el.countdown.textContent = (live && live.time) || "—";
  } else if (phase === "finished") {
    bar.hidden = true; // jogo acabou — o placar final já está no painel
    el.matchState.className = "badge badge-finished";
    el.matchState.textContent = "Encerrado";
  } else {
    bar.hidden = false;
    el.matchState.className = "badge badge-upcoming";
    el.matchState.textContent = "Próximo";
    el.countLabel.textContent = "Começa em";
    el.countdown.textContent = formatDistance(start - now);
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
    el.matchList.innerHTML = `<p class="plain-copy">Não há jogos futuros para este filtro na fase de grupos carregada.</p>`;
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

function renderHistory() {
  const section = document.querySelector(".section-results");
  const finished = MATCHES
    .filter((match) => match.status === 0 && match.homeScore != null && match.awayScore != null)
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
      const homeWin = match.homeScore > match.awayScore;
      const awayWin = match.awayScore > match.homeScore;
      return `
        <article class="result-row">
          <time datetime="${kickoff.toISOString()}">${shortDate(kickoff, BR_TZ, "pt-BR")}</time>
          <div class="result-match">
            <span class="result-team home${homeWin ? " win" : ""}">${match.home}</span>
            <span class="result-score">${match.homeScore} - ${match.awayScore}</span>
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
}

async function loadData() {
  const [matchesDoc, broadcastsDoc] = await Promise.all([
    fetch("data/matches.json", { cache: "no-store" }).then((response) => response.json()),
    fetch("data/broadcasts.json", { cache: "no-store" }).then((response) => response.json())
  ]);
  MATCHES = matchesDoc.matches.slice().sort((a, b) => utcDate(a) - utcDate(b));
  BRAZIL_GLOBO_BROADCASTS = broadcastsDoc.brazilGlobo || {};
  BRAZIL_COMMUNITY_BROADCASTS = broadcastsDoc.brazilCommunity || {};
  PORTUGAL_OPEN_BROADCASTS = broadcastsDoc.portugalOpen || {};
  PORTUGAL_LIVEMODE_BROADCASTS = broadcastsDoc.portugalLivemode || {};
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

  renderNext();
  renderSchedule();
  renderHistory();
  renderStandings();

  if (localStorage.getItem("alertsEnabled") === "true" && "Notification" in window && Notification.permission === "granted") {
    scheduleAlerts();
  }

  window.setInterval(renderNext, 1000);
  updateLiveScore();
  window.setInterval(updateLiveScore, 45000);
}

boot();
