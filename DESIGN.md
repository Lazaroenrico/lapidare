# DESIGN.md — Lapidare Design System

O visual do Lapidare se resume a **9 cores, 3 fontes e uma grade de 4px**. Tudo o que não é conteúdo recua para o fundo. Este arquivo descreve a linguagem visual, não as funcionalidades, e serve de base para reaproveitá-la em outros apps.

Fonte da verdade no código:

| Arquivo | Papel |
|---|---|
| `frontend/app/globals.css` | Tokens (`:root`), `@font-face`, ponte para o Tailwind v4 (`@theme`), estilos globais |
| `frontend/lib/palette.ts` | Espelho literal das cores para Canvas 2D, Excalidraw e metadata (`withAlpha`, `toneAlpha`) |
| `frontend/tests/tokens.test.cjs` | Guarda: proíbe hex e cores fora da paleta no resto do código |
| `frontend/components/import-ui.tsx` | Componentes base (`Btn`, `Field`, `inputClass`, `Check`, `Banner`, `Badge`, `BusyStrip`) |
| `frontend/public/fonts/` | Fontes embarcadas + licenças OFL |

---

## 1. Princípios

1. **Três planos, nada mais.** Fundo → card → destaque. A profundidade vem da troca de tom, não de gradiente nem de textura.
2. **Cor é hierarquia, não decoração.** O roxo escuro é neutro para o olho; o texto claro carrega a atenção. Verde, âmbar e vermelho existem só para estado.
3. **A interface fala em monoespaçada.** Botões, rótulos, chips e metadados usam JetBrains Mono pequena. Isso separa *cromia* de *conteúdo* sem precisar de caixas.
4. **O conteúdo fala em serifa e sans.** Títulos em CMU Serif (a fonte do LaTeX) dão peso acadêmico; a prosa em Source Sans 3 aguenta leitura longa.
5. **Contorno no lugar de preenchimento.** Borda de 1px define a forma; o preenchimento só muda em hover e seleção.
6. **Nenhuma cor fora dos tokens.** Componentes nunca escrevem hex; um teste barra isso.
7. **Só tema escuro.** `colorScheme: "dark"`, `<html class="dark">`.

---

## 2. Cor

| Token | Valor | Papel | Classe Tailwind |
|---|---|---|---|
| `--background` | `#1a1430` | Fundo da página, inputs | `bg-background` |
| `--card` | `#231b3e` | Cards, docks, modais, menus | `bg-card` |
| `--accent` | `#30255a` | Hover, item selecionado, botão secundário | `bg-accent` |
| `--border` | `#54458a` | Toda borda (1px), seleção de texto | `border-border` |
| `--foreground` | `#efeaff` | Texto principal, botão primário (invertido) | `text-foreground` |
| `--muted-foreground` | `#a99cd0` | Rótulos, metadados, placeholders, borda em hover | `text-muted-foreground` |
| `--success` | `#34d399` | Ok, novo | `text-success` |
| `--warning` | `#e0a030` | Atenção | `text-warning` |
| `--danger` | `#f87171` | Erro, ação destrutiva | `text-danger` |

**Regras**

- Os seis primeiros são a paleta inteira da interface. Os três de estado nunca são usados como decoração.
- Variações saem de **opacidade sobre um token**, nunca de um hex novo: `text-muted-foreground/80`, `bg-background/75`, `border-danger/40`.
- Padrão de estado (banner, badge): `border-<estado>/40 bg-<estado>/10 text-<estado>`.
- O botão primário é a **inversão** da paleta: `bg-foreground text-background`. É o único bloco claro da tela.
- Proibido: `blue-*`, `sky-*`, `indigo-*`, `slate-*`, `text-white`, `bg-white`, qualquer `#hex` fora dos dois arquivos de token.
- Onde variável CSS não funciona (Canvas, Excalidraw, `themeColor`), use `palette.ts`: `withAlpha("border", 0.5)` ou `toneAlpha(["accent", "success", 0.3], 0.8)` para misturar dois tokens.

---

## 3. Tipografia

Três famílias, cada uma com um papel fixo. Nunca troque os papéis.

