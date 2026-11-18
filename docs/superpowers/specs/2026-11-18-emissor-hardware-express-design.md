# Emissor Hardware Express — Design

## Intent / Why

André tem duas empresas hospedadas na Contabilizei, que apresenta instabilidade recorrente
na emissão de notas. Para a Hardware Express ele quer parar de depender da Contabilizei e
usar um emissor próprio — clone do sistema já em produção da RJ Logística e Tecnologia
(`emissor.rjlogisticaetecnologia.com.br`, repo `github.com/andreprol/nfe-issuer`), com
identidade visual própria.

## Empresa alvo (dados do Cartão CNPJ)

- Razão social: HARDWARE AUTOMACAO E TECNOLOGIA LTDA
- Nome fantasia: HARDWARE EXPRESS ONLINE
- CNPJ: 61.864.221/0001-00 (matriz) — EPP, Sociedade Empresária Limitada, aberta 22/07/2025, ATIVA
- CNAE principal: 47.51-2-01 — comércio varejista especializado de equipamentos e suprimentos de informática
- CNAEs secundários: material elétrico (47.42-3-00), equip. telefonia/comunicação (47.52-1-00),
  dev sob encomenda (62.01-5-01), web design (62.01-5-02), dev/licenciamento software (62.02-3-00),
  consultoria TI (62.04-0-00), suporte técnico (62.09-1-00), hospedagem/tratamento de dados (63.11-9-00),
  portais/conteúdo (63.19-4-00), treinamento em informática (85.99-6-03)
- Endereço: R. Visconde de Pirajá, 414, Sala 718, Ipanema, Rio de Janeiro/RJ, CEP 22.410-002
- Domínio: hardwareexpressonline.com — DNS na HostGator (ns370/371.hostgator.com.br),
  **e-mail ativo** via Titan Email (MX + SPF configurados) — não pode ser migrado pro Cloudflare
- Certificado digital A1: `F:\Hardware Express\Certificado Digital\up-leg-certificate.pfx`
  (senha em `Senha.txt` na mesma pasta)

## Goals

- App de emissão de notas pra Hardware Express, mesma funcionalidade do emissor da RJ:
  **NF-e (produto) e NFS-e (serviço)**, cobrindo os CNAEs da empresa.
- Identidade visual própria: logo "HW" no lugar de "RJ", mesma estrutura/UX do original.
- Instância independente da RJ — zero risco cruzado pro sistema dela, já em produção.
- Exposto publicamente em `emissor.hardwareexpressonline.com`.

## Non-goals

- Reescrever o sistema pra multi-tenant (uma instância servindo várias empresas). Fica
  como clone separado por ora — se aparecer uma 3ª empresa, revisita essa decisão.
- Migrar o DNS do domínio pro Cloudflare.
- Portar scripts de carga específicos da RJ (`importar-produtos-rj.js`, `importar-clientes.js`)
  ou o módulo morto `nfse-carioca.cjs`.

## Anti-goals

- Quebrar o e-mail ou o site atual de hardwareexpressonline.com.
- Repetir o padrão de senha de admin em texto plano do original.
- Cadastro/pagamento em serviço externo (Focus NFe) sem André confirmar o pagamento.

## Constraints

- Sistema original é **single-tenant por desenho**: 1 pasta = 1 empresa = 1 conjunto de
  portas/serviços NSSM + 1 entrada no túnel Cloudflare único existente
  (`C:\Users\fileserver\.cloudflared\config.yml`).
- Dados fiscais (CNPJ, certificado, token Focus NFe) ficam em JSON local
  (`data/techstore-config.json`, `techstore-cert.json`), gitignored, carregados em runtime —
  não hardcoded no código.
- Focus NFe (serviço que fala com a SEFAZ) exige conta/plano próprio por CNPJ — custo
  recorrente novo.
- Senha de admin do app original (`config.json`) está em texto plano, sem hash visível
  também pros usuários (`techstore-usuarios.json`) — ponto de segurança a corrigir no clone.
- `verify.sh` do projeto roda os testes Jest existentes (`danfse.test.js`, `utils.test.js`) —
  protocolo de verificação do CLAUDE.md raiz se aplica ao clone.

## Approaches considered

1. **Clonar a pasta/projeto inteiro, independente** (escolhida) — baixo risco pro sistema
   da RJ já em produção, replica exatamente o pedido. Custo: manutenção duplicada se/quando
   aparecer uma 3ª empresa — aceitável agora.
