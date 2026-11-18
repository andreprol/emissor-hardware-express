/**
 * Emissor de Notas — Servidor Principal
 * Porta: 3003
 * - Serve o index.html e arquivos estáticos
 * - Proxy reverso para email-server (3001) e sefaz-server (3002)
 * - Exposto publicamente via Cloudflare Tunnel — por isso toda rota que
 *   toca dado de verdade exige sessão (ver bloco "Autenticação" abaixo)
 */

'use strict';
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

// ── NFSe Nacional (SEFIN) — RJ usa sistema federal desde 01/01/2026 ────────────
const nfseNacional = require('./nfse-nacional.cjs');

// ── Focus NFe ─────────────────────────────────────────────────────────────────
const { FORMA_PAG, CNAE_CTN, montarPayloadFocus, montarPayloadNfse } = require('./utils.cjs');

const FOCUS_HOM  = 'homologacao.focusnfe.com.br';
const FOCUS_PROD = 'api.focusnfe.com.br';

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

function focusRequest({ host, path: fPath, method, token, body }) {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(token + ':').toString('base64');
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: host, port: 443, path: fPath, method: method || 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout Focus NFe')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}


const STATUS_PENDENTES = ['processando', 'processando_autorizacao', 'recebido', 'em_processamento'];

async function aguardarAutorizacaoFocus(host, ref, token, tentativas = 20) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const { status, body } = await focusRequest({ host, path: `/v2/nfe/${ref}`, method: 'GET', token, body: null });
    if (status === 200 && !STATUS_PENDENTES.includes(body.status)) return { status, body };
  }
  return { status: 408, body: { status: 'timeout', mensagem: 'Tempo esgotado aguardando SEFAZ.' } };
}

// ── NFS-e ─────────────────────────────────────────────────────────────────────
const STATUS_PENDENTES_NFSE = ['processando', 'recebido', 'em_processamento', 'processando_autorizacao'];


async function aguardarAutorizacaoNfse(host, ref, token, tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    await new Promise(r => setTimeout(r, 30000));
    // Rio de Janeiro usa NFSe Nacional → endpoint /v2/nfsen
    const { status, body } = await focusRequest({ host, path: `/v2/nfsen/${ref}`, method: 'GET', token, body: null });
    console.log(`[NFS-e poll ${i+1}/${tentativas}] status HTTP: ${status}, status nota: ${body?.status}`);
    if (status === 200 && !STATUS_PENDENTES_NFSE.includes(body.status)) return { status, body };
    if (status === 404) return { status, body };
  }
  return { status: 408, body: { status: 'timeout', mensagem: 'Tempo esgotado aguardando prefeitura.' } };
}

async function handleFocusNfseEmitir(req, res) {
  try {
    const body = await lerCorpo(req);
    const { token, dados, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token Focus NFe não informado.' })); return; }

    const amb  = (config.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;

    // Lê CNPJ e inscrição municipal direto do config salvo no servidor
    let configEmpresa = {};
    try { configEmpresa = JSON.parse(dbRead('techstore-config') || '{}'); } catch(_) {}
    const configCompleto = {
      ...config,
      cnpj:               (configEmpresa['cfg-cnpj']          || config.cnpj || '').replace(/\D/g,''),
      inscricaoMunicipal: (configEmpresa['cfg-im']             || config.inscricaoMunicipal || '16269891').replace(/\D/g,''),
      razaoSocial:         configEmpresa['cfg-razao-social']   || config.razaoSocial || 'RIO DE JANEIRO LOGISTICA E TECNOLOGIA LTDA',
      cep:                (configEmpresa['cfg-cep']            || '23042530').replace(/\D/g,''),
      logradouro:          configEmpresa['cfg-logradouro']     || 'Rua Manuel Beckmann',
      numero:              configEmpresa['cfg-numero']         || '834',
      complemento:         configEmpresa['cfg-complemento']   || '',
      bairro:              configEmpresa['cfg-bairro']         || 'Campo Grande',
    };

    const { payload, ref } = montarPayloadNfse(dados, configCompleto);

    console.log('[NFS-e payload] cnpj:', payload.cnpj_prestador, 'inscMun:', payload.inscricao_municipal_prestador);
    // Rio de Janeiro usa NFSe Nacional → endpoint /v2/nfsen
    const envio = await focusRequest({ host, path: `/v2/nfsen?ref=${ref}`, method: 'POST', token, body: payload });
    console.log('[NFS-e envio] status:', envio.status, 'body:', JSON.stringify(envio.body).slice(0, 300));

    if (![200, 201, 202].includes(envio.status)) {
      let erros = '—';
      try {
        erros = (envio.body?.erros || []).map(e => e.mensagem).join('; ') || String(envio.body);
      } catch(_) { erros = String(envio.body); }
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:false, erro:`Focus NFe rejeitou (${envio.status}): ${erros}`, detalhe: String(envio.body) }));
      return;
    }

    // Retorna imediatamente com status "aguardando" — prefeitura processa de forma assíncrona
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: true, status: 'aguardando', ref, ambiente: amb }));
  } catch (err) {
    console.error('[NFS-e erro]', err.message);
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:false, erro: err.message }));
  }
}

