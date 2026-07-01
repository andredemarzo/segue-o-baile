#!/usr/bin/env python3
"""Coletor de fixtures da Copa do Mundo 2026 (fonte oficial: API da FIFA).

Determinístico, sem LLM. Busca os 104 jogos da api.fifa.com, normaliza para o
schema do app (data/matches.json), preserva os nomes de sede/cidade curados,
VALIDA o resultado e só então sobrescreve o arquivo — sempre com backup .bak.
Se a validação falhar, o arquivo de produção NÃO é tocado (saída com erro).

Uso: python3 copa_fixtures.py
Agendar no Hermes:
  hermes cron create "every 6h" --no-agent --script copa_fixtures.py \
    --name "Copa 2026 fixtures" --deliver local
"""
import datetime
import json
import os
import re
import shutil
import sys
import time
import urllib.request

API_URL = (
    "https://api.fifa.com/api/v3/calendar/matches"
    "?idCompetition=17&idSeason=285023&count=400&language=pt-BR"
)
TIMELINE_URL = (
    "https://api.fifa.com/api/v3/timelines/17/285023/{stage}/{match}?language=pt-BR"
)
# Endpoint /live (o MESMO que o front usa p/ o placar ao vivo): traz TÉCNICO (Coaches Role==0) e
# SUBSTITUIÇÕES (off/on/minuto) por jogo — âncora [D] editorial (o técnico como agente; o que ele
# mudou / usou o intervalo). LineupX/Y e stats por-jogador vêm NULL na FIFA → só o técnico+subs entram.
LIVE_URL = (
    "https://api.fifa.com/api/v3/live/football/17/285023/{stage}/{match}?language=pt-BR"
)
# Diretório do site. Local = Mac; na nuvem (GitHub Actions) vem por COPA_PROJECT_DIR.
PROJECT_DIR = os.environ.get(
    "COPA_PROJECT_DIR",
    os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "site")),
)
OUT = os.path.join(PROJECT_DIR, "data", "matches.json")
# Backup fica FORA da pasta publicada — senão o .bak é enviado junto no deploy.
BACKUP = os.path.abspath(os.path.join(PROJECT_DIR, os.pardir, "matches.json.bak"))
# Grade de transmissão (gerada por copa_broadcasts.py a partir dos jogos).
BCAST_OUT = os.path.join(PROJECT_DIR, "data", "broadcasts.json")
BCAST_BACKUP = os.path.abspath(os.path.join(PROJECT_DIR, os.pardir, "broadcasts.json.bak"))
TBD = "A definir"

# Mapa cidade(API FIFA) -> cidade-sede e estádio reais (curado uma vez, estável).
# A FIFA usa nomes metropolitanos (Los Angeles, Dallas, Miami); preservamos a sede real.
VENUE_BY_API_CITY = {
    "Cidade do México": {"city": "Cidade do México", "venue": "Estadio Azteca"},
    "Guadalajara": {"city": "Zapopan", "venue": "Estadio Akron"},
    "Toronto": {"city": "Toronto", "venue": "BMO Field"},
    "Los Angeles": {"city": "Inglewood", "venue": "SoFi Stadium"},
    "Área da baía de São Francisco": {"city": "Santa Clara", "venue": "Levi's Stadium"},
    "Nova Jersey": {"city": "East Rutherford", "venue": "MetLife Stadium"},
    "Boston": {"city": "Foxborough", "venue": "Gillette Stadium"},
    "Vancouver": {"city": "Vancouver", "venue": "BC Place"},
    "Houston": {"city": "Houston", "venue": "NRG Stadium"},
    "Dallas": {"city": "Arlington", "venue": "AT&T Stadium"},
    "Filadélfia": {"city": "Filadélfia", "venue": "Lincoln Financial Field"},
    "Monterrey": {"city": "Guadalupe", "venue": "Estadio BBVA"},
    "Atlanta": {"city": "Atlanta", "venue": "Mercedes-Benz Stadium"},
    "Seattle": {"city": "Seattle", "venue": "Lumen Field"},
    "Miami": {"city": "Miami Gardens", "venue": "Hard Rock Stadium"},
    "Kansas City": {"city": "Kansas City", "venue": "Arrowhead Stadium"},
}

# Normalização editorial de nomes de seleção: a FIFA define QUEM joga;
# aqui escolhemos COMO exibir (formas mais usuais para o público BR/PT).
TEAM_NAME_OVERRIDES = {
    "República da Coreia": "Coreia do Sul",
    "Tchéquia": "República Tcheca",
    "EUA": "Estados Unidos",
    "Curaçau": "Curaçao",
    "Holanda": "Países Baixos",
    "RI do Irã": "Irã",
    "RD do Congo": "RD Congo",
}

