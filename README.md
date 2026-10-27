# Lapidare

*(antes chamado LearnHarness; o pacote Python, as variáveis `LEARNHARNESS_*` e a pasta `.harness/` do vault mantêm o nome técnico antigo por compatibilidade.)*

Uma plataforma local-first de estudo ativo, retenção e construção de conhecimento projetada para o **ecossistema Google**, combinando a experiência visual e editorial do `amosblomqvist/learnharness` com **persistência bidirecional em um Vault Markdown/Obsidian (`UI ⇄ Vault`)** e execução direta via **assinatura Google** (`@google/gemini-cli` e Google Antigravity `agy`).



---

## Por Que Este Projeto Existe

Este projeto nasce da convergência de duas linhagens que partiram do mesmo método de estudo ativo (`amosblomqvist/learn`):

1. **A profundidade pedagógica do sistema `ai-engineer`:**
   - Estudo estruturado por **Trilha integrada (`2:1`)**, ingestão de aulas densas/mentorias via **MCP** (com fatiamento em blocos, mapeamento do que foi *Dito / Pressuposto / Pulado / Simplificado* e ancoragem por parágrafo `#^pN`), prática de código e consolidação por **desenho de memória à mão livre no Excalidraw** com revisão multimodal.
2. **A excelência de UX/UI e engenharia de estado do `amosblomqvist/learnharness`:**
   - Lousa editorial sem balões de chat (`CMU Serif Bold` + `Source Sans 3` + `KaTeX` + `JetBrains Mono` sobre roxo escuro `#1a1430`), Grafo de Conhecimento central em Canvas 2D com cadeias de implicação lógica ($A \land B \implies C$), `QuestionDock` inline com calibração de confiança (`0–100%`) e campo *Your Thinking*, ditado por voz e pipelines em background de extração e prática (`Practice`).

---

## As 6 Leis Inegociáveis da Plataforma

1. **Zero Proliferação de Modos (`TEACH` e `PRACTICE` apenas):**
   - Não existe modo separado para "Aula Densa / Mentoria" ou "Currículo". Existem apenas **`TEACH`** (aprender) e **`PRACTICE`** (treinar a frio).
   - O próprio **`TEACH`** detecta os insumos da sessão (tema livre, fonte densa importada via MCP/arquivo, ou etapa da trilha ativa) e adapta seu fluxo automaticamente.
2. **A Trilha é Configurada no Setup e Conduzida pelo Harness:**
   - No Setup Inicial (ou em `Settings`), o usuário configura sua Trilha (via repositório/currículo + nivelamento adaptativo, objetivo descrito para geração automática, ou modo livre). A partir daí, o próprio Harness conduz o aluno exibindo o próximo passo num *chip* discreto acima do composer (`⇶ Trilha ativa · Próximo: ... [Continuar ↵]`).
3. **Um Único Grafo Central (Sem Divisão `Macro | Micro`):**
   - A Home apresenta **uma única visualização de grafo** em Canvas 2D acompanhada do botão `☍ Chains`. Nos bastidores, o sistema mantém cada conceito sincronizado com `Conceitos/<Tema>.md` no Vault e as proposições, cadeias e cobertura em `.harness/graph/{nodes,chains,coverage}.jsonl` (append-only; o grafo cresce sozinho a partir do que é ensinado).
4. **Persistência Dupla Não-Destrutiva (`UI ⇄ Vault`):**
   - Tudo acontece na UI Web **e** vive simultaneamente em Markdown/Excalidraw reais no Vault do usuário. Se o usuário não tiver um Vault no primeiro acesso, a plataforma cria e estrutura tudo automaticamente; se já tiver, adota sem sobrescrever nada.
5. **Execução Oficial na Assinatura Google (Zero Custo Extra de API):**
   - Suporte nativo desde a v0.1 aos **3 conectores sancionados do ecossistema Google**:
     1. `@google/gemini-cli` (`gemini --acp` / `stream-json` — funciona com *Login with Google*: Free, Google One AI Pro, AI Ultra e Workspace Code Assist).
     2. Google Antigravity CLI (`agy --input-format stream-json --output-format stream-json` + `--json-schema` + `--effort`).
     3. Fallback opcional via SDK oficial `google-genai` (`GEMINI_API_KEY` / Vertex AI).
6. **Arquitetura Hexagonal + Orquestração Híbrida (`FastMCP` + `LangGraph`):**
   - `backend/core/` puro em Python (`Pydantic`, zero I/O); sessões interativas ao vivo (`Prober → Teacher` e `Practice` com dicas `R0–R5`) rodam no loop nativo do `agy`/`gemini` falando com um servidor **`FastMCP`** local; a esteira de extração do grafo (*extrator → auditor → merger*) roda em background em **`LangGraph`** (`StateGraph` + `AsyncSqliteSaver`); a prática é uma sessão (`problem`/`conclude`), não um lote de exercícios.

---

## Rodando Localmente