async function handleFocusNfseCancelar(req, res) {
  try {
    const body = await lerCorpo(req);
    const { token, ref, justificativa, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token não informado.' })); return; }
    if (!ref)   { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Referência (ref) não informada.' })); return; }

    const amb  = (config?.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;

    const result = await focusRequest({
      host,
      path: `/v2/nfsen/${ref}`,
      method: 'DELETE',
      token,
      body: { justificativa: justificativa || 'Cancelamento solicitado pelo emitente.' },
    });

    if ([200, 201, 202].includes(result.status)) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, status: result.body?.status, msg: 'Cancelamento solicitado com sucesso.', detalhe: result.body }));
    } else {
      const erros = result.body?.erros?.map(e => e.mensagem).join('; ') || JSON.stringify(result.body);
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, erro: `Focus NFe: ${erros}`, detalhe: result.body }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

async function handleFocusNfseConsultar(req, res, ref, token, config) {
  try {
    const amb  = (config?.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;
    const result = await focusRequest({ host, path: `/v2/nfsen/${ref}`, method: 'GET', token, body: null });
    console.log(`[NFS-e consulta] ref: ${ref} → status HTTP: ${result.status}, status nota: ${result.body?.status}, erros: ${JSON.stringify(result.body?.erros || result.body?.mensagem_sefaz || result.body?.mensagem || '').slice(0,400)}`);
    res.writeHead(result.status === 200 ? 200 : 404, {'Content-Type':'application/json'});
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

async function handleFocusEmitir(req, res) {
  try {
    const body   = await lerCorpo(req);
    const { token, dados, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token Focus NFe não informado.' })); return; }

    const amb  = (config.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;
    const { payload, ref } = montarPayloadFocus(dados, config);

    const envio = await focusRequest({ host, path: `/v2/nfe?ref=${ref}`, method: 'POST', token, body: payload });
    if (![200, 201, 202].includes(envio.status)) {
      const erros = envio.body?.erros?.map(e => e.mensagem).join('; ') || JSON.stringify(envio.body);
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:false, erro:`Focus NFe rejeitou: ${erros}`, detalhe: envio.body }));
      return;
    }

    const resultado = await aguardarAutorizacaoFocus(host, ref, token);
    const nfe = resultado.body;

    if (nfe.status === 'autorizado') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, status:nfe.status, chave:nfe.chave_nfe, nProt:nfe.numero_protocolo, serie:nfe.serie, numero:nfe.numero, danfe_url:nfe.caminho_danfe_etiqueta||nfe.caminho_danfe, xml_url:nfe.caminho_xml_nota_fiscal, ref }));
    } else {
      res.writeHead(422, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:false, erro: nfe.mensagem_sefaz || nfe.mensagem || nfe.status, status: nfe.status, detalhe: nfe }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok:false, erro: err.message }));
  }
}

