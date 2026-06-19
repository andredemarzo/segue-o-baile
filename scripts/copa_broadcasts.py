#!/usr/bin/env python3
"""
Motor 1 — GRADE DE TRANSMISSÃO por jogo (determinístico, ancorado em direito oficial).

Resolve, para os 104 jogos, ONDE ASSISTIR (TV aberta · TV paga · streaming) no
Brasil e em Portugal, com link/embed — cada entrada carregando CONFIANÇA + FONTE
(data lineage). Roda no coletor 24/7 e gera site/data/broadcasts.json; nada de
input manual, nada inventado.

HIERARQUIA DE FONTE (a regra honesta):
  1) DIREITO (prova primária): FIFA Media Rights Licensees Overview (11/06/2026).
       BR: Globo, N Sports, SBT (+ Livemode/CazéTV digital).
       PT: Sport TV Portugal, TVI, RTP (+ SIC via acordo de sinal aberto).
  2) QUANTOS / aberto×pago (imprensa citada):
       CazéTV/Livemode = 104 jogos grátis no Brasil (Fortune).  Globo = 55 (Fortune).
       Sport TV = todos os jogos em Portugal (Observador).
       RTP/SIC/TVI = 20 jogos em sinal aberto, incl. TODOS os de Portugal +
       abertura, meias-finais e final (Diário de Notícias).
  3) QUAL jogo onde (operacional): grade oficial publicada -> camada SOURCED
       (broadcast_grade_seed.json). É override de alta confiança sobre a regra.

CONFIANÇA por entrada:
  - "confirmado": constante de direito (CazéTV 104 / Sport TV 104) OU grade
                  oficial publicada do jogo (seed).
  - "provavel"  : derivado do direito com alta probabilidade (jogo do Brasil ->
                  Globo; jogo de Portugal -> sinal aberto), sem a grade exata.
  - "a-confirmar": o direito existe mas ESTE jogo não está confirmado na grade —
                  nunca chuta; o app mostra "a confirmar" e mantém o grátis que vale.

Assim, TODO jogo tem sempre o piso grátis correto (CazéTV no BR; Sport TV pago +
LiveMode/aberto quando vale no PT), e o canal aberto específico só aparece como
fato quando há grade. O "CazéTV em todos" sozinho deixa de existir: cada jogo
leva também o aberto/pago real do país, e o que não se sabe fica honesto.
"""
import json
import os

DIR = os.path.dirname(os.path.abspath(__file__))
SEED_PATH = os.path.join(DIR, "broadcast_grade_seed.json")

# ---------------------------------------------------------------------------
# Catálogo de canais — tipo (aberta|paga|streaming), acesso, url e embed (player
# no app). Fonte única da verdade sobre os canais; o app consome o que sai daqui.
# ---------------------------------------------------------------------------
CH = {
    # Brasil
    "CazéTV":    {"regiao": "BR", "tipo": "streaming", "acesso": "grátis",
                  "url": "https://www.youtube.com/@CazeTV/live",
                  "embed": "https://www.youtube.com/embed/live_stream?channel=UCZiYbVptd3PVPf4f6eR6UaQ"},
    "Globo":     {"regiao": "BR", "tipo": "aberta", "acesso": "grátis", "url": "https://globoplay.globo.com/"},
    "SporTV":    {"regiao": "BR", "tipo": "paga", "acesso": "assinatura", "url": "https://globoplay.globo.com/"},
    "ge TV":     {"regiao": "BR", "tipo": "streaming", "acesso": "conta", "url": "https://ge.globo.com/"},
    "Globoplay": {"regiao": "BR", "tipo": "streaming", "acesso": "conta", "url": "https://globoplay.globo.com/"},
    "SBT":       {"regiao": "BR", "tipo": "aberta", "acesso": "grátis", "url": "https://www.sbt.com.br/aovivo"},
    "N Sports":  {"regiao": "BR", "tipo": "paga", "acesso": "assinatura", "url": "https://www.youtube.com/@NSports"},
    # Portugal
    "Sport TV":  {"regiao": "PT", "tipo": "paga", "acesso": "assinatura", "url": "https://www.sporttv.pt/"},
    "RTP1":      {"regiao": "PT", "tipo": "aberta", "acesso": "grátis", "url": "https://www.rtp.pt/play/direto/rtp1"},
    "SIC":       {"regiao": "PT", "tipo": "aberta", "acesso": "grátis", "url": "https://opto.sic.pt/"},
    "TVI":       {"regiao": "PT", "tipo": "aberta", "acesso": "grátis", "url": "https://tviplayer.iol.pt/direto"},
    "LiveModeTV":{"regiao": "PT", "tipo": "streaming", "acesso": "grátis",
                  "url": "https://www.youtube.com/@LiveModeTV_PT/live",
                  "embed": "https://www.youtube.com/embed/live_stream?channel=UCrYhacSar0c5Oq_Qdl3SH-g"},
}

