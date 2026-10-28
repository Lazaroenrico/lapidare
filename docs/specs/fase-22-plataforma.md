# Fase 22: Plataforma (ditado, updates, fontes e testes)

Os invariantes do `AGENTS.md` valem, com uma exceção nova (§1.0). Windows está fora do escopo.

## 1. Ditado por voz (Deepgram)

### 1.0 Exceção no invariante

Acrescente ao invariante 6 do `AGENTS.md` (o lead faz isso): o ditado usa o STT do Deepgram com chave própria do usuário, por decisão do usuário em 2026-10-27. O Deepgram não é LLM. Todo caminho de modelo continua só Google.

O áudio vai direto do renderer ao Deepgram e não passa pelo backend. O backend só emite um token de curta duração.

### 1.1 Backend

**`services/dictation.py`**
- **Chave:** guardada em `services/secrets.py` com o nome `deepgram_api_key`, fora do vault e com permissão 0600. Nunca é devolvida pela API e nunca aparece em log; use `state.redact` ou equivalente.
- **`mint_token(key)`:** `POST https://api.deepgram.com/v1/auth/grant` com `Authorization: Token <key>` e corpo `{"ttl_seconds": 60}`, timeout de 10 s. Devolve `{access_token, expires_in}`.
- **Erros mapeados:**

  | Situação | Exceção |
  |---|---|
  | Deepgram responde 401 | `DictationKeyInvalid` |
  | Deepgram responde 403 | `DictationRoleInsufficient` (a chave precisa de papel Member ou superior) |
  | Rede ou outro status | `DictationUnavailable` |

**`httpx`** passa a ser dependência de runtime: `uv add httpx` em `backend/`.

**Config.** `DictationSettings{language: str = "multi"}` vai em `HarnessConfig.dictation`, opcional e com default. Valide contra uma lista curta: `multi`, `pt-BR`, `pt`, `en`, `en-US`, `es`, `fr`, `de`, `it`, `ja`. Siga a regra da Fase 21 sobre `schema_version`.

**Rotas** em `api/routes/dictation.py`, todas sob o `LocalRequestGuard` como as demais:

| Rota | Comportamento |
|---|---|
| `GET /api/settings/dictation` | `{configured: bool, language: str}` |
| `PUT /api/settings/dictation` | Corpo parcial `{api_key?: str \| null, language?: str}`. `api_key: null` apaga a chave; uma string vazia é 422. Devolve o mesmo formato do GET e faz broadcast de `config:updated` |
| `POST /api/dictation/token` | `{access_token, expires_in}` |
| `POST /api/dictation/test` | Emite um token e devolve `{ok: true}` |

Erros de `token` e `test`:

| Situação | Resposta |
|---|---|
| Sem chave | 409 `{"detail": "ditado não configurado"}` |
| `KeyInvalid` | 401 |
| `RoleInsufficient` | 403 |
| `Unavailable` | 502 |

O `detail` vem em PT. O frontend tem as próprias mensagens.

**`/api/health`** passa a devolver `{"status": "ok", "version": <LEARNHARNESS_APP_VERSION ou null>}`.

**Testes**, sem rede, com `httpx.MockTransport` ou injeção do cliente:
- token feliz;
- 401, 403 e 5xx;
- 409 sem chave;
- PUT com `null` apaga a chave;
- a chave nunca aparece nas respostas;
- validação de idioma;
- `/api/health` com e sem versão.

### 1.2 Frontend

**`lib/dictation-core.ts`** (puro e testado)
- **`listenUrl(language)`:** `wss://api.deepgram.com/v1/listen?model=nova-3&language=…&encoding=linear16&sample_rate=16000&channels=1&smart_format=true&endpointing=300&interim_results=false`.
- **`reduceTranscript(acc, message)`:** acumula `channel.alternatives[0].transcript` das mensagens `Results` com `is_final`, juntando com espaço e ignorando vazios.
- **Máquina de estados** `idle → requesting → listening → finishing → idle`, com `error` saindo de qualquer estado.
- **`errorMessage(status, locale)`:** 401 = chave inválida, 403 = papel insuficiente da chave, 409 = não configurado, demais = indisponível.

**`public/dictation-worklet.js`.** AudioWorkletProcessor que recebe Float32 na taxa do AudioContext e reduz para 16 kHz (média por bloco), convertendo para Int16 LE. Posta `ArrayBuffer`s de cerca de 100 ms e o RMS do bloco, que serve ao medidor.