# Rótulos de fase: do texto pt-BR da FIFA para um rótulo claro e consistente.
STAGE_MAP = {
    "Primeira fase": "Fase de grupos",
    "Segundas de final": "16-avos de final",
    "Oitavas de final": "Oitavas de final",
    "Quartas de final": "Quartas de final",
    "Semifinal": "Semifinal",
    "Decisão do 3º lugar": "Disputa de 3º lugar",
    "Final": "Final",
}


def text(value):
    if isinstance(value, list):
        return "".join(n.get("Description", "") for n in value)
    return "" if value is None else str(value)


def fetch():
    req = urllib.request.Request(API_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def prettify_name(name):
    """FIFA entrega o sobrenome em CAIXA ALTA (RAÚL, KREJCI). Deixa em Title Case
    preservando hífens e acentos: "Julian QUINONES" -> "Julian Quinones"."""
    words = []
    for word in name.split():
        words.append("-".join(p.capitalize() for p in word.split("-")))
    return " ".join(words)


def fetch_scorers(id_stage, id_match):
    """Lê o timeline oficial do jogo e devolve os gols.
    Detecta gol pelo PLACAR que sobe (HomeGoals/AwayGoals incrementando), NÃO
    pelo Type: a FIFA marca gol de bola rolando como Type 0, mas PÊNALTI como
    Type 41 e GOL CONTRA como Type 34 — filtrar só Type 0 perdia esses (ex.:
    Catar 1-1 Suíça = pênalti + gol contra, ficava sem marcador). O placar que
    incrementa identifica QUALQUER gol; o lado (home/away) sai do placar que
    sobe (robusto p/ gol contra); o nome, do EventDescription ("Fulano (Time)...")."""
    url = TIMELINE_URL.format(stage=id_stage, match=id_match)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as response:
        data = json.load(response)
    scorers = []
    prev_h = prev_a = 0
    for event in data.get("Event") or []:
        home = event.get("HomeGoals")
        away = event.get("AwayGoals")
        if home is None or away is None:
            continue
        if home > prev_h:
            side = "home"
        elif away > prev_a:
            side = "away"
        else:
            prev_h, prev_a = home, away
            continue  # disputa de pênaltis ou evento sem mudança de placar
        prev_h, prev_a = home, away
        desc = text(event.get("EventDescription"))
        name = desc.split(" (")[0].strip() if "(" in desc else text(event.get("PlayerName"))
        if not name:
            continue
        low = desc.lower()
        note = ""
        if "contra" in low or "own goal" in low:
            note = "gc"
        elif any(k in low for k in ("pênalti", "penalti", "penálti", "penalty")):
            note = "p"
        scorer = {
            "name": prettify_name(name),
            "minute": text(event.get("MatchMinute")),
            "side": side,
        }
        if note:
            scorer["note"] = note
        scorers.append(scorer)
    # cartões (MESMA timeline, sem fetch extra): Type 2 = amarelo, Type 3 = vermelho. Usados pelo
    # EDITORIAL (suspensos/pendurados em copa_interpreter/copa_briefing); o front os ignora.
    # Unificado de editorial-dev (30/06) p/ os 2 coletores serem UM só.
    cards = []
    for event in data.get("Event") or []:
        t = event.get("Type")
        if t not in (2, 3):
            continue
        desc = text(event.get("EventDescription"))
        name = desc.split(" (")[0].strip() if "(" in desc else text(event.get("PlayerName"))
        team = desc.split(" (")[1].split(")")[0].strip() if " (" in desc and ")" in desc else ""
        if not name:
            continue
        cards.append({"name": prettify_name(name), "minute": text(event.get("MatchMinute")),
                      "type": "vermelho" if t == 3 else "amarelo", "team": team})
    return scorers, cards


def enrich_scorers(matches, stage_by_id, prev_by_id):
    """Para cada jogo ENCERRADO, anexa match['scorers'] e match['cards'] (MESMA timeline,
    um fetch só). Reaproveita o cache quando o placar não mudou (jogo encerrado não muda).
    Diferente dos gols, busca também os 0-0 (cartões existem em 0-0)."""
    fetched = 0
    for m in matches:
        if m.get("status") != 0 or m.get("homeScore") is None or m.get("awayScore") is None:
            continue
        prev = prev_by_id.get(m["id"]) or {}
        if (prev.get("scorers") is not None and prev.get("cards") is not None
                and prev.get("homeScore") == m["homeScore"]
                and prev.get("awayScore") == m["awayScore"]):
            m["scorers"] = prev["scorers"]
            m["cards"] = prev["cards"]
            continue
        try:
            m["scorers"], m["cards"] = fetch_scorers(stage_by_id.get(m["id"]), m["idMatch"])
            fetched += 1
        except Exception as exc:  # um timeline falho não derruba o coletor
            print(f"  aviso: timeline do jogo {m['id']} falhou: {exc}")
            if prev.get("scorers") is not None:
                m["scorers"] = prev["scorers"]
                m["cards"] = prev.get("cards", [])
    return fetched


def fetch_live(id_stage, id_match):
    """Do endpoint /live: TÉCNICO principal (Coaches Role==0) de cada lado + SUBSTITUIÇÕES
    (off/on/minuto). Devolve (home_coach, away_coach, [subs]). Escalação nominal e LineupX/Y NÃO
    entram (bloat sem stats por-jogador; XY=NULL na FIFA — a estrutura em-posse fica pela LENTE/M2)."""
    url = LIVE_URL.format(stage=id_stage, match=id_match)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as response:
        data = json.load(response)

    def head_coach(team):
        for c in (team.get("Coaches") or []):
            if c.get("Role") == 0:                       # Role 0 = técnico principal (1 = auxiliar)
                nm = text(c.get("Name")) or text(c.get("ShortName"))
                return prettify_name(nm) if nm else ""
        return ""

    def subs_of(team, side):
        out = []
        for s in (team.get("Substitutions") or []):
            off, on = text(s.get("PlayerOffName")), text(s.get("PlayerOnName"))
            if not (off or on):
                continue
            out.append({"off": prettify_name(off) if off else "", "on": prettify_name(on) if on else "",
                        "minute": text(s.get("Minute")), "side": side})
        return out

    home, away = data.get("HomeTeam") or {}, data.get("AwayTeam") or {}
    return (head_coach(home), head_coach(away),
            subs_of(home, "home") + subs_of(away, "away"))


def enrich_live(matches, stage_by_id, prev_by_id):
    """Anexa homeCoach/awayCoach/subs a cada jogo ENCERRADO (fetch /live). Cacheado como scorers:
    reusa quando o placar não mudou (jogo encerrado não muda). Um /live falho não derruba o coletor."""
    fetched = 0
    for m in matches:
        if m.get("status") != 0 or m.get("homeScore") is None or m.get("awayScore") is None:
            continue
        prev = prev_by_id.get(m["id"]) or {}
        if (prev.get("homeCoach") is not None and prev.get("subs") is not None
                and prev.get("homeScore") == m["homeScore"]
                and prev.get("awayScore") == m["awayScore"]):
            m["homeCoach"], m["awayCoach"], m["subs"] = (
                prev.get("homeCoach"), prev.get("awayCoach"), prev.get("subs"))
            continue
        try:
            m["homeCoach"], m["awayCoach"], m["subs"] = fetch_live(stage_by_id.get(m["id"]), m["idMatch"])
            fetched += 1
        except Exception as exc:                          # timeline/live falho não derruba o coletor
            print(f"  aviso: /live do jogo {m['id']} falhou: {exc}")
            if prev.get("homeCoach") is not None:
                m["homeCoach"], m["awayCoach"], m["subs"] = (
                    prev.get("homeCoach"), prev.get("awayCoach"), prev.get("subs", []))
    return fetched


def offset_hours(local_iso, utc_iso):
    parse = lambda s: datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
    return round((parse(local_iso) - parse(utc_iso)).total_seconds() / 3600)


def team_name(side):
    if not side:
        return TBD
    name = text(side.get("TeamName"))
    if not name:
        return TBD
    return TEAM_NAME_OVERRIDES.get(name, name)


def build():
    results = fetch().get("Results") or []
    matches = []
    stage_by_id = {}
    for m in results:
        num = m.get("MatchNumber")
        local = m.get("LocalDate")
        utc = m.get("Date")
        if not num or not local or not utc:
            continue
        stage_by_id[num] = m.get("IdStage")
        city_api = text((m.get("Stadium") or {}).get("CityName"))
        venue_info = VENUE_BY_API_CITY.get(city_api)
        group_raw = text(m.get("GroupName"))
        stage_raw = text(m.get("StageName"))
        matches.append({
            "id": num,
            "idMatch": m.get("IdMatch"),
            "idStage": m.get("IdStage"),
            "stage": STAGE_MAP.get(stage_raw, stage_raw),
            "group": group_raw.replace("Grupo ", "").strip() if group_raw else "",
            "date": local[:10],
            "time": local[11:16],
            "offset": offset_hours(local, utc),
            "home": team_name(m.get("Home")),
            "away": team_name(m.get("Away")),
            # Só persiste placar de jogo ENCERRADO. O placar ao vivo é client-side
            # (vem direto da FIFA), então gravá-lo aqui só gerava deploy a cada tick
            # de 15min durante os jogos — sem valor e caro. Status colapsado em
            # 0 (encerrado) / 1 (não encerrado): o cliente pega "ao vivo" da FIFA.
            "status": 0 if m.get("MatchStatus") == 0 else 1,
            "homeScore": m.get("HomeTeamScore") if m.get("MatchStatus") == 0 else None,
            "awayScore": m.get("AwayTeamScore") if m.get("MatchStatus") == 0 else None,
            # Pênaltis (mata-mata): registro oficial CONGELADO no JSON, p/ não depender do liveById
            # efêmero — um KO decidido nos pênaltis visto numa sessão nova mostrava empate cru sem o
            # vencedor. None em jogo de grupo / sem disputa. Campo confirmado no endpoint calendar.
            "homePen": m.get("HomeTeamPenaltyScore") if m.get("MatchStatus") == 0 else None,
            "awayPen": m.get("AwayTeamPenaltyScore") if m.get("MatchStatus") == 0 else None,
            # Formação tática oficial da FIFA (Home/Away.Tactics: string GRANULAR "4-1-2-3", "3-4-3" —
            # o "tipo" que a leitura tática exige, não o rótulo grosso 4-3-3). Só de jogo ENCERRADO:
            # a FIFA só publica pós-jogo (verificado: 79/79 encerrados têm nos 2 lados, 0/25 futuros).
            # É o lastro [D] que o editorial ancora na análise tática (nunca inventa esquema). None sem dado.
            "homeTactics": (text((m.get("Home") or {}).get("Tactics")) or None) if m.get("MatchStatus") == 0 else None,
            "awayTactics": (text((m.get("Away") or {}).get("Tactics")) or None) if m.get("MatchStatus") == 0 else None,
            # Estrutura do chaveamento (só mata-mata): PlaceHolderA/B da FIFA (ex.: "2A" = 2º do grupo A,
            # "W73" = vencedor do jogo 73, "3ABCDF" = melhor 3º). O front desenha o cruzamento
            # ("Venc. J73") enquanto o time não está definido, e preenche o nome real quando a FIFA define.
            "placeholderA": m.get("PlaceHolderA") if not group_raw else None,
            "placeholderB": m.get("PlaceHolderB") if not group_raw else None,
            "city": venue_info["city"] if venue_info else city_api,
            "venue": venue_info["venue"] if venue_info else text((m.get("Stadium") or {}).get("Name")),
        })
    matches.sort(key=lambda x: x["id"])
    return matches, stage_by_id


def validate(matches):
    errors = []
    if len(matches) != 104:
        errors.append(f"esperado 104 jogos, veio {len(matches)}")
    if sorted(m["id"] for m in matches) != list(range(1, 105)):
        errors.append("ids dos jogos não formam a sequência 1..104")
    group_games = [m for m in matches if m["group"]]
    if len(group_games) != 72:
        errors.append(f"esperado 72 jogos de fase de grupos, veio {len(group_games)}")
    for m in group_games:
        if m["home"] == TBD or m["away"] == TBD:
            errors.append(f"jogo de grupo {m['id']} sem times definidos")
        if not (m["date"].startswith("2026-06") or m["date"].startswith("2026-07")):
            errors.append(f"data implausível no jogo {m['id']}: {m['date']}")
        if not (-8 <= m["offset"] <= -3):
            errors.append(f"offset implausível no jogo {m['id']}: {m['offset']}")
    # Mata-mata: cada jogo precisa do cruzamento (placeholderA/B da FIFA), senão a árvore do
    # chaveamento mostra "A definir × A definir" sem contexto (fere "nunca info incompleta").
    ko_games = [m for m in matches if not m["group"]]
    if len(ko_games) != 32:
        errors.append(f"esperado 32 jogos de mata-mata, veio {len(ko_games)}")
    for m in ko_games:
        if not m.get("placeholderA") or not m.get("placeholderB"):
            errors.append(f"jogo de mata-mata {m['id']} sem placeholder de cruzamento")
    return errors


HOT_BEFORE = datetime.timedelta(minutes=30)  # começa a atualizar 30min antes do apito
HOT_AFTER = datetime.timedelta(hours=3)       # segue até 3h depois (captura placar/gols finais)
# Enquanto um jogo que JÁ começou ainda não foi finalizado nos nossos dados (status≠0),
# o coletor segue "quente" por até este tempo — assim o ÚLTIMO jogo da rodada não fica
# sem placar se a FIFA confirmar tarde ou o agendador (best-effort) pular a janela fixa.
PENDING_FINALIZE = datetime.timedelta(hours=12)


def should_run_now():
    """Em dia de jogo queremos rodar de pouco em pouco; nos demais momentos, evitar.
    True se estamos numa janela de partida (ao vivo / recém-encerrada / prestes a
    começar) ou num horário-base (~4x/dia, p/ pegar mudanças de tabela/mata-mata)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    if now.hour % 6 == 0 and now.minute < 20:  # ~00/06/12/18 UTC: refresh de base
        return True
    if not os.path.exists(OUT):
        return True  # sem schedule local ainda — roda (fail-open)
    try:
        matches = json.load(open(OUT, encoding="utf-8")).get("matches", [])
    except Exception:
        return True  # arquivo ilegível — roda por segurança
    for m in matches:
        date, time, offset = m.get("date"), m.get("time"), m.get("offset")
        if not date or not time or offset is None:
            continue
        try:
            local = datetime.datetime.strptime(f"{date} {time}", "%Y-%m-%d %H:%M")
            kickoff = (local - datetime.timedelta(hours=offset)).replace(tzinfo=datetime.timezone.utc)
        except Exception:
            continue
        if kickoff - HOT_BEFORE <= now <= kickoff + HOT_AFTER:
            return True
        # Jogo já começou e ainda não finalizamos (status≠0): segue quente até capturar
        # o resultado — cobre o último jogo da rodada confirmado tarde (bug do Irã).
        if (m.get("status") != 0 and m.get("home") != TBD and m.get("away") != TBD
                and kickoff <= now <= kickoff + PENDING_FINALIZE):
            return True
    return False


# ---------------------------------------------------------------------------
# "Quem leva?" — probabilidade pré-jogo pelo índice Elo (eloratings.net).
# Transparente: força das seleções (rating Elo) -> vitória/empate/vitória.
# ---------------------------------------------------------------------------
ELO_TSV = "https://www.eloratings.net/World.tsv"

# Nossos 48 times (pt-BR) -> código de 2 letras do eloratings (validado por nome).
ELO_CODE = {
    "Alemanha": "DE", "Argentina": "AR", "Argélia": "DZ", "Arábia Saudita": "SA",
    "Austrália": "AU", "Brasil": "BR", "Bélgica": "BE", "Bósnia e Herzegovina": "BA",
    "Cabo Verde": "CV", "Canadá": "CA", "Catar": "QA", "Colômbia": "CO",
    "Coreia do Sul": "KR", "Costa do Marfim": "CI", "Croácia": "HR", "Curaçao": "CW",
    "Egito": "EG", "Equador": "EC", "Escócia": "SQ", "Espanha": "ES",
    "Estados Unidos": "US", "França": "FR", "Gana": "GH", "Haiti": "HT",
    "Inglaterra": "EN", "Iraque": "IQ", "Irã": "IR", "Japão": "JP", "Jordânia": "JO",
    "Marrocos": "MA", "México": "MX", "Noruega": "NO", "Nova Zelândia": "NZ",
    "Panamá": "PA", "Paraguai": "PY", "Países Baixos": "NL", "Portugal": "PT",
    "RD Congo": "CD", "República Tcheca": "CZ", "Senegal": "SN", "Suécia": "SE",
    "Suíça": "CH", "Tunísia": "TN", "Turquia": "TR", "Uruguai": "UY",
    "Uzbequistão": "UZ", "África do Sul": "ZA", "Áustria": "AT",
}


def fetch_elo():
    """{code: rating} a partir do World.tsv (col 3 = código, col 4 = Elo atual)."""
    req = urllib.request.Request(ELO_TSV, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read().decode()
    elo = {}
    for line in raw.splitlines():
        cols = line.split("\t")
        if len(cols) > 3 and cols[2] and cols[3].lstrip("-−").isdigit():
            elo[cols[2]] = int(cols[3])
    return elo


def win_probabilities(elo_home, elo_away):
    """Elo -> (casa, empate, fora) em % inteiras somando 100. Mando neutro (Copa).
    We = 1/(1+10^(-Δ/400)); empate = 0.30·(1-|2We-1|) (máx em jogo equilibrado)."""
    we = 1.0 / (1.0 + 10 ** (-(elo_home - elo_away) / 400.0))
    p_draw = 0.30 * (1 - abs(2 * we - 1))
    p_home = max(0.0, we - p_draw / 2)
    p_away = max(0.0, (1 - we) - p_draw / 2)
    total = p_home + p_draw + p_away
    home = round(p_home / total * 100)
    draw = round(p_draw / total * 100)
    away = max(0, 100 - home - draw)
    return {"home": home, "draw": draw, "away": away}


def enrich_probabilities(matches, prev_by_id):
    """Adiciona match['prob'] aos jogos FUTUROS (status 1) com os dois times definidos.
    Se o Elo não carregar AGORA — por erro OU por resposta VAZIA/bloqueada (o
    eloratings às vezes serve conteúdo vazio para IPs de datacenter como o do
    GitHub Actions) — PRESERVA a prob anterior, em vez de apagá-la em silêncio."""
    upcoming = [m for m in matches
                if m.get("status") == 1 and m["home"] in ELO_CODE and m["away"] in ELO_CODE]
    if not upcoming:
        return 0

    def keep_prev(m):
        prev = prev_by_id.get(m["id"]) or {}
        if prev.get("prob"):
            m["prob"] = prev["prob"]
            return True
        return False

    try:
        elo = fetch_elo()
    except Exception as exc:
        elo = {}
        print(f"  aviso: Elo falhou ({exc})")
    # Resposta vazia/insuficiente também é falha (esperado ~240 seleções no TSV).
    if len(elo) < 50:
        kept = sum(1 for m in upcoming if keep_prev(m))
        print(f"  aviso: Elo vazio/insuficiente ({len(elo)} times); prob preservada em {kept}/{len(upcoming)} jogo(s)")
        return 0
    done = 0
    for m in upcoming:
        home_elo = elo.get(ELO_CODE[m["home"]])
        away_elo = elo.get(ELO_CODE[m["away"]])
        if home_elo is None or away_elo is None:
            keep_prev(m)  # time sem Elo nesta rodada: mantém o anterior, não apaga
            continue
        m["prob"] = win_probabilities(home_elo, away_elo)
        done += 1
    return done


# Temperatura na hora do jogo (previsão Open-Meteo, grátis, sem chave de API).
# Coordenadas das 16 sedes (estádio), curadas uma vez — estáveis. Chave = m["city"].
CITY_COORDS = {
    "Arlington": (32.7473, -97.0945),       # AT&T Stadium (Dallas)
    "Atlanta": (33.7554, -84.4009),         # Mercedes-Benz Stadium
    "Cidade do México": (19.3029, -99.1505),# Estádio Azteca
    "East Rutherford": (40.8135, -74.0745), # MetLife (Nova York/NJ)
    "Filadélfia": (39.9008, -75.1675),      # Lincoln Financial Field
    "Foxborough": (42.0909, -71.2643),      # Gillette Stadium (Boston)
    "Guadalupe": (25.6692, -100.2444),      # Estádio BBVA (Monterrey)
    "Houston": (29.6847, -95.4107),         # NRG Stadium
    "Inglewood": (33.9535, -118.3392),      # SoFi Stadium (Los Angeles)
    "Kansas City": (39.0489, -94.4839),     # Arrowhead Stadium
    "Miami Gardens": (25.9580, -80.2389),   # Hard Rock Stadium
    "Santa Clara": (37.4030, -121.9697),    # Levi's Stadium (São Francisco)
    "Seattle": (47.5952, -122.3316),        # Lumen Field
    "Toronto": (43.6332, -79.4185),         # BMO Field
    "Vancouver": (49.2768, -123.1120),      # BC Place
    "Zapopan": (20.6816, -103.4625),        # Estádio Akron (Guadalajara)
}


def fetch_weather(lat, lon, utc_kickoff):
    """Temperatura (°C, inteiro) prevista para a HORA do apito, via Open-Meteo."""
    date = utc_kickoff.strftime("%Y-%m-%d")
    url = (
        f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
        f"&hourly=temperature_2m&timezone=UTC&start_date={date}&end_date={date}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as response:
        data = json.load(response)
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []
    if not times or not temps:
        return None
    target = utc_kickoff.strftime("%Y-%m-%dT%H:00")
    temp = temps[times.index(target)] if target in times else temps[0]
    return round(temp) if temp is not None else None


WEATHER_BACKFILL = datetime.timedelta(days=3)  # ainda busca o clima de jogos recém-jogados


def enrich_weather(matches, prev_by_id):
    """match['weather'] = {tempC, at}: temperatura prevista para a hora do apito
    (Open-Meteo). Mantém UM snapshot por jogo com sede mapeada e o PRESERVA no ao
    vivo/encerrado — a temperatura do apito não muda e NÃO deve sumir do card.
    - FUTURO no alcance (~15d): (re)consulta com throttle de 6h (não muda a cada 15min).
    - Recém-jogado (até 3d) SEM snapshot: backfill uma vez (cobre o que o coletor antigo
      zerava ao começar o jogo). Com snapshot: congela.
    - Falha em qualquer ponto: mantém o anterior, nunca apaga."""
    now = datetime.datetime.now(datetime.timezone.utc)
    horizon = now + datetime.timedelta(days=15)
    floor = now - WEATHER_BACKFILL
    done = 0
    for m in matches:
        if m["city"] not in CITY_COORDS:
            continue
        prev = (prev_by_id.get(m["id"]) or {}).get("weather")
        try:
            local_dt = datetime.datetime.strptime(f"{m['date']} {m['time']}", "%Y-%m-%d %H:%M")
            kickoff = (local_dt - datetime.timedelta(hours=m["offset"])).replace(tzinfo=datetime.timezone.utc)
        except Exception:
            if prev:
                m["weather"] = prev
            continue
        # Fora da janela útil (muito no futuro, ou jogo antigo): só preserva o que houver.
        if kickoff > horizon or kickoff < floor:
            if prev:
                m["weather"] = prev
            continue
        # Já temos snapshot: congela — exceto jogo FUTURO com previsão velha (>6h), que reconsulta.
        if prev and prev.get("at"):
            try:
                stale = (now - datetime.datetime.fromisoformat(prev["at"])).total_seconds() >= 6 * 3600
            except Exception:
                stale = True
            if not (kickoff >= now and stale):
                m["weather"] = prev
                continue
        # Precisa buscar: jogo futuro (refresh) OU recém-jogado sem snapshot (backfill).
        lat, lon = CITY_COORDS[m["city"]]
        try:
            temp = fetch_weather(lat, lon, kickoff)
        except Exception:
            if prev:
                m["weather"] = prev  # falhou: mantém o anterior, não apaga
            continue
        if temp is None:
            if prev:
                m["weather"] = prev
            continue
        m["weather"] = {"tempC": temp, "at": now.isoformat(timespec="seconds")}
        done += 1
    return done


_YT_VID_RE = re.compile(r"/embed/([A-Za-z0-9_-]{6,})")


def _existing_streams(existing, canal, region):
    """Carry-over: {game_id: video_id} dos embeds EXATOS de `canal` na `region` já no broadcasts.json
    (o channel-live genérico — '.../embed/live_stream?channel=' — é ignorado). Preserva o vídeo certo
    quando a API não traz (jogo ao vivo saiu do 'upcoming', ou falha/quota/sem-chave)."""
    out = {}
    if not existing:
        return out
    for gid, g in (existing.get("games") or {}).items():
        for e in g.get(region, []):
            if e.get("canal") == canal:
                emb = e.get("embed", "")
                if "live_stream" in emb:
                    continue
                m = _YT_VID_RE.search(emb)
                if m:
                    out[gid] = m.group(1)
    return out


def write_broadcasts(matches):
    """Gera/atualiza data/broadcasts.json — grade de transmissão TIPADA por jogo
    (Motor 1, determinística, ancorada em direito oficial; ver copa_broadcasts.py).
    Roda sempre que o coletor roda; independe do change-gate dos jogos e só escreve
    quando a grade muda (mesma disciplina de backup do matches.json)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import copa_broadcasts
    except Exception as exc:  # módulo ausente não derruba o coletor de jogos
        print(f"  aviso: copa_broadcasts indisponível ({exc}); broadcasts.json não tocado")
        return
    doc = copa_broadcasts.document(matches)
    existing = None
    if os.path.exists(BCAST_OUT):
        try:
            existing = json.load(open(BCAST_OUT, encoding="utf-8"))
        except Exception:
            existing = None
    # CAMADA YOUTUBE (aditiva): embed do VÍDEO EXATO do jogo no @LiveModeTV_PT (abre o jogo certo, não
    # o channel-live genérico). Carry-over: preserva o vídeo já conhecido do broadcasts.json (durante
    # o jogo o stream sai do 'upcoming'); a API (upcoming=100 unid) só ACRESCENTA/atualiza, nunca
    # remove. Graciosa: sem chave/rede/quota mantém o carry-over (não regride pro channel-live).
    try:
        import copa_youtube
        streams_by_channel, n_fresh = [], 0
        for canal, ch_id, regiao_busca, regiao_grade in copa_youtube.YT_STREAM_CHANNELS:
            s = _existing_streams(existing, canal, regiao_grade)           # carry-over por canal
            fresh = copa_youtube.fetch_live_streams(matches, ch_id, regiao_busca)
            if fresh:
                s.update(fresh)                                            # aditivo: novos sobre conhecidos
                n_fresh += len(fresh)
            if s:
                streams_by_channel.append((canal, regiao_grade, s))
        if streams_by_channel:
            n = copa_broadcasts.apply_youtube(doc, streams_by_channel)
            tot = sum(len(s) for _, _, s in streams_by_channel)
            print(f"  YouTube: {tot} stream(s) embed exato em {n} jogo(s) [{n_fresh} da API]")
    except Exception as exc:  # API/rede/sem-chave não derruba a grade
        print(f"  aviso: camada YouTube pulada ({exc})")
    if (existing and existing.get("version") == doc["version"]
            and existing.get("games") == doc["games"]):
        return  # nada mudou na grade — não reescreve
    doc["updatedAt"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    if os.path.exists(BCAST_OUT):
        shutil.copy2(BCAST_OUT, BCAST_BACKUP)
    with open(BCAST_OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"  broadcasts.json atualizado ({len(doc['games'])} jogos).")


def main():
    # --validate-only: GATE DE DEPLOY (independe de coleta). Lê o matches.json EM DISCO e falha se
    # a estrutura estiver inválida (≠104 jogos, mata-mata sem placeholder de cruzamento, etc.). Roda
    # em TODO push, ANTES do wrangler, p/ barrar dado ruim empurrado por QUALQUER caminho — inclusive
    # o push manual por worktree, a brecha que zerou o chaveamento em 30/06.
    if "--validate-only" in sys.argv:
        try:
            disk = json.load(open(OUT, encoding="utf-8")).get("matches", [])
        except Exception as exc:
            print(f"GATE: nao consegui ler {OUT}: {exc}")
            sys.exit(1)
        errs = validate(disk)
        if errs:
            print(f"GATE REPROVOU — {OUT} invalido ({len(errs)} erro(s)):")
            for e in errs[:12]:
                print("  -", e)
            sys.exit(1)
        print(f"GATE OK — {OUT}: {len(disk)} jogos, estrutura de mata-mata integra.")
        return

    # COPA_FORCE=1 ignora o gate de janela (útil para testar o deploy na nuvem).
    if os.environ.get("COPA_FORCE") != "1" and not should_run_now():
        return  # fora de janela de jogo e de horário-base — não faz nada (silencioso)

    # previous é lido UMA vez (independe do fetch) — usado no enrich e no change-gate.
    previous = []
    if os.path.exists(OUT):
        try:
            previous = json.load(open(OUT, encoding="utf-8")).get("matches", [])
        except Exception:
            previous = []
    prev_by_id = {m["id"]: m for m in previous}

    # RESILIÊNCIA (causa-raiz do bracket stale 30/06): a FIFA às vezes dá um blip
    # (5xx/timeout/JSON truncado) OU uma resposta PARCIAL no instante exato da virada
    # de um mata-mata, que reprova a validação. Em vez de matar o run inteiro — sem
    # coleta, sem deploy —, tenta de novo com backoff (2s,4s,8s ≈ 14s, dentro da
    # cadência */15 sob concurrency). Só desiste, SEM tocar produção, após TODAS as
    # tentativas. (fetch/Elo/clima já falham-soft; o fetch da agenda era o ÚNICO ponto
    # duro cujo erro abortava tudo.)
    FETCH_ATTEMPTS = 4
    fetched = 0
    matches = None
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            matches, stage_by_id = build()
        except Exception as exc:  # rede/parse
            print(f"[tentativa {attempt}/{FETCH_ATTEMPTS}] erro ao buscar/parsear a FIFA: {exc}")
            if attempt == FETCH_ATTEMPTS:
                print("ERRO: FIFA inacessível após todas as tentativas — data/matches.json NÃO tocado")
                sys.exit(1)
            time.sleep(2 ** attempt)
            continue

        fetched = enrich_scorers(matches, stage_by_id, prev_by_id)
        enrich_live(matches, stage_by_id, prev_by_id)      # técnico + substituições ([D] editorial)
        enrich_probabilities(matches, prev_by_id)
        enrich_weather(matches, prev_by_id)

        errors = validate(matches)
        if not errors:
            break  # coleta íntegra — segue para o write
        print(f"[tentativa {attempt}/{FETCH_ATTEMPTS}] validação reprovou (resposta parcial?): "
              + "; ".join(errors[:3]))
        if attempt == FETCH_ATTEMPTS:
            print("VALIDAÇÃO FALHOU após todas as tentativas — data/matches.json NÃO foi alterado:")
            for e in errors[:12]:
                print("  -", e)
            sys.exit(1)
        time.sleep(2 ** attempt)

    # Grade de transmissão: regenera junto, mas com seu próprio change-gate.
    write_broadcasts(matches)

    changed = sum(1 for m in matches if prev_by_id.get(m["id"]) != m)
    if previous and changed == 0:
        # Nada mudou nos jogos — não reescreve nem notifica (watchdog silencioso).
        return
    knockout = [m for m in matches if not m["group"]]
    knockout_defined = sum(1 for m in knockout if m["home"] != TBD and m["away"] != TBD)

    doc = {
        "source": "API oficial da FIFA — api.fifa.com (idCompetition=17, idSeason=285023, language=pt-BR)",
        "sourceUrl": API_URL,
        "phase": "all",
        "updatedAt": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "matches": matches,
    }

    if os.path.exists(OUT):
        shutil.copy2(OUT, BACKUP)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(
        f"OK — {len(matches)} jogos gravados em data/matches.json "
        f"({len(knockout)} de mata-mata, {knockout_defined} já com times definidos). "
        f"{changed} registro(s) alterado(s) vs versão anterior; "
        f"gols buscados em {fetched} jogo(s)."
    )


if __name__ == "__main__":
    main()
