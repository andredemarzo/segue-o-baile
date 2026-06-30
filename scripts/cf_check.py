#!/usr/bin/env python3
"""Fecha o FURO #2 da blindagem: verifica se o Cloudflare Pages 'segueobaile' é
DIRECT UPLOAD (só a Action/wrangler deploya → o gate cobre TODO deploy) ou tem
GIT-INTEGRATION ligado (um push auto-deploya PULANDO o gate). Consulta a API do
Cloudflare (precisa de CF_TOKEN/CF_ACCOUNT no ambiente — secrets do GitHub).
Sai 0 = Direct Upload (furo fechado); 1 = git-integration (furo aberto); 2 = erro de API."""
import json
import os
import sys
import urllib.request

PROJECT = "segueobaile"


def cf(path):
    tok = os.environ["CF_TOKEN"]
    acc = os.environ["CF_ACCOUNT"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{acc}/pages/projects/{PROJECT}{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    return json.load(urllib.request.urlopen(req, timeout=25))


def main():
    try:
        proj = cf("")
        deps = cf("/deployments?per_page=10")
    except Exception as exc:
        print(f"ERRO ao chamar a API do Cloudflare: {exc}")
        sys.exit(2)
    if not proj.get("success"):
        print("ERRO na API (projeto):", proj.get("errors"))
        sys.exit(2)

    result = proj.get("result") or {}
    source = result.get("source")  # None/{} = Direct Upload; dict com repo = Git-connected
    triggers = [(d.get("deployment_trigger") or {}).get("type") for d in (deps.get("result") or [])[:10]]
    # git-integration se há 'source' (repo conectado) OU algum deploy veio de github:push
    git_integration = bool(source) or any(t and "github" in str(t).lower() for t in triggers)

    out = {
        "project": PROJECT,
        "source": source,
        "recent_deploy_triggers": triggers,
        "git_integration": git_integration,
        "verdict": (
            "GIT-INTEGRATION LIGADO — um push pode deployar PULANDO o gate (FURO ABERTO)"
            if git_integration else
            "DIRECT UPLOAD — só a Action (wrangler) deploya; o gate cobre TODO deploy (FURO FECHADO)"
        ),
    }
    with open("cf_check.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2, default=str)
    print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
    sys.exit(1 if git_integration else 0)


if __name__ == "__main__":
    main()