async function handleFocusCancelar(req, res) {
  try {
    const body = await lerCorpo(req);
    const { token, ref, justificativa, config } = body;
    if (!token) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Token não informado.' })); return; }
    if (!ref)   { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'Referência (ref) não informada.' })); return; }

    const amb  = (config?.ambiente || '').includes('Produção') ? 'producao' : 'homologacao';
    const host = amb === 'producao' ? FOCUS_PROD : FOCUS_HOM;

    const result = await focusRequest({
      host,
      path: `/v2/nfe/${ref}`,
      method: 'DELETE',
      token,
      body: { justificativa: justificativa || 'Cancelamento solicitado pelo emitente.' },
    });

    if ([200, 201, 202].includes(result.status)) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, status: result.body?.status, msg: 'Cancelamento solicitado com sucesso.', detalhe: result.body }));
    } else {
      const erros = result.body?.erros?.map(e => e.mensagem).join('; ') || JSON.stringify(result.body);
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: false, erro: `Focus NFe: ${erros}`, detalhe: result.body }));
    }
  } catch (err) {
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

const PORTA = Number(process.env.PORTA) || 3003;
const DIR   = __dirname;

// ── Armazenamento de dados no servidor ───────────────────────────────────────
const DATA_DIR = path.join(DIR, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const DB_KEYS = new Set([
  'techstore-config', 'techstore-produtos', 'techstore-clientes',
  'techstore-notas-emitidas', 'techstore-nfse-emitidas', 'techstore-usuarios', 'techstore-convites',
  'techstore-cert', 'techstore-nfe-ultNSU',
]);

// Ter sessão válida não basta pra tudo (achado do code-reviewer, 18/11/2026):
// - ninguém além de admin tem motivo pra LER hash de senha de todo mundo.
// - trocar o certificado A1 é ação de Configurações, que já é admin-only na UI
//   — mas LER o certificado (base64+senha) continua liberado pra qualquer
//   sessão autenticada porque o fluxo "emitir via SEFAZ local" (ver
//   _getCertParaSefaz() no index.html) manda o certificado a partir do
//   navegador do próprio operador, não só do admin — restringir a leitura
//   quebraria esse caminho pra quem não é admin.
const CHAVES_LEITURA_SO_ADMIN = new Set(['techstore-usuarios']);
const CHAVES_ESCRITA_SO_ADMIN = new Set(['techstore-usuarios', 'techstore-cert']);

function dbRead(key) {
  const file = path.join(DATA_DIR, key + '.json');
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function dbWrite(key, body) {
  fs.writeFileSync(path.join(DATA_DIR, key + '.json'), body, 'utf8');
}

// ── Autenticação ──────────────────────────────────────────────────────────────
// A tela de login é cosmética (JS no navegador); quem de fato decide se um
// pedido pode ler/gravar dado é este bloco. Sessão = token opaco em memória,
// mandado pelo navegador no header Authorization — nunca em cookie (sem
// cookie não existe CSRF pra isso, não precisa de SameSite/CSRF token).
const SESSIONS = new Map(); // token -> { userId, nome, email, perfil, expira }
const SESSAO_DURACAO_MS = 24 * 60 * 60 * 1000; // 24h — mesmo prazo que o app já assumia no cliente

function lerUsuarios()   { try { return JSON.parse(dbRead('techstore-usuarios') || '[]'); } catch { return []; } }
function salvarUsuarios(u) { dbWrite('techstore-usuarios', JSON.stringify(u)); }
function lerConvites()   { try { return JSON.parse(dbRead('techstore-convites') || '[]'); } catch { return []; } }
function salvarConvites(c) { dbWrite('techstore-convites', JSON.stringify(c)); }

function criarSessao(user) {
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, {
    userId: user.id, nome: user.nome, email: user.email, perfil: user.perfil,
    expira: Date.now() + SESSAO_DURACAO_MS,
  });
  return token;
}

function requireAuth(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  if (!m) return null;
  const sess = SESSIONS.get(m[1].trim());
  if (!sess) return null;
  if (Date.now() > sess.expira) { SESSIONS.delete(m[1].trim()); return null; }
  return sess;
}

// Comparação de tempo constante — o hash de senha é, na prática, a credencial
// (quem souber o hash loga sem saber a senha de verdade). === normal vaza
// quanto da string bate por timing; isso não (achado do code-reviewer, 18/11/2026).
function hashesIguais(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

function negarAcesso(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, erro: 'Sessão inválida ou expirada. Faça login novamente.' }));
}

// Trava simples contra força bruta: 5 tentativas erradas → 15min de bloqueio pro e-mail
const TENTATIVAS_LOGIN = new Map(); // email -> { tentativas, bloqueadoAte }
function loginBloqueado(email) {
  const r = TENTATIVAS_LOGIN.get(email);
  return !!(r && r.bloqueadoAte && Date.now() < r.bloqueadoAte);
}
function registrarFalhaLogin(email) {
  const r = TENTATIVAS_LOGIN.get(email) || { tentativas: 0, bloqueadoAte: 0 };
  r.tentativas++;
  if (r.tentativas >= 5) { r.bloqueadoAte = Date.now() + 15 * 60 * 1000; r.tentativas = 0; }
  TENTATIVAS_LOGIN.set(email, r);
}
function limparFalhasLogin(email) { TENTATIVAS_LOGIN.delete(email); }

