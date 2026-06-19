#!/usr/bin/env python3
"""
YouTube Data API — detecta QUAIS jogos da Copa um canal transmite (+ o vídeo exato ao vivo).

Resolve o gap: @LiveModeTV_PT (streaming PT) e CazéTV (BR) transmitem jogos que o seed/regra
não marca. Em vez de ADIVINHAR, PERGUNTA ao YouTube o que o canal subiu/está ao vivo, casa pelo
TÍTULO com os nossos jogos (ambos os times no título, normalizado), e devolve {game_id: video_id}.
ADITIVO: o coletor só ACRESCENTA/confirma o detectado; nunca remove (regra do operador).

Custo (YouTube Data API, grátis 10k unidades/dia):
  - playlistItems.list (uploads) = 1 unidade → recentes/cobertura. BARATO (default).
  - search.list eventType=live = 100 unidades → vídeo AO VIVO exato. Só sob demanda (janela de jogo).

Chave: env YOUTUBE_API_KEY (Action) ou ~/.youtube_key (local). LIDA, NUNCA impressa/logada.
Falha de rede/quota é GRACIOSA: devolve vazio, o coletor segue com regra+seed.
"""
import json
import os
import re
import urllib.request

LIVEMODE_PT = "UCrYhacSar0c5Oq_Qdl3SH-g"   # @LiveModeTV_PT (canal ATIVO da Copa; o antigo @LiveModeTV=UCJ77 era vazio)
CAZETV = "UCZiYbVptd3PVPf4f6eR6UaQ"        # @CazeTV
_KEY_FILE = os.path.expanduser("~/.youtube_key")

# Aliases PT↔outras formas que aparecem em títulos (o resto casa pelo nome PT direto).
_ALIASES = {
    "paisesbaixos": ["holanda", "netherlands"], "coreiadosul": ["coreia", "korea"],
    "estadosunidos": ["eua", "usa"], "arabiasaudita": ["arabia"],
    "republicatcheca": ["tchequia", "chequia", "czech"], "bosniaeherzegovina": ["bosnia"],
    "africadosul": ["africa"], "costadomarfim": ["marfim", "ivory"], "novazelandia": ["nzelandia"],
}


def _key():
    return os.environ.get("YOUTUBE_API_KEY") or (_read(_KEY_FILE))


def _read(p):
    try:
        return open(p, encoding="utf-8").read().strip()
    except Exception:
        return ""


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def _uploads_playlist(channel_id, key):
    d = _get(f"https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id={channel_id}&key={key}")
    its = d.get("items", [])
    return its[0]["contentDetails"]["relatedPlaylists"]["uploads"] if its else None


def recent_videos(channel_id, key, n=25):
    """Vídeos recentes do canal (uploads playlist = 1 unidade). [{id, title}]."""
    pl = _uploads_playlist(channel_id, key)
    if not pl:
        return []
    d = _get(f"https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId={pl}&maxResults={n}&key={key}")
    out = []
    for it in d.get("items", []):
        s = it.get("snippet", {})
        vid = (s.get("resourceId") or {}).get("videoId")
        if vid:
            out.append({"id": vid, "title": s.get("title", "")})
    return out


def search_event(channel_id, key, event="live", n=10):
    """Vídeos ao vivo/agendados (search.list eventType= = 100 unidades). [{id, title, state}]."""
    url = (f"https://www.googleapis.com/youtube/v3/search?part=snippet&channelId={channel_id}"
           f"&eventType={event}&type=video&maxResults={n}&key={key}")
    d = _get(url)
    out = []
    for it in d.get("items", []):
        s = it.get("snippet", {})
        vid = (it.get("id") or {}).get("videoId")
        if vid:
            out.append({"id": vid, "title": s.get("title", ""), "state": s.get("liveBroadcastContent", "")})
    return out


def _norm(s):
    return re.sub(r"[^a-z]", "", (s or "").lower())