2. Reescrever pra multi-tenant num código só — mexe no sistema em produção da RJ por um
   ganho que não foi pedido agora. Descartada.

## Decisões já tomadas (por André, 18/11/2026)

- Subdomínio: `emissor.hardwareexpressonline.com`, sem migrar DNS — CNAME direto na HostGator
  pro túnel Cloudflare.
- Escopo: NF-e + NFS-e completos, igual ao emissor atual, pros CNAEs da empresa.
- Focus NFe: André autoriza abrir o cadastro; aciono ele antes de qualquer pagamento.

## Dados fiscais confirmados (resolvem as perguntas do builder check)

- **Regime tributário**: Simples Nacional (confirmado por André) — código clonado (CSOSN 102,
  sem ramificação de Regime Normal) se aplica sem mudança.
- **Inscrição Estadual**: 15667176 (Situação: Habilitada)
- **Inscrição Municipal (CCM)**: 1592647-3
- **NIRE**: 33.2.1414085-4
- **Sócio Administrador / responsável legal**: Carlos Alberto de Lira — CPF 357.934.848-50,
  RG 08857979841 (DETRAN/SP)
- **Conta bancária/Pix** (pra config de recebimento, se o clone usar): Banco DOCK IP S.A. (301),
  agência 0001, conta corrente 31182713, chave Pix = o próprio CNPJ
- **Escopo de NFS-e**: "os serviços que pudermos pelos CNAEs da empresa, basicamente os mesmos
  da RJ Tecnologia" — reusa a tabela cTribNac/cTribMun/cNBS existente pra suporte técnico
  (9511800/9512600/6209100, testada em produção na RJ); os demais CNAEs de serviço (consultoria,
  hospedagem, portal, treinamento) ficam sem código de serviço mapeado — emitir só quando/se
  a Hardware Express realmente faturar esse serviço, pesquisando o código daquela vez.
- **Vendas fora do RJ**: não, só dentro do estado por enquanto — CFOP 5102 do código clonado
  cobre, não precisa de DIFAL/partilha interestadual agora.
- **ICMS-ST**: catálogo de produtos (abaixo) não foi auditado NCM a NCM contra o protocolo de
  ST do RJ — risco residual herdado do próprio clone da RJ (mesmo CSOSN 102 uniforme). Verificar
  na prática nas primeiras notas de homologação; não é motivo pra atrasar o clone.

## Catálogo de produtos

`F:\Hardware Express\Produtos Hardware Express.xlsx` — 168 produtos (aba `results-20250829-092549`,
`A1:E169`), colunas Codigo/Descricao/NCM/Valor/Peso. Pronto pra importar (equivalente ao
`importar-produtos-rj.js`, mas com catálogo próprio da Hardware Express).

## Achado crítico durante a implementação (18/11/2026) — decisão registrada

Lendo `emissor-server.cjs` pra clonar, achei que o endpoint `/api/data/:chave` (e os proxies
`/email/*`, `/sefaz/*`, além de `/focus/*` e `/nfse/*`) **nunca checavam autenticação nenhuma** —
a tela de login do SPA é inteiramente client-side (compara hash contra `localStorage`); o
servidor aceita qualquer leitura/gravação de qualquer pedido, de qualquer origem, sem senha nem
token. Isso expõe publicamente (via Cloudflare Tunnel, sem Access/Zero Trust na frente) o
certificado digital + senha, os tokens da Focus NFe, a lista de usuários (com hash de senha) e
clientes/notas (CPF/CNPJ) de quem já usa esse sistema hoje — **inclusive a RJ, em produção**.

Decisão do André: corrigir SÓ no clone novo agora; a correção equivalente na RJ fica pra outra
sessão, separada, pra não misturar commits/repos/documentação.

**Implementado no clone**: sessão real no servidor (token opaco em memória, 24h,
`Authorization: Bearer`), emitida só depois de login/setup/convite verificados no servidor
(lendo o próprio `techstore-usuarios.json`, não mais um gate cosmético no cliente); toda rota
sensível exige esse token; trava de força bruta (5 erros = 15min bloqueado, por e-mail); salt do
hash de senha trocado de `rjlogistica-salt-2026` pra `hwexpress-salt-2026` (nunca reusar o salt
da RJ). UX de login/setup/convite no SPA ficou idêntica — só a ordem de rede mudou (sincroniza
dado só depois de autenticado, não antes).