async function handleAuthStatus(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, hasUsers: lerUsuarios().length > 0 }));
}

async function handleAuthMe(req, res) {
  const sess = requireAuth(req);
  if (!sess) return negarAcesso(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, user: { id: sess.userId, nome: sess.nome, email: sess.email, perfil: sess.perfil } }));
}

let _setupEmAndamento = false; // trava check-then-act: 2 POSTs /api/auth/setup concorrentes
                                 // não podem os dois passar do "ainda não existe admin" (achado
                                 // do code-reviewer, 18/11/2026)

async function handleAuthSetup(req, res) {
  if (_setupEmAndamento) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Configuração já em andamento, tente novamente em instantes.' }));
    return;
  }
  _setupEmAndamento = true;
  try {
    const { nome, email, senha_hash } = await lerCorpo(req);
    if (!nome || !email || !senha_hash) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Preencha todos os campos.' }));
      return;
    }
    if (lerUsuarios().length > 0) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Já existe uma conta configurada. Faça login.' }));
      return;
    }
    const user = {
      id: crypto.randomUUID(), nome, email: String(email).toLowerCase(), senha_hash,
      perfil: 'admin', ativo: true, criado_em: new Date().toLocaleDateString('pt-BR'),
    };
    salvarUsuarios([user]);
    const token = criarSessao(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token, user: { id: user.id, nome: user.nome, email: user.email, perfil: user.perfil } }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  } finally {
    _setupEmAndamento = false;
  }
}

async function handleAuthLogin(req, res) {
  try {
    const body = await lerCorpo(req);
    const email = String(body.email || '').trim().toLowerCase();
    const senha_hash = body.senha_hash;
    if (!email || !senha_hash) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Preencha e-mail e senha.' }));
      return;
    }
    if (loginBloqueado(email)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' }));
      return;
    }
    const user = lerUsuarios().find(u => u.email.toLowerCase() === email && hashesIguais(u.senha_hash, senha_hash) && u.ativo !== false);
    if (!user) {
      registrarFalhaLogin(email);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'E-mail ou senha incorretos.' }));
      return;
    }
    limparFalhasLogin(email);
    const token = criarSessao(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token, user: { id: user.id, nome: user.nome, email: user.email, perfil: user.perfil } }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