def _team_in(team_norm, title_norm):
    """Time no título: nome PT direto OU um alias conhecido."""
    if len(team_norm) > 3 and team_norm in title_norm:
        return True
    return any(a in title_norm for a in _ALIASES.get(team_norm, []))


def _video_score(title):
    """Prefere o stream OFICIAL do jogo (DIRETO/TRANSMISSÃO) a pré-jogo/replay/cortes."""
    t = (title or "").lower()
    s = 0
    if "oficial" in t or "em direto" in t or "transmiss" in t:
        s += 3
    if "ao vivo" in t:
        s += 1
    if any(w in t for w in ("aquece", "a seguir", "repeti", "highlight", "melhores", "compacto", "resumo", "lances")):
        s -= 3
    return s


def match_games(videos, matches):
    """Casa vídeo→jogo quando AMBOS os times aparecem no título. {game_id: {video_id, title}}.
    Conservador (dois times claros, evita falso-positivo) e, havendo vários candidatos do mesmo
    jogo, fica com o melhor: stream oficial AO VIVO > pré-jogo/replay/cortes."""
    out = {}
    for v in videos:
        t = _norm(v.get("title"))
        if not t:
            continue
        for m in matches:
            h, a = _norm(m.get("home", "")), _norm(m.get("away", ""))
            if h and a and _team_in(h, t) and _team_in(a, t):
                sc = _video_score(v.get("title"))
                cur = out.get(m["id"])
                if not cur or sc > cur.get("score", -99):
                    out[m["id"]] = {"video_id": v["id"], "title": v.get("title", ""), "score": sc}
                break
    return out


def fetch_live_streams(matches, channel_id=LIVEMODE_PT):
    """Streams AGENDADOS (upcoming) do canal casados por jogo → {game_id: video_id} (o vídeo EXATO do
    jogo, p/ embed preciso). search upcoming = 100 unidades. Durante o jogo o vídeo vira 'live' e sai
    do upcoming — o coletor faz carry-over do que já conhece. Graciosa a falha/sem-chave."""
    key = _key()
    if not key:
        return {}
    try:
        vids = search_event(channel_id, key, "upcoming")
    except Exception:
        return {}
    return {gid: info["video_id"] for gid, info in match_games(vids, matches).items()}


def detect(matches, channel_id=LIVEMODE_PT, include_live=False):
    """Detecta a cobertura do canal: casa os vídeos recentes (e, se include_live, os ao vivo)
    com os nossos jogos. Devolve {game_id: {video_id, title, live}}. Graciosa a falhas."""
    key = _key()
    if not key:
        return {}
    vids = []
    try:
        vids = recent_videos(channel_id, key)
        if include_live:
            vids = search_event(channel_id, key, "live") + search_event(channel_id, key, "upcoming") + vids
    except Exception:
        return {}
    return match_games(vids, matches)


if __name__ == "__main__":
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    mpath = os.path.join(here, os.pardir, "site", "data", "matches.json")
    matches = json.load(open(mpath, encoding="utf-8"))["matches"]
    ch = {"livemode": LIVEMODE_PT, "caze": CAZETV}.get((sys.argv[1] if len(sys.argv) > 1 else "livemode"), LIVEMODE_PT)
    key = _key()
    print("chave:", "presente" if key else "AUSENTE", "| canal:", ch)
    vids = recent_videos(ch, key)
    print(f"vídeos recentes (uploads): {len(vids)}")
    for v in vids[:15]:
        print("  •", v["title"][:75])
    hits = match_games(vids, matches)
    print(f"\n>>> JOGOS CASADOS (cobertura detectada): {len(hits)}")
    by = {m["id"]: m for m in matches}
    for gid, info in sorted(hits.items()):
        m = by[gid]
        print(f'  id {gid:>3} | {m["home"]} x {m["away"]} ({m["date"]}) -> "{info["title"][:50]}"')