# Fontes (citadas em cada entrada — data lineage)
F_FIFA      = "FIFA Media Rights Licensees Overview (11/06/2026)"
F_CAZE      = "FIFA Media Rights + Fortune: CazéTV/Livemode transmite os 104 jogos no Brasil"
F_GLOBO     = "FIFA Media Rights (Globo) + Fortune: Globo exibe 55 jogos, incluindo todos os do Brasil"
F_GLOBO_AC  = "Globo exibe 55 dos 104 jogos (Fortune); o canal aberto deste jogo depende da grade publicada"
F_SBT       = "SBT (TV aberta, parceira FIFA no Brasil) sublicencia jogos selecionados, incl. da Seleção; online em sbt.com.br/aovivo"
F_SPORTTV   = "FIFA Media Rights (Sport TV Portugal) + Observador: Sport TV em todos os jogos"
F_PT_ABERTO = "Diário de Notícias: RTP/SIC/TVI transmitem 20 jogos em sinal aberto (todos os de Portugal, abertura, meias-finais e final)"
F_PT_AC     = "RTP/SIC/TVI exibem 20 dos 104 jogos em sinal aberto (DN); este jogo a confirmar na grade"
F_LIVEMODE  = "LiveModeTV (YouTube): jogos de Portugal e selecionados"


def load_seed():
    try:
        return json.load(open(SEED_PATH, encoding="utf-8"))
    except Exception:
        return {"br": {}, "pt_aberto": {}, "pt_livemode": {}}


def _entry(canal, confianca, fonte):
    c = CH[canal]
    e = {"canal": canal, "tipo": c["tipo"], "acesso": c["acesso"], "regiao": c["regiao"],
         "url": c["url"], "confianca": confianca, "fonte": fonte}
    if c.get("embed"):
        e["embed"] = c["embed"]
    return e


def _is_brazil(m):
    return m.get("home") == "Brasil" or m.get("away") == "Brasil"


def _is_portugal(m):
    return m.get("home") == "Portugal" or m.get("away") == "Portugal"


def _is_pt_open_fixture(m):
    """Jogos que o acordo RTP/SIC/TVI cobre em aberto além dos de Portugal (DN):
    abertura (jogo 1), semifinais e final."""
    stage = (m.get("stage") or "").lower()
    return m.get("id") == 1 or "semifinal" in stage or stage == "final"


def game_broadcasts(m, seed):
    """Grade tipada de UM jogo: {grade_br, grade_pt, br:[...], pt:[...]}."""
    gid = str(m["id"])
    br, pt = [], []
    grade_br = grade_pt = "regra"

    # ===================== BRASIL =====================
    # Constante grátis: CazéTV nos 104 (sempre — o piso que sempre vale).
    br.append(_entry("CazéTV", "confirmado", F_CAZE))

    seed_br = (seed.get("br") or {}).get(gid)
    if seed_br is not None:
        # Grade oficial publicada deste jogo: canais exatos = fato (fonte por jogo no seed).
        grade_br = "publicada"
        fonte_br = seed_br.get("fonte", "O Globo (grade publicada da 1ª rodada)")
        for tipo in ("aberta", "paga", "streaming"):
            for canal in seed_br.get(tipo, []):
                if canal in CH:
                    br.append(_entry(canal, "confirmado", fonte_br))
    elif _is_brazil(m):
        # Jogo do Brasil: Globo e SBT (abertas) costumam levar a Seleção; SporTV/N Sports (pagas) +
        # Globoplay (streaming). Sem a grade exata ficam "provavel" (o app mostra "a confirmar").
        br.append(_entry("Globo", "provavel", F_GLOBO))
        br.append(_entry("SBT", "provavel", F_SBT))
        br.append(_entry("SporTV", "provavel", F_GLOBO))
        br.append(_entry("N Sports", "provavel", F_SBT))
        br.append(_entry("Globoplay", "provavel", F_GLOBO))
    else:
        # Jogo genérico: Globo tem 55 de 104; não dá pra afirmar ESTE sem a grade (honesto).
        br.append(_entry("Globo", "a-confirmar", F_GLOBO_AC))
        br.append(_entry("SporTV", "a-confirmar", F_GLOBO_AC))

    # ===================== PORTUGAL =====================
    # Constante paga: Sport TV nos 104 (sempre).
    pt.append(_entry("Sport TV", "confirmado", F_SPORTTV))

    seed_open = (seed.get("pt_aberto") or {}).get(gid)
    seed_lm = (seed.get("pt_livemode") or {}).get(gid)
    if seed_open is not None:
        # Sinal aberto confirmado e citado para este jogo.
        grade_pt = "publicada"
        for canal in seed_open.get("canais", []):
            if canal in CH:
                pt.append(_entry(canal, "confirmado", seed_open.get("fonte") or F_PT_ABERTO))
    elif _is_portugal(m) or _is_pt_open_fixture(m):
        # Todos os jogos de Portugal (+ abertura/meias/final) em sinal aberto (DN); canal exato pode variar.
        for canal in ("RTP1", "SIC", "TVI"):
            pt.append(_entry(canal, "provavel", F_PT_ABERTO))
    else:
        # Pode ser um dos 20 em aberto, mas não confirmado para este jogo.
        pt.append(_entry("RTP1", "a-confirmar", F_PT_AC))

    if seed_lm is not None:
        pt.append(_entry("LiveModeTV", "confirmado", seed_lm.get("fonte") or F_LIVEMODE))
    elif _is_portugal(m):
        pt.append(_entry("LiveModeTV", "provavel", F_LIVEMODE))

    return {"grade_br": grade_br, "grade_pt": grade_pt, "br": br, "pt": pt}