**Bônus achado no mesmo mergulho**: a tabela CNAE→cTribNac/cTribMun/cNBS em `nfse-nacional.cjs`
tinha fallback silencioso pra um código "chutado" quando o CNAE não estava mapeado — trocado pra
lançar erro explícito (ver `nfse-nacional.test.js`). Resolve a pergunta #3 do builder check sem
precisar pesquisar os códigos de LC116 dos CNAEs secundários agora.

**Verificado** (curl + browser real, não só leitura de código): setup cria usuário; GET
`/api/data/techstore-usuarios` sem token → 401; com token → 200; senha errada → erro genérico;
5 erros → 429; UI mostra branding Hardware Express Online; página Usuários renderiza certo.
Suite Jest: 49/49 (`utils.test.js`, `danfse.test.js`, `nfse-nacional.test.js` novo).

## Revisão do fix de auth (code-reviewer, 18/11/2026) — tudo corrigido e reverificado

- 🔴 CRÍTICO: `/data/*` era servido como arquivo estático, por baixo do gate inteiro (`GET
  /data/techstore-cert.json` devolvia certificado+senha sem token nenhum). Corrigido: bloqueia
  `/data` e `/data/*` incondicionalmente, pra qualquer um, antes até da checagem de rota protegida.
- 🟠 ALTO: sessão válida de qualquer perfil liberava `techstore-usuarios` (hash de senha de
  todo mundo). Corrigido: GET/POST de `techstore-usuarios` e POST de `techstore-cert` agora
  exigem `perfil === 'admin'`. GET de `techstore-cert` ficou aberto pra qualquer sessão de
  propósito — o fluxo "emitir via SEFAZ local" manda o certificado a partir do navegador do
  próprio operador (`_getCertParaSefaz()`), restringir quebraria isso pra quem não é admin.
- 🟡 MÉDIO: comparação de hash de senha não era tempo constante (`crypto.timingSafeEqual` agora).
- 🟡 MÉDIO: `authCriarAdmin`/`registrarConvidado` sem try/catch — erro de rede travava a tela
  sem mensagem. Corrigido, igual `authLogin`.
- 🟡 MÉDIO: logout não limpava `_DB_KEYS` do localStorage (certificado+senha, hashes, ficavam
  no navegador depois de sair). Corrigido.
- 🔵 BAIXO: `/api/auth/setup` tinha race check-then-act entre duas chamadas concorrentes.
  Travado com lock em memória (só importa no primeiro setup).

Reverificado ao vivo com usuário admin + operador reais: operador não lê `techstore-usuarios`
nem escreve `techstore-cert` (401 nos dois), admin lê normal, `/data/*` bloqueado pra todo mundo.
49/49 testes Jest continuam passando.

## Focus NFe — status (18/11/2026)

- Conta já existe (mesmo login/e-mail usado pela RJ) — empresa emissora "HARDWARE AUTOMACAO E
  TECNOLOGIA LTDA" criada no painel (id 290807), sem custo adicional cobrado ainda.
- NF-e habilitada (homologação + produção, série 1, número inicial 1). NFSe NÃO habilitada no
  Focus (a NFSe Nacional do clone fala direto com a SEFIN, não usa Focus).
- Certificado digital anexado e válido até 08/09/2027 (o primeiro arquivo enviado estava
  vencido; o correto ficou em `F:\Hardware Express\Certificado Digital\Até 08092027\`).
- Tokens de homologação e produção gerados — guardar junto da config da empresa quando o clone
  for montado (não repetir em texto solto).

## O que fica a cargo de quem constrói

- Local do projeto: `F:\RichClub\emissor-hardware-express`, repo Git próprio e privado
  (ex.: `andreprol/emissor-hardware-express`).
- Portas locais novas e 3 serviços NSSM próprios, seguindo o padrão 3001-3003 da RJ (ex.:
  3011-3013), nomes próprios (`EmissorNotasHW`, `SefazServerHW`, ...).
- Nova entrada de ingress no túnel Cloudflare existente + registro CNAME em
  `emissor.hardwareexpressonline.com` no painel da HostGator apontando pro túnel.
- Trocar toda referência de marca "RJ"/"RJ Logística e Tecnologia"/"RJ Tecnologia" por
  "Hardware Express" + novo SVG de logo "HW" no mesmo estilo visual do original.
- Hash de senha (bcrypt) pro admin e usuários, no lugar de texto plano — sem mudar o fluxo
  de login visível.
- Config inicial da empresa com os dados do Cartão CNPJ acima.
- Import do certificado `.pfx` pela própria tela do sistema, assim que estiver no ar.
- Cadastro da conta Focus NFe nova (ação separada, não é código) — plano que cubra NF-e e NFS-e.