| Papel | Família | Classe | Tamanho | Uso |
|---|---|---|---|---|
| Título | CMU Serif Bold (fallback Georgia) | `font-title` | contextual | Títulos de página, seção, card |
| Prosa | Source Sans 3 (fallback system-ui) | `font-prose` | `16px` / `1.5` (`--prose-size`, 14–20px) | Texto de leitura, explicações, + KaTeX |
| Interface | JetBrains Mono | `font-ui` | `11px` e `12.5px` | Botões, rótulos, chips, inputs, menus, metadados |

- `font-ui` sempre leva `letter-spacing: 0.06em`; badges usam `tracking-wider`.
- Escala da interface na prática: **`10px`** (badge), **`11px`** (rótulo, dica, banner), **`12.5px`** (botão, input, item de menu). Prefira esses três.
- KaTeX herda `--foreground` e roda a `1.05em`.
- Corpo com `-webkit-font-smoothing: antialiased`.
- **Pesos embarcados** (`public/fonts/`, OFL): JetBrains Mono 400/700 (v2.304), Source Sans 3 400/600/700 (3.052R), CMU Serif 400/700. `font-semibold` (600) e `font-bold` (700) usam arquivos reais, sem negrito sintético; JetBrains Mono em 600 cai no 700.

---

## 4. Espaço e forma

**Grade de 4px.** Espaçamentos em múltiplos de 4 (Tailwind `1` = 4px). Os mais usados:

| Uso | Classe |
|---|---|
| Entre ícone e texto, itens de uma linha | `gap-1.5`, `gap-2` |
| Entre blocos de um formulário | `space-y-2`, `space-y-3` |
| Padding de botão / input | `px-3 py-1` |
| Padding de banner | `px-3 py-2` |
| Padding de card | `p-3`, `p-4` |
| Padding de modal | `p-5` |

Meios-passos (`0.5`, `1.5` = 2px, 6px) só para alinhamento fino de ícones e chips.

**Raios**

| Raio | Onde |
|---|---|
| `rounded` (4px) | Badge, barras de progresso |
| `rounded-md` (6px) | Botão, input, banner |
| `rounded-lg` (8px) | Cards, painéis flutuantes |
| `rounded-xl` (12px) | Modais |
| `rounded-full` | Pílulas, chips, pontos de status |

**Borda:** sempre `1px` em `border-border`. Mais grossa nunca; a ênfase vem da cor (`hover:border-muted-foreground`, `focus:border-foreground`).

**Elevação:** sombra (`shadow-2xl`) e véu (`bg-background/75 backdrop-blur-xs`) **só** em camadas que flutuam sobre o conteúdo: modais, menus, janelas flutuantes. Elementos no fluxo da página não têm sombra.

**Scrollbar:** 6px, trilho `--background`, polegar `--accent` (hover `--border`), raio 3px.

---

## 5. Componentes base

Todos montados só com tokens. Copie as classes, não reinvente.

**Botão** — base `inline-flex items-center gap-2 px-3 py-1 rounded-md border font-ui text-[12.5px] leading-5 transition-colors disabled:opacity-40`

| Variante | Classes |
|---|---|
| `primary` | `bg-foreground text-background border-foreground font-semibold hover:bg-foreground/90` |
| `secondary` | `bg-accent text-foreground border-border hover:border-muted-foreground` |
| `ghost` | `bg-transparent text-muted-foreground border-transparent hover:text-foreground hover:bg-accent` |
| `danger` | `bg-transparent text-danger border-border hover:border-danger` |

Use um único `primary` por tela ou diálogo. Estado ocupado: ícone `Loader2` girando à esquerda e botão desabilitado.

**Input**
```
w-full bg-background border border-border focus:border-muted-foreground
rounded-md px-3 py-1 font-ui text-[12.5px] leading-6 text-foreground placeholder-muted-foreground
```
O input fica **mais escuro** que o card onde está: ele afunda, não sobe.

**Campo:** rótulo `font-ui text-[11px] text-muted-foreground` acima, dica `text-[11px] text-muted-foreground/80` abaixo, `space-y-1`.