def build(matches, seed=None):
    """{id(str): grade tipada} para todos os jogos."""
    if seed is None:
        seed = load_seed()
    return {str(m["id"]): game_broadcasts(m, seed) for m in matches}


def _slim_entry(e):
    # O cliente usa canal/tipo/acesso/regiao/url/embed/confianca; 'fonte' é só
    # auditoria (vive no gerador + seed) e não é renderizado — fora do payload.
    return {k: v for k, v in e.items() if k != "fonte"}


def document(matches, seed=None):
    """Documento do app (sem updatedAt — quem grava injeta o timestamp). Enxuto:
    cada entrada sai SEM 'fonte' (a proveniência detalhada fica no gerador/seed;
    a 'confianca' por entrada, que é o sinal honesto, permanece)."""
    full = build(matches, seed)
    games = {
        gid: {
            "grade_br": g["grade_br"], "grade_pt": g["grade_pt"],
            "br": [_slim_entry(e) for e in g["br"]],
            "pt": [_slim_entry(e) for e in g["pt"]],
        }
        for gid, g in full.items()
    }
    return {
        "version": 2,
        "generator": "copa_broadcasts.py",
        "rightsSource": F_FIFA,
        "note": ("Gerado deterministicamente dos direitos oficiais (FIFA) cruzados com imprensa citada. "
                 "CazéTV cobre os 104 jogos grátis no Brasil; Sport TV cobre os 104 (pago) em Portugal. "
                 "Canal aberto específico vem da grade publicada (confirmado) ou fica 'a-confirmar'. "
                 "Confiança por entrada; proveniência detalhada no gerador (copa_broadcasts.py) e no seed."),
        "games": games,
    }


def apply_youtube(doc, livemode_streams=None):
    """Camada YouTube (ADITIVA — regra do operador: nunca sobrepor). Para cada {game_id: video_id}
    do stream OFICIAL do @LiveModeTV_PT detectado, marca LiveModeTV CONFIRMADO no jogo COM o embed do
    VÍDEO EXATO (abre o jogo, não o channel-live genérico): ACRESCENTA se falta, faz UPGRADE+embed se
    já existe, NUNCA remove nem rebaixa. Devolve quantos jogos foram tocados (observabilidade)."""
    n = 0
    for gid, vid in (livemode_streams or {}).items():
        n += _merge_channel(doc["games"].get(str(gid)), "pt", "LiveModeTV", vid)
    return n


def _merge_channel(g, region, canal, video_id=None):
    if not g or canal not in CH:
        return 0
    embed = "https://www.youtube.com/embed/%s" % video_id if video_id else None
    for e in g.get(region, []):
        if e.get("canal") == canal:
            e["confianca"] = "confirmado"   # upgrade — nunca rebaixa nem remove
            if embed:
                e["embed"] = embed          # vídeo exato do jogo
            return 1
    ent = _slim_entry(_entry(canal, "confirmado", "youtube"))  # acrescenta
    if embed:
        ent["embed"] = embed
    g.setdefault(region, []).append(ent)
    return 1


if __name__ == "__main__":
    import sys
    mpath = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIR, os.pardir, "site", "data", "matches.json")
    matches = json.load(open(mpath, encoding="utf-8"))["matches"]
    print(json.dumps(document(matches), ensure_ascii=False, indent=2))
