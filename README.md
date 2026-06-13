# Segue o Baile — Copa do Mundo 2026

PWA que mostra o próximo jogo da Copa (horários BR/PT), onde assistir, placar e
resultados ao vivo, com alerta 1h antes. No ar: **https://segueobaile.netlify.app**

## Estrutura
- **`site/`** — o app estático publicado no Netlify (HTML/CSS/JS, dados em `site/data/`, ícones em `site/assets/`).
- **`scripts/copa_fixtures.py`** — coletor dos jogos/placar/gols na API oficial da FIFA, grava `site/data/matches.json`.
- **`.github/workflows/update.yml`** — robô agendado (a cada ~15 min) que coleta e publica **24/7**, sem depender de nenhum computador ligado.

## Como funciona a automação
1. O robô roda na nuvem, busca os dados na FIFA e atualiza `site/data/matches.json`.
2. Se algo mudou, faz commit e publica no Netlify.
3. A coleta é "gated" por janela de jogo (dentro do script): fora dos jogos a maioria das execuções é um no-op barato; em dia de jogo, atualiza de perto.
4. O **placar ao vivo** roda no próprio navegador (busca direto na FIFA), então não depende do robô.

A transmissão por país (`site/data/broadcasts.json`) é curada à parte (extração por LLM + revisão humana) e versionada aqui.

## Segredos (GitHub → Settings → Secrets and variables → Actions)
- `NETLIFY_AUTH_TOKEN` — token de deploy do Netlify.
- `NETLIFY_SITE_ID` — id do site no Netlify.