Pré-requisitos: Python 3.12+ com [`uv`](https://docs.astral.sh/uv/), Node.js 20+, `git` e pelo menos um conector Google (`agy`, `gemini` ou uma `GEMINI_API_KEY`).

```bash
cd backend && uv sync && cd ..
cd frontend && npm install && cd ..
make dev            # ou: scripts/dev.sh
```

Abra `http://localhost:3000`. O `scripts/dev.sh` sobe o backend FastAPI em `127.0.0.1:8000` e o frontend Next.js em `3000`, já com o proxy `/api/*` e a URL do MCP interno ajustados. Variáveis úteis:

| Variável | Para quê |
|---|---|
| `BACKEND_PORT` / `FRONTEND_PORT` | Portas do backend (padrão `8000`) e do frontend (padrão `3000`). |
| `LEARNHARNESS_VAULT_PATH` | Vault a usar (ex.: `~/Documents/AI Engineering`). Sem ela, vale o Vault escolhido no Setup. |
| `GEMINI_API_KEY` | Habilita o conector `google-genai` (fallback por API). |
| `GITHUB_TOKEN` | Opcional: importar repositórios privados do GitHub (sem ela, usa `gh auth token` se o GitHub CLI estiver logado). Nunca vai para `argv` nem para o Vault. |
| `LEARNHARNESS_ALLOWED_HOSTS` | Hosts aceitos pela API local (padrão: só loopback, `localhost,127.0.0.1,::1`, mais o `testserver` dos testes); outros recebem `421`. |
| `LEARNHARNESS_MCP_URL` | Só se o MCP interno precisar ser anunciado numa URL diferente de `http://127.0.0.1:$BACKEND_PORT/internal/mcp/`. |

O script já exporta `LEARNHARNESS_PORT` (URL do MCP interno), `LEARNHARNESS_CORS_ORIGINS` (só o frontend pode escrever na API) e `BACKEND_URL` (proxy `/api/*` do Next).

Se as portas já estiverem ocupadas (outro projeto, Docker), o script avisa e não sobe nada. Escolha outras:

```bash
BACKEND_PORT=8100 FRONTEND_PORT=3100 LEARNHARNESS_VAULT_PATH=/tmp/vault-teste scripts/dev.sh
```

**Sobre o conector:** a partir do gemini-cli 0.62, contas pessoais do *Gemini Code Assist* são bloqueadas no `gemini` com a orientação de migrar para o Antigravity. Para usar a assinatura Google pessoal, prefira o **`agy`**; o `gemini --acp` continua suportado para Workspace/Code Assist Standard.

**Permissão do `agy`:** em modo headless, o `agy` recusa sem aviso as ferramentas MCP que pediriam confirmação. Na primeira vez, conceda em *Setup* ou em *Configurações → Conectores* a regra `mcp(harness/*)`. Ela é gravada, com backup, em `~/.gemini/antigravity-cli/settings.json` e libera só o servidor pedagógico local `harness`. Sem ela, as sessões com `agy` param com uma instrução de como conceder.

---

## Importando Conteúdo

O botão `↑ Import` da Home leva tudo para `Fontes/` (somente-leitura, com parágrafos `^pN` e proveniência no frontmatter):

- **Servidor MCP:** cadastre qualquer servidor em `Settings` (HTTP/streamable, SSE ou `stdio`), teste a conexão e importe os itens listados. Tokens ficam em `~/.config/learnharness/secrets.json`, nunca no Vault.
- **Link do GitHub:** cole a URL de um repositório, pasta ou arquivo, por exemplo `https://github.com/rohitg00/ai-engineering-from-scratch`. O preview lista `.md`/`.txt`/`.ipynb`, e você escolhe o que importar. Marque **usar como Trilha** para gerar a trilha a partir do currículo inteiro. O clone fica em cache em `.harness/repos/`: um novo preview só baixa de novo se o repositório mudou (ou com `refresh`).
- **Arquivos locais:** `.md`, `.txt` ou `.pdf` (até 20 MB), com opção de já abrir uma sessão `TEACH` sobre a fonte.

---

## Testes

```bash
make check          # tudo abaixo de uma vez

cd backend
uv run pytest -q
uv run ruff check src tests

cd frontend
npm run typecheck
npm test
npm run build
```

---

## Documentação do Repositório

- **[`AGENTS.md`](AGENTS.md)** — Guia rápido de contexto, invariantes e regras para agentes e desenvolvedores.
- **[`docs/CONTEXT_AND_BEHAVIOR.md`](docs/CONTEXT_AND_BEHAVIOR.md)** — **Especificação Comportamental Completa**: como cada tela (`Setup`, `Home`, `TEACH`, `QuestionDock`, `Import MCP`, `Excalidraw`, `PRACTICE`) e cada arquivo do Vault deve se comportar passo a passo.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — **Arquitetura Técnica atual**: camadas hexagonais, modelo de processo (FastAPI + MCP interno + SSE), motores `agy`/`gemini --acp`/`google-genai`, núcleo pedagógico, PRACTICE, rastro de conhecimento, jobs com steer, trilhas, layout do Vault, frontend, rotas e histórico de fases.
- **[`docs/specs/`](docs/specs/)** — Contrato de cada fase (Fase 8 em diante).
# lapidare
