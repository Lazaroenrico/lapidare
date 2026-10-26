# LearnHarness (Google Ecosystem & Vault-First Edition)

Uma plataforma local-first de estudo ativo, retenção e construção de conhecimento projetada para o **ecossistema Google**, combinando a experiência visual e editorial do `learnharness` com **persistência bidirecional em um Vault Markdown/Obsidian (`UI ⇄ Vault`)** e execução direta via **assinatura Google** (`@google/gemini-cli` e Google Antigravity `agy`).

![Visão Geral da Interface](docs/assets/mockup-lh-2-adaptado.png)

---

## Por Que Este Projeto Existe

Este projeto nasce da convergência de duas linhagens que partiram do mesmo método de estudo ativo (`amosblomqvist/learn`):

1. **A profundidade pedagógica do sistema `ai-engineer`:**
   - Estudo estruturado por **Trilha integrada (`2:1`)**, ingestão de aulas densas/mentorias via **MCP** (com fatiamento em blocos, mapeamento do que foi *Dito / Pressuposto / Pulado / Simplificado* e ancoragem por parágrafo `#^pN`), prática de código e consolidação por **desenho de memória à mão livre no Excalidraw** com revisão multimodal.
2. **A excelência de UX/UI e engenharia de estado do `amosblomqvist/learnharness`:**
   - Lousa editorial sem balões de chat (`CMU Serif Bold` + `Source Sans 3` + `KaTeX` + `JetBrains Mono` sobre grafite `#141414`), Grafo de Conhecimento central em Canvas 2D com cadeias de implicação lógica ($A \land B \implies C$), `QuestionDock` inline com calibração de confiança (`0–100%`) e campo *Your Thinking*, ditado por voz e pipelines em background de extração e prática (`Practice`).

---

## As 6 Leis Inegociáveis da Plataforma

1. **Zero Proliferação de Modos (`TEACH` e `PRACTICE` apenas):**
   - Não existe modo separado para "Aula Densa / Mentoria" ou "Currículo". Existem apenas **`TEACH`** (aprender) e **`PRACTICE`** (treinar a frio).
   - O próprio **`TEACH`** detecta os insumos da sessão (tema livre, fonte densa importada via MCP/arquivo, ou etapa da trilha ativa) e adapta seu fluxo automaticamente.
2. **A Trilha é Configurada no Setup e Conduzida pelo Harness:**
   - No Setup Inicial (ou em `Settings`), o usuário configura sua Trilha (via repositório/currículo + nivelamento adaptativo, objetivo descrito para geração automática, ou modo livre). A partir daí, o próprio Harness conduz o aluno exibindo o próximo passo num *chip* discreto acima do composer (`⇶ Trilha ativa · Próximo: ... [Continuar ↵]`).
3. **Um Único Grafo Central (Sem Divisão `Macro | Micro`):**
   - A Home apresenta **uma única visualização de grafo** em Canvas 2D acompanhada do botão `☍ Chains`. Nos bastidores, o sistema mantém cada conceito sincronizado com `Conceitos/<Tema>.md` no Vault e as proposições/cadeias indexadas em `.harness/chains.jsonl`.
4. **Persistência Dupla Não-Destrutiva (`UI ⇄ Vault`):**
   - Tudo acontece na UI Web **e** vive simultaneamente em Markdown/Excalidraw reais no Vault do usuário. Se o usuário não tiver um Vault no primeiro acesso, a plataforma cria e estrutura tudo automaticamente; se já tiver, adota sem sobrescrever nada.
5. **Execução Oficial na Assinatura Google (Zero Custo Extra de API):**
   - Suporte nativo desde a v0.1 aos **3 conectores sancionados do ecossistema Google**:
     1. `@google/gemini-cli` (`gemini --acp` / `stream-json` — funciona com *Login with Google*: Free, Google One AI Pro, AI Ultra e Workspace Code Assist).
     2. Google Antigravity CLI (`agy --input-format stream-json --output-format stream-json` + `--json-schema` + `--effort`).
     3. Fallback opcional via SDK oficial `google-genai` (`GEMINI_API_KEY` / Vertex AI).
6. **Arquitetura Hexagonal + Orquestração Híbrida (`FastMCP` + `LangGraph`):**
   - `backend/core/` puro em Python (`Pydantic`, zero I/O); sessões interativas ao vivo (`Prober → Teacher` e `Practice` com dicas `R0–R5`) rodam no loop nativo do `agy`/`gemini` falando com um servidor **`FastMCP`** local; esteiras multi-etapa em background (*Graph Extraction* e geração paralela de *Problem Sets*) rodam em **`LangGraph`** (`StateGraph` + `Send` + `AsyncSqliteSaver`).

---

## Documentação do Repositório

- **[`AGENTS.md`](AGENTS.md)** — Guia rápido de contexto, invariantes e regras para agentes e desenvolvedores.
- **[`docs/CONTEXT_AND_BEHAVIOR.md`](docs/CONTEXT_AND_BEHAVIOR.md)** — **Especificação Comportamental Completa**: como cada tela (`Setup`, `Home`, `TEACH`, `QuestionDock`, `Import MCP`, `Excalidraw`, `PRACTICE`) e cada arquivo do Vault deve se comportar passo a passo.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — **Arquitetura Técnica e Plano de Ondas**: estrutura de diretórios (`backend/` Python FastAPI + `frontend/` Next.js), protocolos `stream-json` / `ACP` / `FastMCP` / `SSE`, sincronização com o Vault e escopo detalhado da **Onda 1** e **Onda 2**.