**Checkbox:** nativo com `accent-foreground`, rótulo em `font-ui text-[12.5px]`.

**Banner:** `flex gap-2 rounded-md border px-3 py-2 font-ui text-[11px] leading-5` + tom de estado (`error`, `warn`, `ok`, `info`). `info` = `border-border bg-background text-muted-foreground`. Ícone 16px à esquerda.

**Badge:** `px-1 rounded border font-ui text-[10px] leading-4 tracking-wider`; tom neutro `border-border bg-accent text-muted-foreground`.

**Card:** `bg-card border border-border rounded-lg p-4`. Modal: `bg-card border border-border rounded-xl shadow-2xl p-5` sobre véu `bg-background/75 backdrop-blur-xs`.

**Pílula / chip flutuante:** `rounded-full bg-card border border-border px-3.5 py-2 hover:bg-accent hover:border-muted-foreground`.

**Progresso:** trilho `h-1 rounded bg-accent`, preenchimento `bg-muted-foreground`.

**Ícones:** `lucide-react`, `w-3 h-3` em botões, `w-4 h-4` em banners, sempre `aria-hidden` quando decorativos.

---

## 6. Interação e estados

| Estado | Como aparece |
|---|---|
| Hover | Fundo sobe para `--accent` **ou** borda clareia para `--muted-foreground`. Texto `ghost` sobe de muted para foreground |
| Foco | Sem anel nativo. Borda ou fundo mudam como no hover (`focus-visible:border-foreground`, `focus-visible:bg-accent`) |
| Selecionado | `bg-accent` |
| Desabilitado | `opacity-40 cursor-not-allowed` |
| Carregando | `Loader2 animate-spin` ou `animate-pulse` na barra; nunca spinner em tela cheia |
| Seleção de texto | Fundo `--border`, texto `--foreground` |
| Destaque de busca | `--border` (ocorrência), `--muted-foreground` com texto `--background` (ocorrência ativa) |

**Movimento:** quase nenhum. `transition-colors` em tudo que é clicável; `transition-transform` só para setas/chevrons. Única animação de destaque: o *flash* de mensagem (fundo `--accent` que some em 1.8s, `ease-out`).

---

## 7. Como portar para outro app

Requer Tailwind v4.

1. Copie `public/fonts/` (com as licenças `*-OFL.txt`).
2. Copie de `globals.css` os blocos `@font-face`, `@theme inline`, `@theme`, `:root` e os estilos globais (body, foco, scrollbar, seleção, KaTeX se usar matemática).
3. Copie `lib/palette.ts` se o app desenhar em Canvas ou precisar de cor em JS.
4. Copie `tests/tokens.test.cjs` ajustando `SCAN_DIRS` e `ALLOWLIST`. Sem ele, o sistema se desfaz em poucas semanas.
5. Copie os componentes base de `components/import-ui.tsx` para uma pasta `ui/` própria.
6. Na raiz: `<html class="dark">`, `body` com `bg-background text-foreground antialiased`, `themeColor: palette.background`.

Para trocar a cor do app inteiro, altere só os valores de `:root`, `palette.ts` e o teste. Mantenha a lógica dos papéis: fundo mais escuro, card um passo acima, destaque mais um, borda bem visível, texto quase branco com um toque da matiz.

---

## 8. Pontos a acertar antes de reaproveitar

- **Escala de tamanhos espalhada.** O código usa 9 a 16px em passos de 0,5px (`text-[11px]` aparece 215 vezes). Vale nomear a escala em `@theme` (`--text-ui-xs: 10px`, `--text-ui-sm: 11px`, `--text-ui: 12.5px`) e migrar.
- **Foco invisível para teclado.** `outline: none !important` + `box-shadow: none !important` anula qualquer anel. Mantenha sem outline nativo, mas garanta `focus-visible:border-foreground` (ou equivalente) em todo elemento focável.
- **Componentes base escondidos.** Moram em `import-ui.tsx`; num kit, viram `ui/` com um arquivo por componente.
- **Sem tema claro.** Os tokens permitem: basta redefinir `:root` sob `[data-theme="light"]`.
