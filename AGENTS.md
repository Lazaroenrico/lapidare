# AGENTS.md — Diretrizes e Contexto do Repositório `learnharness`

Leia **[`docs/CONTEXT_AND_BEHAVIOR.md`](docs/CONTEXT_AND_BEHAVIOR.md)** e **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** antes de alterar contratos, prompts, componentes de UI ou rotas do servidor.

## 1. Visão em Uma Frase
Este projeto é um *Learning Harness* local-first, bilíngue (`PT-BR` / `EN`), com **frontend em Next.js** (seguindo o Design System `#1a1430` + `CMU Serif` + `Source Sans 3` + `JetBrains Mono`) e **backend em Python (`FastAPI` + `FastMCP` + `LangGraph`)**, que roda sobre a **assinatura Google** do usuário (`gemini` CLI / `agy` CLI / `google-genai`) e mantém **persistência bidirecional (`UI ⇄ Vault Markdown/Obsidian`)**.

## 2. Invariantes de Produto e Comportamento (NUNCA VIOLE)

1. **Apenas Dois Modos de Sessão (`TEACH` e `PRACTICE`):**
   - **Nunca** crie abas ou modos separados para "Mentoria", "Aula Densa" ou "Currículo" no composer ou na sidebar.
   - O modo **`TEACH`** é único: quando recebe um tópico livre, ensina por `Prober → Plan → Predict/Teach/Check`; quando recebe uma fonte densa (importada via MCP ou arquivo em `Fontes/`), fatia em blocos, mapeia *Dito / Pressuposto / Pulado / Simplificações*, faz triagem por quiz e ancora explicações em `[[Fonte#^pN]]`; quando acionado pela Trilha ativa, conduz a etapa correspondente do roteiro `2:1`.
2. **A Trilha Vive no Setup e é Conduzida pelo Harness:**
   - A trilha é configurada no **Setup Inicial** (`Settings`) — por repositório/currículo + nivelamento, por objetivo ou livre.
   - Na Home, a trilha ativa aparece apenas como um *chip* contextual discreto acima do composer (`⇶ Trilha ativa · Próximo: ... [Continuar ↵]`).
3. **Um Único Grafo Central (Sem Toggle `Macro | Micro`):**
   - A Home exibe **uma única visualização de grafo** em Canvas 2D + botão `☍ Chains`.
   - O botão **`↑ Import`** verifica se há um servidor MCP de conteúdo configurado (ex.: Praxis): se houver, lista e importa aulas direto do MCP para `Fontes/`; se não houver, importa notas/arquivos locais.
4. **Integridade Absoluta do Vault do Usuário:**
   - Se o usuário não tiver Vault no onboarding, crie a estrutura completa automaticamente. Se já tiver (ex.: `/home/lazarodiza/Documents/AI Engineering`), adote-a sem apagar ou sobrescrever nenhum arquivo existente.
   - Arquivos em `Fontes/` são **estritamente somente-leitura**.
   - Em `Aulas/*.md` e `Conceitos/*.md`, atualize apenas as seções gerenciadas pelo agente, preservando qualquer anotação livre escrita pelo usuário no Obsidian.
   - Os dados brutos de máquina moram em `.harness/` dentro do próprio Vault (`config.json`, `sessions/*.jsonl`, `chains.jsonl`, `quiz-log.jsonl`, `langgraph.sqlite`), no formato *append-only*.
5. **Design System ("The Skin"):**
   - Paleta roxa escura (remete ao Google/Gemini; decisão do usuário em 2026-10-27, substitui o grafite): `--background: #1a1430`, `--card: #231b3e`, `--accent: #30255a`, `--border: #54458a`, `--foreground: #efeaff`, `--muted-foreground: #a99cd0`. Zero azul corporativo/slate.
   - Fontes: títulos em `CMU Serif Bold`, prosa de ensino em `Source Sans 3` (`16px`, `1.5`) + KaTeX, e cromia de UI em `JetBrains Mono` (`11px` / `12.5px`).
   - Escala modular em múltiplos de `4px`; zero `outline` nativo do navegador (`*:focus { outline: none }`).
6. **Fronteiras Arquiteturais Limpas:**
   - `backend/core/` contém apenas tipos `Pydantic` e funções puras (zero chamadas de rede, subprocessos, sistema de arquivos ou `langgraph`).
   - A UI mantém **um único canal SSE (`EventSource("/api/events")`)** por janela seguindo o padrão *notify $\rightarrow$ fetch* (nunca crie loops de polling `setInterval`).
   - Apenas caminhos oficiais e sancionados do Google (`gemini --acp` / `stream-json`, `agy --input-format stream-json --output-format stream-json`, `google-genai` SDK).