**`components/use-dictation.ts`.** Reescreva o interior e **mantenha a API pública**: os sinks, `TOGGLE_DICTATION_EVENT` e `appendDictation`. O fluxo é:
1. `POST /api/dictation/token`;
2. `getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}})`;
3. `AudioContext` + `audioWorklet.addModule("/dictation-worklet.js")`;
4. `new WebSocket(listenUrl, ["bearer", token])`;
5. enviar os buffers do worklet.

Ao parar:
- envia `{"type": "CloseStream"}`;
- espera o fechamento do socket, com teto de 3 s;
- **só então insere o texto acumulado** no sink ativo;
- libera microfone, AudioContext e socket.

Esc durante a escuta cancela e descarta o texto. Use o mecanismo de Esc que existe, sem listener próprio fora do registro. Em erro, mostra a mensagem e volta a `idle`.

**Reativar o que `9e4d67b` desativou.** Descomente os 4 botões de microfone: composer, QuestionDock, PracticeDock e a barra de follow-up do chat. Descomente também o atalho `dictate` (⌘D) no registro, nos rótulos e no `global-shortcuts.tsx`.
- O botão só aparece quando `GET /api/settings/dictation` responde `configured: true`. Busque no carregamento e em `config:updated`.
- Escutando, o botão mostra um medidor de nível (barra ou anel a partir do RMS, com tokens) e um título acessível "Parar ditado".
- As strings ficam em `lib/dictation-i18n.ts`, em PT/EN. Não mexa nas chaves já existentes em `locale-provider.tsx` além do necessário.

**Settings → Conectores.** Nova seção "Ditado (Deepgram)":
- campo de chave do tipo password, que nunca mostra a chave salva (só "configurada ✓"), com botões "Salvar" e "Remover";
- seletor de idioma;
- botão "Testar", que mostra sucesso ou o erro mapeado;
- texto curto: "O áudio vai direto do app para o Deepgram. A chave precisa de papel Member ou superior."

## 2. Updates com banner (desktop)

### 2.1 Desktop (`desktop/`)

**`preload.cjs` (novo).** Usa `contextBridge.exposeInMainWorld("lapidare", …)` e expõe só:
- `appVersion`;
- `updates.getState()`, que devolve uma `Promise<UpdateState>`;
- `updates.onState(cb)`, que devolve a função de unsubscribe;
- `updates.check()`, `updates.restart()`, `updates.openRelease()` e `updates.setAuto(bool)`.

Não expõe `ipcRenderer` cru nem segredos. O `LEARNHARNESS_DESKTOP_SECRET` nunca passa por aqui. Registre o preload em `WEB_PREFS`, mantendo `sandbox: true`, `contextIsolation: true` e `nodeIntegration: false`.

**`UpdateState`:**
```
{ status: "idle"|"checking"|"available"|"downloading"|"staged"|"error"|"unsupported",
  mode: "auto"|"notify", autoUpdate: boolean, version?: string, error?: string }
```

**`setupUpdater` (`main.cjs`)**
- AppImage: `mode: "auto"`. Baixa sozinho e instala ao sair, como hoje.
- deb, rpm e mac: `mode: "notify"`, com `autoDownload = false`. Quando há versão nova, o estado vira `available`.
- `openRelease()` abre via `shell.openExternal`, mas só `https://github.com/Lazaroenrico/lapidare/releases` ou a tag correspondente. A checagem é feita por uma função pura em `policy.cjs`.
- Checagem no boot e depois a cada 6 h, com `setTimeout` encadeado. Pula se `autoUpdate` estiver desligado; `check()` manual sempre funciona.
- O `dialog.showMessageBox` sai; o estado vai por IPC para todas as janelas.
- `autoUpdate` fica em `app.getPath("userData")/updates.json`, com default `true`.
- `restart()` só funciona com `staged` e reaproveita o caminho atual (`killBackend` + `quitAndInstall`).
- Fora do pacote (dev), o estado é `unsupported`.

**Permissões (`policy.cjs`, função pura `allowPermission(permission, details, appOrigin)`)**
- `media` é permitido só se `details.mediaTypes` (quando vier) está contido em `["audio"]` e a origem de `details.requestingUrl` (ou `securityOrigin`) é a do app.
- Todo o resto é negado.
- Use a função em `setPermissionRequestHandler` e em `setPermissionCheckHandler`.
- No macOS, antes de permitir, chame `systemPreferences.askForMediaAccess("microphone")` no main.