function handleAuthLogout(req, res) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  if (m) SESSIONS.delete(m[1].trim());
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handleAuthValidateInvite(req, res) {
  try {
    const { token } = await lerCorpo(req);
    const convite = lerConvites().find(c => c.token === token);
    if (!convite) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Convite inválido ou expirado.' }));
      return;
    }
    if (Date.now() > convite.expira) {
      salvarConvites(lerConvites().filter(c => c.token !== token));
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Este convite expirou.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, email: convite.email, perfil: convite.perfil }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

async function handleAuthAcceptInvite(req, res) {
  try {
    const { token, nome, senha_hash } = await lerCorpo(req);
    const convites = lerConvites();
    const convite = convites.find(c => c.token === token);
    if (!convite) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Convite inválido ou expirado.' }));
      return;
    }
    if (Date.now() > convite.expira) {
      salvarConvites(convites.filter(c => c.token !== token));
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Este convite expirou.' }));
      return;
    }
    if (!nome || !senha_hash) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Preencha todos os campos.' }));
      return;
    }
    const user = {
      id: crypto.randomUUID(), nome, email: convite.email, senha_hash,
      perfil: convite.perfil, ativo: true, criado_em: new Date().toLocaleDateString('pt-BR'),
    };
    salvarUsuarios([...lerUsuarios(), user]);
    salvarConvites(convites.filter(c => c.token !== token));
    const sessToken = criarSessao(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token: sessToken, user: { id: user.id, nome: user.nome, email: user.email, perfil: user.perfil } }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: err.message }));
  }
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Proxy reverso para serviços locais ────────────────────────────────────────
function proxyRequest(req, res, targetPort, targetPath) {
  const opts = {
    hostname: '127.0.0.1',
    port:     targetPort,
    path:     targetPath,
    method:   req.method,
    headers:  { ...req.headers, host: `127.0.0.1:${targetPort}` },
  };

  const proxyReq = http.request(opts, proxyRes => {
    // CORS para acesso remoto
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    const servico = targetPort === 3001 ? 'Email Server' : 'SEFAZ Server';
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      erro: `${servico} não está rodando (porta ${targetPort}). Contate o administrador.`,
    }));
  });

  req.pipe(proxyReq);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── Pasta de dados nunca é servida como arquivo estático, pra ninguém, mesmo
  //    autenticado — tudo que é dado de verdade passa por /api/data/:chave, que
  //    tem seu próprio controle de acesso. Sem isso, GET /data/techstore-cert.json
  //    devolveria o certificado em claro direto pelo serviço de arquivos estáticos,
  //    por baixo do gate (achado do code-reviewer, 18/11/2026).
  if (pathname === '/data' || pathname.startsWith('/data/')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Acesso direto à pasta de dados não é permitido.' }));
    return;
  }

  // ── Autenticação (sem exigir sessão — é aqui que ela nasce) ──
  if (req.method === 'GET'  && pathname === '/api/auth/status')          return handleAuthStatus(req, res);
  if (req.method === 'GET'  && pathname === '/api/auth/me')              return handleAuthMe(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/setup')           return handleAuthSetup(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/login')          return handleAuthLogin(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/logout')         return handleAuthLogout(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/validate-invite') return handleAuthValidateInvite(req, res);
  if (req.method === 'POST' && pathname === '/api/auth/accept-invite')   return handleAuthAcceptInvite(req, res);

  // ── Tudo que lê/grava dado de verdade (empresa, certificado, notas, clientes,
  //    usuários, proxies pra Focus NFe/SEFAZ/e-mail/NFSe) exige sessão válida.
  //    /focus/ping fica fora: não devolve nem aceita dado nenhum.
  const rotaProtegida = pathname.startsWith('/email/') || pathname.startsWith('/sefaz/') ||
    pathname.startsWith('/api/data/') || pathname.startsWith('/nfse/') ||
    (pathname.startsWith('/focus/') && pathname !== '/focus/ping');
  if (rotaProtegida && !requireAuth(req)) return negarAcesso(res);

  // ── Proxy: /email/* → porta 3001 ──
  if (pathname.startsWith('/email/')) {
    const target = pathname.replace('/email', '');
    return proxyRequest(req, res, 3001, target + (parsed.search || ''));
  }

  // ── Proxy: /sefaz/* → porta 3002 ──
  if (pathname.startsWith('/sefaz/')) {
    const target = pathname.replace('/sefaz', '');
    return proxyRequest(req, res, 3002, target + (parsed.search || ''));
  }

  // ── API de dados: GET /api/data/:key ──
  if (req.method === 'GET' && pathname.startsWith('/api/data/')) {
    const key = pathname.slice('/api/data/'.length);
    if (!DB_KEYS.has(key)) { res.writeHead(404, {'Content-Type':'application/json'}); res.end('null'); return; }
    if (CHAVES_LEITURA_SO_ADMIN.has(key) && requireAuth(req)?.perfil !== 'admin') return negarAcesso(res);
    const data = dbRead(key);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(data !== null ? data : 'null');
    return;
  }

  // ── API de dados: POST /api/data/:key ──
  if (req.method === 'POST' && pathname.startsWith('/api/data/')) {
    const key = pathname.slice('/api/data/'.length);
    if (!DB_KEYS.has(key)) { res.writeHead(403, {'Content-Type':'application/json'}); res.end('{"ok":false}'); return; }
    if (CHAVES_ESCRITA_SO_ADMIN.has(key) && requireAuth(req)?.perfil !== 'admin') return negarAcesso(res);
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        JSON.parse(body); // valida JSON antes de salvar
        dbWrite(key, body);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":true}');
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end('{"ok":false,"erro":"JSON inválido"}');
      }
    });
    return;
  }

  // ── Proxy download Focus NFe: /focus/download?url=...&token=... ──
  if (req.method === 'GET' && pathname === '/focus/download') {
    try {
      const qs      = new URLSearchParams(parsed.query || '');
      const fileUrl = qs.get('url');
      const token   = qs.get('token') || '';
if (!fileUrl) { res.writeHead(400); res.end('url obrigatória'); return; }
      const target  = new URL(fileUrl);
      const auth    = Buffer.from(token + ':').toString('base64');
      const reqOpts = {
        hostname: target.hostname, port: 443,
        path: target.pathname + (target.search || ''),
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}` },
      };
      const proxyR = https.request(reqOpts, proxyRes => {
        const ct = proxyRes.headers['content-type'] || 'application/octet-stream';
        res.writeHead(proxyRes.statusCode, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
        proxyRes.pipe(res);
      });
      proxyR.on('error', e => { res.writeHead(502); res.end(e.message); });
      proxyR.end();
    } catch(e) {
      console.error('[download] erro:', e.message);
      res.writeHead(400); res.end('Erro: ' + e.message);
    }
    return;
  }

  // ── Focus NFe: /focus/nfe/emitir ──
  if (req.method === 'POST' && pathname === '/focus/nfe/emitir') {
    return handleFocusEmitir(req, res);
  }

  // ── Focus NFe: /focus/nfe/cancelar ──
  if (req.method === 'POST' && pathname === '/focus/nfe/cancelar') {
    return handleFocusCancelar(req, res);
  }

  // ── Focus NFS-e: /focus/nfse/emitir ──
  if (req.method === 'POST' && pathname === '/focus/nfse/emitir') {
    return handleFocusNfseEmitir(req, res);
  }

  // ── Focus NFS-e: /focus/nfse/cancelar ──
  if (req.method === 'POST' && pathname === '/focus/nfse/cancelar') {
    return handleFocusNfseCancelar(req, res);
  }

  // ── Focus NFS-e: /focus/nfse/consultar?ref=...&token=...&ambiente=... ──
  if (req.method === 'GET' && pathname === '/focus/nfse/consultar') {
    const qs     = new URLSearchParams(parsed.query || '');
    const ref    = qs.get('ref');
    const token  = qs.get('token') || '';
    const config = { ambiente: qs.get('ambiente') || '' };
    if (!ref) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, erro:'ref obrigatório' })); return; }
    return handleFocusNfseConsultar(req, res, ref, token, config);
  }

  // ── NFSe Nacional: /nfse/emitir ──────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/nfse/emitir') {
    return nfseNacional.handleEmitir(req, res);
  }

  // ── NFSe Nacional: /nfse/consultar?chaveAcesso=...&ambiente=... ──────────────
  if (req.method === 'GET' && pathname === '/nfse/consultar') {
    return nfseNacional.handleConsultar(req, res, parsed);
  }

  // ── NFSe Nacional: /nfse/cancelar ────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/nfse/cancelar') {
    return nfseNacional.handleCancelar(req, res);
  }

  // ── NFSe Nacional: /nfse/xml?chaveAcesso=...&ambiente=... (download do XML) ──
  if (req.method === 'GET' && pathname === '/nfse/xml') {
    return nfseNacional.handleBaixarXml(req, res, parsed);
  }

  // ── NFSe Nacional: /nfse/pdf?chaveAcesso=...&ambiente=... (DANFSe próprio) ──
  if (req.method === 'GET' && pathname === '/nfse/pdf') {
    return nfseNacional.handleBaixarPdf(req, res, parsed);
  }

  // ── Ping Focus NFe ──
  if (pathname === '/focus/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'Focus NFe pronto.' }));
    return;
  }

  // ── Arquivos estáticos ──
  let filePath = path.join(DIR, pathname === '/' ? 'index.html' : pathname);

  // Segurança: não permite sair da pasta
  if (!filePath.startsWith(DIR)) {
    res.writeHead(403);
    res.end('Proibido');
    return;
  }

  // Se o arquivo não existe, serve index.html (SPA fallback)
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIR, 'index.html');
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Arquivo não encontrado: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type':  mimeType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORTA, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Emissor de Notas — Servidor Principal      ║');
  console.log(`║   Porta: ${PORTA}  — Acesso local e remoto       ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Local:   http://localhost:${PORTA}`);
  console.log(`  Rede:    http://0.0.0.0:${PORTA}`);
  console.log('');
  console.log('  Rotas proxy:');
  console.log('    /email/*  → porta 3001 (Email Server)');
  console.log('    /sefaz/*  → porta 3002 (SEFAZ Server)');
  console.log('');
  console.log('Pressione Ctrl+C para encerrar.');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORTA} já está em uso.\n`);
  } else {
    console.error('\n❌ Erro:', err.message);
  }
  process.exit(1);
});