**`electron-builder.yml`.** `mac.extendInfo.NSMicrophoneUsageDescription`: "O Lapidare usa o microfone apenas para o ditado por voz."

**Testes** em `desktop/tests/policy.test.cjs`: `allowPermission` (áudio da origem do app, vídeo, outra origem, outras permissões) e a allowlist de URL de release.

### 2.2 Frontend

**`lib/updates.ts`** (puro). Tipos de `UpdateState`, mais `bannerFor(state, locale)`:

| Estado | Resultado |
|---|---|
| `staged` | "Atualização pronta — Reiniciar" |
| `available` em `notify` | "Versão X disponível — Baixar" |
| demais | `null` |

Fora do desktop (`window.lapidare` ausente), também `null`.

**`components/update-banner.tsx`.** Faixa discreta no topo do layout, que não pode ser dispensada (o update aplica ao sair). Botão principal `restart()` ou `openRelease()`, e um link "Configurações".

**Settings → Geral**, só quando houver desktop:
- versão (`appVersion`);
- switch "Atualizar automaticamente", que chama `setAuto`;
- botão "Verificar agora", que chama `check()` e mostra o estado.

Fora do desktop, mostre a versão de `/api/health` quando houver.

## 3. Pesos de fonte

Hoje só existem as fontes Regular (`frontend/public/fonts`), e o negrito sai sintético (`DESIGN.md`, "lacuna conhecida").

**Fontes a adicionar** (OFL), baixadas das fontes oficiais:
- **Source Sans 3 SemiBold e Bold:** repositório `adobe-fonts/source-sans` (release TTF);
- **JetBrains Mono Bold:** release do `JetBrains/JetBrainsMono`.

Confira a licença OFL e inclua o arquivo de licença ao lado, como já é feito.

**`@font-face` em `globals.css`.** Mesma família, com `font-weight` 600 e 700 e `font-display` igual ao atual. O CMU Bold (`cmunbx`) já existe; confira se o `@font-face` dele declara o peso 700.

Atualize a seção do `DESIGN.md` e remova a lacuna.

## 4. Testes de componente

**Configuração**
- Dev-dependency `tsx` no frontend.
- Script `test:components`: `node --import tsx --test tests/components/*.test.tsx`.
- Os aliases `@/` precisam resolver; o tsx lê os `paths` do tsconfig. Se não ler, configure.
- Render com `react-dom/server`, `renderToStaticMarkup`, sem DOM.
- Componentes `"use client"` que usam hooks de efeito renderizam o estado inicial.
- Providers necessários: `LocaleProvider` e outros. Crie um helper `tests/components/render.tsx`.

**Componentes a cobrir:**
- `ExtractionRing`: fração e rótulo;
- `UpdateBanner`: staged, available e oculto;
- botão de microfone: oculto sem configuração e visível com configuração. Se o botão depender de fetch, extraia a parte de apresentação para poder testar.

**Makefile.** Inclua `npm run test:components` em `check-frontend`.

## 5. Vault de exemplo

`backend/scripts/make_sample_vault.py` gera `backend/tests/fixtures/sample-vault/` pelos **caminhos de produção**, com `FakeEngine` roteirizado:
- bootstrap do vault;
- uma sessão TEACH completa: probe → `probe_done` → `plan_init` → quiz → `plan_advance` até concluir;
- uma sessão PRACTICE com `problem` / `conclude`;
- uma extração para o grafo;
- um job de pesquisa concluído.

Datas e ids são determinísticos: relógio e uuid injetados ou fixados no script.

**Regra.** Ninguém edita esses arquivos à mão. Mudança de formato regenera tudo no mesmo commit. Documente isso num `README.md` dentro da pasta.

**`tests/integration/test_sample_vault.py`.** Abre o vault pelos leitores reais (o estado do app apontando para uma cópia em `tmp_path`) e confere que:
- `GET /api/chats` lista as duas sessões;
- o grafo tem nós e cadeias;
- cada tipo de mensagem e evento esperado aparece;
- o schema gate aceita o vault.

## 6. Pronto quando

- `make check` passa, incluindo os testes de componente, e `cd desktop && npm test` passa.
- `make desktop` gera o AppImage, e no AppImage:
  - o ditado funciona em PT-BR e em `multi`, com o texto entrando no fim;
  - Esc descarta;
  - uma chave sem papel suficiente mostra o erro de papel.
- `LAPIDARE_UPDATE_FEED` apontando para um feed local mostra o banner `staged`.
